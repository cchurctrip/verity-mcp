// Typed accessors for the four OAuth tables on the Verity Supabase project.
//
// Schema is owned by Phase 0 migrations 046/047/048 (shipped) on
// cchurctrip/verity:
//
//   mcp_oauth_clients         client_id, display_name, redirect_uris, software_id, software_version, created_at
//   mcp_oauth_codes           code_hash, client_id, user_id, redirect_uri,
//                             code_challenge, code_challenge_method, scope,
//                             resource_uri, installation_id,
//                             expires_at, used_at
//   mcp_oauth_tokens          token_hash, client_id, user_id, scope, aud_uri,
//                             installation_id, expires_at, created_at,
//                             last_used_at
//   mcp_oauth_refresh_tokens  token_hash, client_id, user_id, scope, aud_uri,
//                             installation_id, expires_at, created_at,
//                             last_used_at, revoked_at
//
// Every helper here returns a discriminated-union result so the caller
// (src/oauth-token.ts) can exhaustively switch on the outcome and map to the
// right OAuth error code. The SupabaseClient layer surfaces network errors
// as a distinct kind so the caller can return 503 rather than 400/401 when
// the DB is unreachable.

import type { SupabaseClient, SupabaseResult } from './supabase';

export interface OauthCodeRow {
  code_hash: string;
  client_id: string;
  user_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  scope: string;
  resource_uri: string;
  installation_id: string;
  expires_at: string;
  used_at: string | null;
}

export interface OauthTokenRow {
  token_hash: string;
  client_id: string;
  user_id: string;
  scope: string;
  aud_uri: string;
  installation_id: string;
  expires_at: string;
  created_at: string;
  last_used_at: string | null;
}

export interface OauthRefreshTokenRow {
  token_hash: string;
  client_id: string;
  user_id: string;
  scope: string;
  aud_uri: string;
  installation_id: string;
  expires_at: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

/**
 * Lookup an authorization code by its sha256(raw_code) hash. Returns the
 * row, or null if no row matches.
 */
export async function findCodeByHash(
  db: SupabaseClient,
  codeHash: string,
): Promise<SupabaseResult<OauthCodeRow>> {
  return db.select<OauthCodeRow>(
    'mcp_oauth_codes',
    `code_hash=eq.${encodeURIComponent(codeHash)}`,
  );
}

/**
 * Atomically mark a code row as used IFF it is currently unused. The
 * `used_at=is.null` filter makes the UPDATE a compare-and-set: PostgREST
 * generates `UPDATE ... WHERE code_hash = ? AND used_at IS NULL`, so two
 * concurrent /oauth/token requests with the same code can only have ONE
 * succeed; the loser sees an empty `rows` array and the caller treats that
 * as a redemption race + denies the second pair.
 *
 * Caller MUST check `rows.length === 1` to confirm it won the race.
 * Without this guard, two isolates racing the same code would both pass
 * the application-layer `row.used_at === null` check (snapshot reads),
 * both call markCodeUsed, and both mint a token pair (Bugbot HIGH on PR #17).
 */
export async function markCodeUsedIfUnused(
  db: SupabaseClient,
  codeHash: string,
  usedAtIso: string,
): Promise<SupabaseResult<OauthCodeRow>> {
  return db.update<OauthCodeRow>(
    'mcp_oauth_codes',
    `code_hash=eq.${encodeURIComponent(codeHash)}&used_at=is.null`,
    { used_at: usedAtIso },
  );
}

/**
 * Insert a new access-token row. Caller pre-hashes the raw token.
 */
export async function insertAccessToken(
  db: SupabaseClient,
  row: Omit<OauthTokenRow, 'created_at' | 'last_used_at'>,
): Promise<SupabaseResult<OauthTokenRow>> {
  return db.insert<OauthTokenRow>('mcp_oauth_tokens', row);
}

/**
 * Insert a new refresh-token row. Caller pre-hashes the raw token.
 */
export async function insertRefreshToken(
  db: SupabaseClient,
  row: Omit<OauthRefreshTokenRow, 'created_at' | 'last_used_at' | 'revoked_at'>,
): Promise<SupabaseResult<OauthRefreshTokenRow>> {
  return db.insert<OauthRefreshTokenRow>('mcp_oauth_refresh_tokens', row);
}

/**
 * Lookup an access-token row by hash. Returns the row, or null if no row
 * matches. Caller checks expires_at and aud_uri.
 */
export async function findAccessTokenByHash(
  db: SupabaseClient,
  tokenHash: string,
): Promise<SupabaseResult<OauthTokenRow>> {
  return db.select<OauthTokenRow>(
    'mcp_oauth_tokens',
    `token_hash=eq.${encodeURIComponent(tokenHash)}`,
  );
}

/**
 * Lookup a refresh-token row by hash.
 */
export async function findRefreshTokenByHash(
  db: SupabaseClient,
  tokenHash: string,
): Promise<SupabaseResult<OauthRefreshTokenRow>> {
  return db.select<OauthRefreshTokenRow>(
    'mcp_oauth_refresh_tokens',
    `token_hash=eq.${encodeURIComponent(tokenHash)}`,
  );
}

/**
 * Hard-delete a refresh-token row by hash. Used during refresh rotation: the
 * presented refresh token is consumed (deleted) and a fresh one is issued.
 * Returns the deleted rows so the caller can confirm exactly one row was
 * removed.
 */
export async function deleteRefreshToken(
  db: SupabaseClient,
  tokenHash: string,
): Promise<SupabaseResult<OauthRefreshTokenRow>> {
  return db.remove<OauthRefreshTokenRow>(
    'mcp_oauth_refresh_tokens',
    `token_hash=eq.${encodeURIComponent(tokenHash)}`,
  );
}

/**
 * Atomic claim-and-delete on a refresh-token row. Single-statement DELETE
 * scoped by token_hash AND revoked_at=is.null AND used_at-ish freshness.
 * Returns the rows removed so the caller can verify it won the race.
 *
 * Two concurrent refresh-token grants presenting the same token can both
 * see the row as non-revoked in their snapshot SELECT; without an atomic
 * claim, both would proceed to mintTokenPair and emit two pairs against
 * one stolen refresh. PostgREST DELETE returns the deleted rows, giving
 * us a compare-and-claim via the filter. Loser sees 0 rows and aborts.
 */
export async function claimRefreshTokenForRotation(
  db: SupabaseClient,
  tokenHash: string,
): Promise<SupabaseResult<OauthRefreshTokenRow>> {
  return db.remove<OauthRefreshTokenRow>(
    'mcp_oauth_refresh_tokens',
    `token_hash=eq.${encodeURIComponent(tokenHash)}&revoked_at=is.null`,
  );
}

/**
 * Family revocation: mark every access + refresh token row sharing an
 * `installation_id` as revoked. Triggered on (a) refresh-token replay (the
 * RFC 6819 §5.2.2.3 family-revocation path) and (b) authorization-code
 * replay (defense in depth).
 *
 * Implementation:
 *   - Access tokens have no `revoked_at` column; we DELETE the rows instead.
 *     The Worker validates by hash lookup; a missing row reads as 401.
 *   - Refresh tokens have `revoked_at`; we set it to the current ISO so the
 *     admin UI can audit the revocation later.
 *
 * Returns the count of affected rows for each table. Callers log this for
 * incident-response visibility.
 */
export async function revokeInstallationFamily(
  db: SupabaseClient,
  installationId: string,
  revokedAtIso: string,
): Promise<{ accessTokensDeleted: number; refreshTokensRevoked: number; lastError?: string }> {
  const filter = `installation_id=eq.${encodeURIComponent(installationId)}`;

  const accessDel = await db.remove<OauthTokenRow>('mcp_oauth_tokens', filter);
  const refreshUpd = await db.update<OauthRefreshTokenRow>(
    'mcp_oauth_refresh_tokens',
    `${filter}&revoked_at=is.null`,
    { revoked_at: revokedAtIso },
  );

  let lastError: string | undefined;
  let accessTokensDeleted = 0;
  let refreshTokensRevoked = 0;

  if (accessDel.kind === 'ok') {
    accessTokensDeleted = accessDel.rows.length;
  } else if (accessDel.kind === 'http_error') {
    lastError = `access_tokens_delete: ${accessDel.status} ${accessDel.body.slice(0, 100)}`;
  } else {
    lastError = `access_tokens_delete: ${accessDel.cause}`;
  }

  if (refreshUpd.kind === 'ok') {
    refreshTokensRevoked = refreshUpd.rows.length;
  } else if (refreshUpd.kind === 'http_error') {
    lastError = `refresh_tokens_update: ${refreshUpd.status} ${refreshUpd.body.slice(0, 100)}`;
  } else {
    lastError = `refresh_tokens_update: ${refreshUpd.cause}`;
  }

  return lastError === undefined
    ? { accessTokensDeleted, refreshTokensRevoked }
    : { accessTokensDeleted, refreshTokensRevoked, lastError };
}
