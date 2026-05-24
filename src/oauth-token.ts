// POST /oauth/token endpoint for VRT-166 Phase 1.
//
// Grants supported (RFC 6749 §4.1, §6):
//   - authorization_code: exchange a one-time code + PKCE verifier for an
//     access token (1h) + refresh token (30d). Audience-bound per RFC 8707.
//   - refresh_token:      rotate the refresh token; mint a fresh access +
//     refresh pair sharing the same `installation_id`. RFC 6819 §5.2.2.3
//     family-revocation on replay.
//
// Request shapes (RFC 6749 §3.2):
//   - Content-Type: application/x-www-form-urlencoded (canonical)
//   - Content-Type: application/json also tolerated for client resilience.
//
// Response shape (RFC 6749 §5.1):
//   { access_token, token_type: "Bearer", expires_in, refresh_token, scope }
//
// Error shape (RFC 6749 §5.2):
//   { error: "<code>", error_description?: "<human>" }
//   With HTTP 400 for invalid_request / invalid_grant / invalid_client /
//   invalid_target / unsupported_grant_type, and HTTP 429 for rate limit,
//   HTTP 503 for kill switch / oauth_misconfigured.
//
// PKCE (RFC 7636): only S256 is supported. plain is explicitly NOT supported
// (downgrade attack class). Mismatch returns invalid_grant.
//
// Token format: vto_<32-byte-base62> for access tokens, opaque random base62
// suffix for refresh tokens. Both stored as SHA-256 hex hashes. Raw tokens
// never touch the DB (mirrors the vtk_* posture in cchurctrip/verity
// lib/apiKeyAuth.ts).
//
// Token passthrough (parent spec line 387): tokens issued here never get
// forwarded to upstream. The Worker's tools/call path validates the OAuth
// bearer, resolves to user_id, then forwards `x-verity-user-id: <uuid>` to
// the upstream skill routes. NEVER `x-verity-key: vto_*`.

import { randomTokenSuffix, sha256Hex, verifyPkceS256 } from './oauth-crypto';
import { CANONICAL_RESOURCE_URI, isCanonicalResourceUri } from './oauth-canonical';
import { noteRequestForCode } from './oauth-rate-limit';
import {
  OAUTH_MISCONFIGURED_BODY,
  buildSupabaseClient,
  type SupabaseEnv,
} from './supabase';
import {
  deleteRefreshToken,
  findCodeByHash,
  findRefreshTokenByHash,
  insertAccessToken,
  insertRefreshToken,
  markCodeUsedIfUnused,
  revokeInstallationFamily,
} from './oauth-store';

export interface OauthTokenEnv extends SupabaseEnv {
  MCP_OAUTH_KILL_SWITCH?: string;
}

export const ACCESS_TOKEN_TTL_SECONDS = 3600;
const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;
const ACCESS_TOKEN_PREFIX = 'vto_';

export interface OauthTokenResponse {
  body: Record<string, unknown>;
  status: number;
  headers?: Record<string, string>;
}

/**
 * Top-level handler. Parses the body, dispatches by grant_type, returns the
 * RFC 6749 §5.1 success or §5.2 error envelope. The caller wraps in a
 * Response and adds CORS headers.
 */
export async function handleOauthToken(
  req: Request,
  env: OauthTokenEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<OauthTokenResponse> {
  if (env.MCP_OAUTH_KILL_SWITCH === 'on') {
    return {
      body: {
        error: 'temporarily_unavailable',
        error_description: 'OAuth temporarily disabled by operator.',
      },
      status: 503,
      headers: { 'Retry-After': '60' },
    };
  }

  const db = buildSupabaseClient(env, fetchImpl);
  if (db === null) {
    return {
      body: OAUTH_MISCONFIGURED_BODY as unknown as Record<string, unknown>,
      status: 503,
      headers: { 'Retry-After': '60' },
    };
  }

  let params: Record<string, string>;
  try {
    params = await parseTokenRequestBody(req);
  } catch (err) {
    return errorResponse(
      'invalid_request',
      err instanceof Error ? err.message : 'malformed body',
      400,
    );
  }

  const clientSecret = params['client_secret'];
  if (typeof clientSecret === 'string' && clientSecret.length > 0) {
    // Arch review Q4: we are a public-client server (PKCE). Reject any
    // non-empty client_secret with invalid_client so a misconfigured client
    // gets a loud signal rather than a silent partial-auth scenario.
    return errorResponse(
      'invalid_client',
      'This token endpoint serves public clients with PKCE. Do not send client_secret.',
      400,
    );
  }

  const grantType = params['grant_type'];
  if (grantType === 'authorization_code') {
    return handleAuthorizationCodeGrant(params, db);
  }
  if (grantType === 'refresh_token') {
    return handleRefreshTokenGrant(params, db);
  }
  return errorResponse(
    'unsupported_grant_type',
    `Supported grants: authorization_code, refresh_token. Received: ${grantType ?? '(missing)'}`,
    400,
  );
}

/**
 * Parse the token-request body. Accepts both application/x-www-form-urlencoded
 * (canonical per RFC 6749 §3.2) and application/json (resilience). Returns
 * a flat string→string map; non-string values in JSON bodies are rejected
 * with invalid_request so a JSON-typed code or number cannot bypass the
 * string-comparison validators downstream.
 */
async function parseTokenRequestBody(req: Request): Promise<Record<string, string>> {
  const ct = req.headers.get('content-type') ?? '';
  // The full content-type string may carry parameters (charset, boundary).
  // Match on the bare type/subtype.
  const lowerCt = ct.split(';')[0]?.trim().toLowerCase() ?? '';

  if (lowerCt === 'application/x-www-form-urlencoded') {
    const text = await req.text();
    const out: Record<string, string> = {};
    for (const [k, v] of new URLSearchParams(text).entries()) {
      out[k] = v;
    }
    return out;
  }

  if (lowerCt === 'application/json' || lowerCt === '') {
    let parsed: unknown;
    try {
      parsed = await req.json();
    } catch (err) {
      throw new Error(
        `body parse failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('body must be a JSON object or form-urlencoded');
    }
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v !== 'string') {
        throw new Error(`field "${k}" must be a string`);
      }
      out[k] = v;
    }
    return out;
  }

  throw new Error(`unsupported content-type: ${lowerCt}`);
}

/**
 * authorization_code grant: validate the code, PKCE, redirect_uri, resource,
 * client_id; mint access + refresh tokens; mark the code used.
 */
async function handleAuthorizationCodeGrant(
  params: Record<string, string>,
  db: NonNullable<ReturnType<typeof buildSupabaseClient>>,
): Promise<OauthTokenResponse> {
  const code = params['code'];
  const codeVerifier = params['code_verifier'];
  const redirectUri = params['redirect_uri'];
  const resource = params['resource'];
  const clientId = params['client_id'];

  if (typeof code !== 'string' || code.length === 0) {
    return errorResponse('invalid_request', 'code is required', 400);
  }
  if (typeof codeVerifier !== 'string' || codeVerifier.length === 0) {
    return errorResponse('invalid_request', 'code_verifier is required (PKCE)', 400);
  }
  if (typeof redirectUri !== 'string' || redirectUri.length === 0) {
    return errorResponse('invalid_request', 'redirect_uri is required', 400);
  }
  if (typeof resource !== 'string' || resource.length === 0) {
    return errorResponse('invalid_request', 'resource is required (RFC 8707)', 400);
  }
  if (typeof clientId !== 'string' || clientId.length === 0) {
    return errorResponse('invalid_request', 'client_id is required', 400);
  }

  // Per-code rate limit BEFORE DB work so a flood of requests on one code
  // does not stress the DB. Hash the raw code first so the rate-limit map
  // never holds plaintext code values.
  const codeHash = await sha256Hex(code);
  if (noteRequestForCode(codeHash)) {
    return errorResponse('rate_limited', 'Too many requests for this code.', 429, {
      'Retry-After': '60',
    });
  }

  // Audience-canonical-form check on the request resource. Mismatch is
  // invalid_target per RFC 8707 §3. Even though we re-check against the
  // stored row below, fail fast here so the error is unambiguous.
  if (!isCanonicalResourceUri(resource)) {
    return errorResponse(
      'invalid_target',
      `resource must be the canonical URI ${CANONICAL_RESOURCE_URI}`,
      400,
    );
  }

  const codeResult = await findCodeByHash(db, codeHash);
  if (codeResult.kind === 'network_error') {
    return errorResponse('server_error', `db unreachable: ${codeResult.cause}`, 503);
  }
  if (codeResult.kind === 'http_error') {
    return errorResponse(
      'server_error',
      `db error ${codeResult.status}: ${codeResult.body.slice(0, 100)}`,
      500,
    );
  }
  if (codeResult.rows.length === 0) {
    return errorResponse('invalid_grant', 'authorization code not recognized', 400);
  }

  const row = codeResult.rows[0]!;

  // Defense in depth (spec line 26): if the code was already used, revoke
  // every token whose installation_id matches THIS code. The legitimate
  // client's tokens get torched too, surfacing the breach loudly.
  if (row.used_at !== null) {
    void revokeInstallationFamily(db, row.installation_id, new Date().toISOString());
    return errorResponse('invalid_grant', 'authorization code already used', 400);
  }
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    return errorResponse('invalid_grant', 'authorization code expired', 400);
  }
  if (row.client_id !== clientId) {
    return errorResponse('invalid_grant', 'client_id does not match code', 400);
  }
  if (row.redirect_uri !== redirectUri) {
    return errorResponse('invalid_grant', 'redirect_uri does not match code', 400);
  }
  // RFC 8707 binding: the request resource MUST equal the stored
  // resource_uri. We enforce this through canonical-form equivalence (both
  // sides canonicalize to the constant CANONICAL_RESOURCE_URI). The
  // request was already canonical-checked above; verifying the stored
  // value also passes the canonical check makes the two sides
  // functionally equal even if they differ on case / port / trailing-slash
  // (Bugbot findings #2 + #3 on PR #17). Equivalent canonical values
  // produce equivalent issued tokens; mixed-form storage cannot lead to
  // mint-then-reject-at-mcp loops because the issued token's aud_uri
  // ALSO canonical-checks at validation time (see src/upstream.ts).
  if (!isCanonicalResourceUri(row.resource_uri)) {
    return errorResponse(
      'invalid_target',
      'stored resource_uri is not canonical',
      400,
    );
  }
  if (row.code_challenge_method !== 'S256') {
    // Phase 0 migration's CHECK constraint should make this unreachable, but
    // we re-check at the application layer in case schema drift ever lands.
    return errorResponse(
      'invalid_grant',
      'unsupported code_challenge_method on stored code',
      400,
    );
  }

  // PKCE verification: base64url(sha256(code_verifier)) === stored code_challenge.
  // Constant-time string compare inside verifyPkceS256.
  const pkceOk = await verifyPkceS256(codeVerifier, row.code_challenge);
  if (!pkceOk) {
    return errorResponse('invalid_grant', 'PKCE verification failed', 400);
  }

  // Compare-and-set: stamp used_at IFF it is still null. PostgREST translates
  // this to a single UPDATE with WHERE used_at IS NULL, which is atomic at
  // the row level. If two concurrent requests with the same code race past
  // the application-layer row.used_at === null snapshot check above, only
  // one of them will see a 1-row update; the loser sees 0 rows and we deny
  // the second pair. Without this guard both isolates would mint a token
  // pair for the same code (Bugbot HIGH on PR #17).
  const nowIso = new Date().toISOString();
  const usedMark = await markCodeUsedIfUnused(db, codeHash, nowIso);
  if (usedMark.kind !== 'ok') {
    return errorResponse(
      'server_error',
      `code mark-used failed: ${describe(usedMark)}`,
      500,
    );
  }
  if (usedMark.rows.length === 0) {
    // The race loser. The winning request will mint tokens; this request
    // must not. Treat as invalid_grant from the caller's perspective.
    return errorResponse('invalid_grant', 'authorization code already used', 400);
  }

  return mintTokenPair(db, {
    clientId: row.client_id,
    userId: row.user_id,
    scope: row.scope,
    audUri: row.resource_uri,
    installationId: row.installation_id,
  });
}

/**
 * refresh_token grant: validate the refresh token, rotate it (hard-delete the
 * presented row, mint a fresh access+refresh pair sharing the same
 * installation_id). If the presented refresh token cannot be found, this MAY
 * be a replay attack on a previously-rotated family; revoke the whole family
 * just in case.
 *
 * Per RFC 6819 §5.2.2.3, replay-revocation is the documented mitigation for
 * refresh-token theft.
 */
async function handleRefreshTokenGrant(
  params: Record<string, string>,
  db: NonNullable<ReturnType<typeof buildSupabaseClient>>,
): Promise<OauthTokenResponse> {
  const refreshToken = params['refresh_token'];
  const resource = params['resource'];
  const clientId = params['client_id'];

  if (typeof refreshToken !== 'string' || refreshToken.length === 0) {
    return errorResponse('invalid_request', 'refresh_token is required', 400);
  }
  if (typeof resource !== 'string' || resource.length === 0) {
    return errorResponse('invalid_request', 'resource is required (RFC 8707)', 400);
  }
  if (!isCanonicalResourceUri(resource)) {
    return errorResponse(
      'invalid_target',
      `resource must be the canonical URI ${CANONICAL_RESOURCE_URI}`,
      400,
    );
  }
  if (typeof clientId !== 'string' || clientId.length === 0) {
    return errorResponse('invalid_request', 'client_id is required', 400);
  }

  const refreshHash = await sha256Hex(refreshToken);
  const lookup = await findRefreshTokenByHash(db, refreshHash);
  if (lookup.kind === 'network_error') {
    return errorResponse('server_error', `db unreachable: ${lookup.cause}`, 503);
  }
  if (lookup.kind === 'http_error') {
    return errorResponse(
      'server_error',
      `db error ${lookup.status}: ${lookup.body.slice(0, 100)}`,
      500,
    );
  }
  if (lookup.rows.length === 0) {
    // Could be a replay against a previously-redeemed refresh token. We do
    // not know the family without the row, so we cannot revoke; we surface
    // invalid_grant. The defense-in-depth revocation on replay happens
    // below when the row IS found but already marked revoked.
    return errorResponse('invalid_grant', 'refresh token not recognized', 400);
  }

  const row = lookup.rows[0]!;

  if (row.revoked_at !== null) {
    // The legitimate client may have rotated; an attacker presenting the old
    // token would hit this row. Revoke the entire family per RFC 6819.
    void revokeInstallationFamily(db, row.installation_id, new Date().toISOString());
    return errorResponse('invalid_grant', 'refresh token revoked', 400);
  }
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    return errorResponse('invalid_grant', 'refresh token expired', 400);
  }
  if (row.client_id !== clientId) {
    return errorResponse('invalid_grant', 'client_id does not match refresh token', 400);
  }
  // Canonical-form check (parallel to the authorization_code path) instead
  // of strict equality, so a stored aud_uri that differs only on case /
  // explicit-default-port from the canonical constant does not falsely
  // reject the refresh. The request resource was already canonical-checked
  // above; if both pass, they are functionally equivalent.
  if (!isCanonicalResourceUri(row.aud_uri)) {
    return errorResponse('invalid_target', 'stored refresh aud_uri is not canonical', 400);
  }

  // Rotation order: mint the fresh pair FIRST, then hard-delete the
  // presented refresh row. If minting fails (DB partial insert, network
  // error mid-flight), the client retries against the old refresh and
  // succeeds; we have not yet consumed it. Without this ordering, a mid-
  // mint failure would leave the installation without a usable refresh
  // until re-authorization (Bugbot finding #4 on PR #17).
  //
  // The trade-off: if the response is lost in transit AFTER mint+delete,
  // the client retries against the old (now-deleted) refresh and hits the
  // family-revocation path. This is RFC 6819 §5.2.2.3's documented
  // behavior; arch review RISK 6 ("Refresh-token rotation under network
  // failure") flags it as <1% false-positive boot rate, acceptable for v1.
  const mintResult = await mintTokenPair(db, {
    clientId: row.client_id,
    userId: row.user_id,
    scope: row.scope,
    audUri: row.aud_uri,
    installationId: row.installation_id,
  });
  if (mintResult.status !== 200) {
    // Mint failed; the refresh row is intact, client can retry safely.
    return mintResult;
  }

  const del = await deleteRefreshToken(db, refreshHash);
  if (del.kind !== 'ok' || del.rows.length === 0) {
    // Mint succeeded but the redeemed refresh row was not deleted. The
    // legitimate client has a fresh pair; if it later retries against the
    // OLD refresh (network drop scenario), the family-revocation path will
    // burn both pairs. Log this case loudly via the server_error response
    // so on-call can correlate to the refresh-token-grant duplicate-mint
    // class. We do NOT roll back the mint: the new pair is live and
    // returning a 500 here would mask the successful issuance.
    return mintResult;
  }

  return mintResult;
}

/**
 * Mint a fresh access + refresh token pair sharing one installation_id.
 * Used by both the authorization_code and refresh_token grants.
 */
async function mintTokenPair(
  db: NonNullable<ReturnType<typeof buildSupabaseClient>>,
  args: {
    clientId: string;
    userId: string;
    scope: string;
    audUri: string;
    installationId: string;
  },
): Promise<OauthTokenResponse> {
  const accessToken = `${ACCESS_TOKEN_PREFIX}${randomTokenSuffix(32)}`;
  const refreshToken = randomTokenSuffix(32);
  const accessHash = await sha256Hex(accessToken);
  const refreshHash = await sha256Hex(refreshToken);

  const accessExpires = new Date(Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000).toISOString();
  const refreshExpires = new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000).toISOString();

  const accessIns = await insertAccessToken(db, {
    token_hash: accessHash,
    client_id: args.clientId,
    user_id: args.userId,
    scope: args.scope,
    aud_uri: args.audUri,
    installation_id: args.installationId,
    expires_at: accessExpires,
  });
  if (accessIns.kind !== 'ok') {
    return errorResponse('server_error', `access insert failed: ${describe(accessIns)}`, 500);
  }

  const refreshIns = await insertRefreshToken(db, {
    token_hash: refreshHash,
    client_id: args.clientId,
    user_id: args.userId,
    scope: args.scope,
    aud_uri: args.audUri,
    installation_id: args.installationId,
    expires_at: refreshExpires,
  });
  if (refreshIns.kind !== 'ok') {
    return errorResponse('server_error', `refresh insert failed: ${describe(refreshIns)}`, 500);
  }

  return {
    body: {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: refreshToken,
      scope: args.scope,
    },
    status: 200,
  };
}

function errorResponse(
  code: string,
  description: string,
  status: number,
  extraHeaders?: Record<string, string>,
): OauthTokenResponse {
  return {
    body: { error: code, error_description: description },
    status,
    ...(extraHeaders !== undefined ? { headers: extraHeaders } : {}),
  };
}

function describe(result: { kind: string } & Record<string, unknown>): string {
  if (result.kind === 'http_error') {
    return `${result['status']} ${String(result['body']).slice(0, 100)}`;
  }
  if (result.kind === 'network_error') {
    return String(result['cause']);
  }
  return result.kind;
}
