// Tests for the POST /oauth/token handler in src/oauth-token.ts.
//
// We exercise the handler directly (not via SELF.fetch) so we can:
//   - inject SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY without touching wrangler.toml
//   - intercept the outbound PostgREST fetch with a per-test stub
//   - reset the in-isolate rate-limit map between cases
//
// Covered (per spec validation §10 + arch review R8):
//   - happy-path authorization_code grant mints vto_<...> access + opaque refresh
//   - PKCE S256 mismatch returns invalid_grant
//   - audience mismatch returns invalid_target (canonical-form check)
//   - authorization-code single-use (used_at != null) returns invalid_grant
//     AND triggers family revocation (defense in depth)
//   - refresh-token rotation: A -> B + C; redeem A again revokes family
//   - non-empty client_secret rejected with invalid_client
//   - unsupported grant_type rejected
//   - kill switch returns 503 + Retry-After
//   - misconfigured env returns 503 + oauth_misconfigured sentinel
//   - per-code rate limit: 11th request on one code returns 429

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleOauthToken } from '../src/oauth-token';
import { sha256Hex } from '../src/oauth-crypto';
import { _resetRateLimitForTests } from '../src/oauth-rate-limit';
import { CANONICAL_RESOURCE_URI } from '../src/oauth-canonical';

const SUPABASE_URL = 'https://test-project.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

/**
 * Build a fetch stub that records every outbound call and returns a per-call
 * scripted response. Each entry in `responses` is matched in order against
 * the request URL substring; the matching entry's body + status are returned.
 */
function makeFetchStub(
  responses: Array<{ matchUrl: string; status: number; body: unknown }>,
): { fetchImpl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  let cursor = 0;

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const method = init?.method ?? 'GET';
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = init.headers;
      if (h instanceof Headers) {
        h.forEach((v, k) => {
          headers[k.toLowerCase()] = v;
        });
      } else if (Array.isArray(h)) {
        for (const [k, v] of h) headers[String(k).toLowerCase()] = String(v);
      } else {
        for (const [k, v] of Object.entries(h as Record<string, string>)) {
          headers[k.toLowerCase()] = v;
        }
      }
    }
    const body = typeof init?.body === 'string' ? init.body : init?.body === undefined ? null : String(init.body);
    calls.push({ url, method, headers, body });

    // Find the next matching scripted response from the cursor onwards. We
    // walk forward (not random-access) so tests can script per-call sequences.
    for (let i = cursor; i < responses.length; i++) {
      if (url.includes(responses[i]!.matchUrl)) {
        cursor = i + 1;
        const r = responses[i]!;
        return new Response(JSON.stringify(r.body), {
          status: r.status,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }
    throw new Error(`No scripted response for ${method} ${url}`);
  };

  return { fetchImpl, calls };
}

function formBody(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

function tokenReq(body: string, ct: string = 'application/x-www-form-urlencoded'): Request {
  return new Request('http://example.com/oauth/token', {
    method: 'POST',
    headers: { 'content-type': ct },
    body,
  });
}

// PKCE S256(verifier) -> base64url(sha256(verifier))
async function pkceChallenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(digest);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const baseEnv = {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
};

beforeEach(() => {
  _resetRateLimitForTests();
});

afterEach(() => {
  _resetRateLimitForTests();
});

describe('handleOauthToken kill-switch + misconfigured', () => {
  it('returns 503 + Retry-After when MCP_OAUTH_KILL_SWITCH is "on"', async () => {
    const { fetchImpl } = makeFetchStub([]);
    const res = await handleOauthToken(
      tokenReq(formBody({ grant_type: 'authorization_code', code: 'x' })),
      { ...baseEnv, MCP_OAUTH_KILL_SWITCH: 'on' },
      fetchImpl,
    );
    expect(res.status).toBe(503);
    expect(res.headers?.['Retry-After']).toBe('60');
    expect((res.body as { error: string }).error).toBe('temporarily_unavailable');
  });

  it('returns 503 + oauth_misconfigured when SUPABASE_URL is missing', async () => {
    const { fetchImpl, calls } = makeFetchStub([]);
    const res = await handleOauthToken(
      tokenReq(formBody({ grant_type: 'authorization_code', code: 'x' })),
      { SUPABASE_SERVICE_ROLE_KEY: 'k' },
      fetchImpl,
    );
    expect(res.status).toBe(503);
    expect((res.body as { code: string }).code).toBe('oauth_misconfigured');
    expect(calls).toHaveLength(0); // no DB call
  });

  it('returns 503 + oauth_misconfigured when SUPABASE_SERVICE_ROLE_KEY is missing', async () => {
    const { fetchImpl } = makeFetchStub([]);
    const res = await handleOauthToken(
      tokenReq(formBody({ grant_type: 'authorization_code', code: 'x' })),
      { SUPABASE_URL },
      fetchImpl,
    );
    expect(res.status).toBe(503);
    expect((res.body as { code: string }).code).toBe('oauth_misconfigured');
  });
});

describe('handleOauthToken client_secret rejection (PKCE-only, public clients)', () => {
  it('returns invalid_client when client_secret is a non-empty string', async () => {
    const { fetchImpl } = makeFetchStub([]);
    const res = await handleOauthToken(
      tokenReq(
        formBody({
          grant_type: 'authorization_code',
          code: 'x',
          client_secret: 'leaked',
        }),
      ),
      baseEnv,
      fetchImpl,
    );
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe('invalid_client');
  });

  it('accepts an absent client_secret on otherwise-correct authorization_code flow', async () => {
    // Wire up a full happy-path scenario; absence of client_secret must not
    // by itself trigger any error.
    await runHappyPathAuthorizationCode();
  });
});

describe('handleOauthToken unsupported grants and body parsing', () => {
  it('returns unsupported_grant_type for an unknown grant', async () => {
    const { fetchImpl } = makeFetchStub([]);
    const res = await handleOauthToken(
      tokenReq(formBody({ grant_type: 'password' })),
      baseEnv,
      fetchImpl,
    );
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe('unsupported_grant_type');
  });

  it('returns invalid_request on malformed JSON body', async () => {
    const { fetchImpl } = makeFetchStub([]);
    const res = await handleOauthToken(
      tokenReq('{not-json', 'application/json'),
      baseEnv,
      fetchImpl,
    );
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe('invalid_request');
  });

  it('accepts application/json body shape (resilience)', async () => {
    const { fetchImpl } = makeFetchStub([]);
    const res = await handleOauthToken(
      tokenReq(JSON.stringify({ grant_type: 'password' }), 'application/json'),
      baseEnv,
      fetchImpl,
    );
    // Same grant_type rejection as form-urlencoded
    expect((res.body as { error: string }).error).toBe('unsupported_grant_type');
  });
});

describe('handleOauthToken authorization_code grant', () => {
  it('happy path mints vto_ access token + opaque refresh token with correct expires_in', async () => {
    const result = await runHappyPathAuthorizationCode();
    expect(result.res.status).toBe(200);
    const body = result.res.body as {
      access_token: string;
      token_type: string;
      expires_in: number;
      refresh_token: string;
      scope: string;
    };
    expect(body.access_token.startsWith('vto_')).toBe(true);
    expect(body.token_type).toBe('Bearer');
    expect(body.expires_in).toBe(3600);
    expect(typeof body.refresh_token).toBe('string');
    expect(body.refresh_token.length).toBeGreaterThan(16);
    expect(body.scope).toBe('mcp:invoke');
  });

  it('PKCE mismatch returns invalid_grant', async () => {
    const verifier = 'a'.repeat(64);
    const wrongChallenge = await pkceChallenge('different-verifier');

    const { fetchImpl } = scriptAuthorizationCodeLookup({
      codeRow: {
        code_hash: 'unused',
        client_id: 'claude_desktop',
        user_id: '00000000-0000-0000-0000-000000000001',
        redirect_uri: 'http://localhost:0/oauth/callback',
        code_challenge: wrongChallenge,
        code_challenge_method: 'S256',
        scope: 'mcp:invoke',
        resource_uri: CANONICAL_RESOURCE_URI,
        installation_id: '11111111-1111-1111-1111-111111111111',
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        used_at: null,
      },
    });

    const res = await handleOauthToken(
      tokenReq(
        formBody({
          grant_type: 'authorization_code',
          code: 'somecode',
          code_verifier: verifier,
          redirect_uri: 'http://localhost:0/oauth/callback',
          resource: CANONICAL_RESOURCE_URI,
          client_id: 'claude_desktop',
        }),
      ),
      baseEnv,
      fetchImpl,
    );
    expect(res.status).toBe(400);
    expect((res.body as { error: string; error_description: string }).error).toBe('invalid_grant');
    expect((res.body as { error_description: string }).error_description).toMatch(/PKCE/i);
  });

  it('non-canonical resource returns invalid_target without DB lookup', async () => {
    const { fetchImpl, calls } = makeFetchStub([]);
    const res = await handleOauthToken(
      tokenReq(
        formBody({
          grant_type: 'authorization_code',
          code: 'x',
          code_verifier: 'a'.repeat(64),
          redirect_uri: 'http://localhost:0/oauth/callback',
          resource: 'https://mcp.verityskills.com/',
          client_id: 'claude_desktop',
        }),
      ),
      baseEnv,
      fetchImpl,
    );
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe('invalid_target');
    expect(calls).toHaveLength(0);
  });

  it('compare-and-set redemption: returns invalid_grant when the UPDATE affects 0 rows (race loser)', async () => {
    // Two-isolate race scenario: both isolates see used_at=null in their
    // snapshot SELECT, both call markCodeUsedIfUnused, only one wins.
    // We simulate the loser path by scripting the UPDATE to return 0 rows
    // (mimicking what PostgREST returns when used_at IS NULL no longer
    // holds because another isolate stamped it microseconds ago).
    const verifier = 'a'.repeat(64);
    const challenge = await pkceChallenge(verifier);
    const codeRow = {
      code_hash: 'unused',
      client_id: 'claude_desktop',
      user_id: 'u',
      redirect_uri: 'http://localhost:0/oauth/callback',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      scope: 'mcp:invoke',
      resource_uri: CANONICAL_RESOURCE_URI,
      installation_id: 'i',
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      used_at: null,
    };
    const { fetchImpl } = makeFetchStub([
      // SELECT code: row found, used_at null (snapshot before the race winner stamped it)
      { matchUrl: '/rest/v1/mcp_oauth_codes?select=', status: 200, body: [codeRow] },
      // PATCH compare-and-set: 0 rows (winner stamped it first)
      { matchUrl: '/rest/v1/mcp_oauth_codes?code_hash=eq.', status: 200, body: [] },
    ]);

    const res = await handleOauthToken(
      tokenReq(
        formBody({
          grant_type: 'authorization_code',
          code: 'racy',
          code_verifier: verifier,
          redirect_uri: 'http://localhost:0/oauth/callback',
          resource: CANONICAL_RESOURCE_URI,
          client_id: 'claude_desktop',
        }),
      ),
      baseEnv,
      fetchImpl,
    );
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe('invalid_grant');
    expect((res.body as { error_description: string }).error_description).toMatch(/already used/i);
  });

  it('authorization-code single-use: replay returns invalid_grant AND triggers family revoke', async () => {
    const { fetchImpl, calls } = scriptAuthorizationCodeLookup({
      codeRow: {
        code_hash: 'unused',
        client_id: 'claude_desktop',
        user_id: 'u',
        redirect_uri: 'http://localhost:0/oauth/callback',
        code_challenge: 'x',
        code_challenge_method: 'S256',
        scope: 'mcp:invoke',
        resource_uri: CANONICAL_RESOURCE_URI,
        installation_id: '22222222-2222-2222-2222-222222222222',
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        used_at: new Date().toISOString(), // already used
      },
      extra: [
        // Family revoke: DELETE mcp_oauth_tokens, PATCH mcp_oauth_refresh_tokens
        { matchUrl: '/rest/v1/mcp_oauth_tokens', status: 200, body: [] },
        { matchUrl: '/rest/v1/mcp_oauth_refresh_tokens', status: 200, body: [] },
      ],
    });

    const res = await handleOauthToken(
      tokenReq(
        formBody({
          grant_type: 'authorization_code',
          code: 'somecode',
          code_verifier: 'a'.repeat(64),
          redirect_uri: 'http://localhost:0/oauth/callback',
          resource: CANONICAL_RESOURCE_URI,
          client_id: 'claude_desktop',
        }),
      ),
      baseEnv,
      fetchImpl,
    );
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe('invalid_grant');
    expect((res.body as { error_description: string }).error_description).toMatch(/already used/i);

    // Defense-in-depth: the family revoke fires (DELETE + PATCH calls).
    const revokeCalls = calls.filter(
      (c) =>
        c.method === 'DELETE' && c.url.includes('/rest/v1/mcp_oauth_tokens?installation_id=eq.'),
    );
    expect(revokeCalls.length).toBeGreaterThanOrEqual(1);
  });
});

describe('handleOauthToken /oauth/token per-code rate limit (arch review R8 test 1)', () => {
  it('returns 429 on the 11th rapid request for the same code', async () => {
    // We do not need DB responses here: the rate-limit gate fires BEFORE
    // any DB lookup. But we do need to bypass the canonical-resource and
    // PKCE early-rejects. The fastest path is to pre-poison the rate map by
    // calling 10 times with non-canonical resource (each returns 400 but
    // each still records one rate-limit slot for the code hash).
    const { fetchImpl } = makeFetchStub([]);
    const code = 'samecode';
    for (let i = 0; i < 10; i++) {
      const r = await handleOauthToken(
        tokenReq(
          formBody({
            grant_type: 'authorization_code',
            code,
            code_verifier: 'a'.repeat(64),
            redirect_uri: 'http://localhost:0/oauth/callback',
            resource: CANONICAL_RESOURCE_URI, // canonical -> rate slot is consumed, DB lookup would happen but stub will error
            client_id: 'claude_desktop',
          }),
        ),
        baseEnv,
        // Use a fetch stub that returns "no row" on EVERY call so we always
        // get invalid_grant rather than a stub-empty error.
        async () =>
          new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } }),
      );
      // Each of the first 10 should produce invalid_grant (code not found),
      // not rate_limited.
      expect(r.status).toBe(400);
      expect((r.body as { error: string }).error).toBe('invalid_grant');
      // Silence unused-var
      void fetchImpl;
    }

    // The 11th attempt on the same code MUST be 429.
    const r11 = await handleOauthToken(
      tokenReq(
        formBody({
          grant_type: 'authorization_code',
          code,
          code_verifier: 'a'.repeat(64),
          redirect_uri: 'http://localhost:0/oauth/callback',
          resource: CANONICAL_RESOURCE_URI,
          client_id: 'claude_desktop',
        }),
      ),
      baseEnv,
      async () =>
        new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
    expect(r11.status).toBe(429);
    expect((r11.body as { error: string }).error).toBe('rate_limited');
    expect(r11.headers?.['Retry-After']).toBe('60');
  });
});

describe('handleOauthToken refresh_token grant', () => {
  it('happy path: rotate refresh -> mint new pair, hard-delete the redeemed refresh', async () => {
    const oldRefresh = 'oldrefreshtoken';
    const refreshRow = {
      token_hash: await sha256Hex(oldRefresh),
      client_id: 'claude_desktop',
      user_id: 'u',
      scope: 'mcp:invoke',
      aud_uri: CANONICAL_RESOURCE_URI,
      installation_id: '33333333-3333-3333-3333-333333333333',
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      created_at: new Date().toISOString(),
      last_used_at: null,
      revoked_at: null,
    };

    const { fetchImpl, calls } = makeFetchStub([
      // 1. SELECT refresh row
      { matchUrl: '/rest/v1/mcp_oauth_refresh_tokens?select=', status: 200, body: [refreshRow] },
      // 2. DELETE the redeemed refresh row
      { matchUrl: '/rest/v1/mcp_oauth_refresh_tokens?token_hash=eq.', status: 200, body: [refreshRow] },
      // 3. INSERT access token
      { matchUrl: '/rest/v1/mcp_oauth_tokens', status: 201, body: [{}] },
      // 4. INSERT refresh token
      { matchUrl: '/rest/v1/mcp_oauth_refresh_tokens', status: 201, body: [{}] },
    ]);

    const res = await handleOauthToken(
      tokenReq(
        formBody({
          grant_type: 'refresh_token',
          refresh_token: oldRefresh,
          resource: CANONICAL_RESOURCE_URI,
          client_id: 'claude_desktop',
        }),
      ),
      baseEnv,
      fetchImpl,
    );
    expect(res.status).toBe(200);
    const body = res.body as { access_token: string; refresh_token: string };
    expect(body.access_token.startsWith('vto_')).toBe(true);
    expect(body.refresh_token).not.toBe(oldRefresh);
    // Hard-delete of the redeemed refresh fired
    expect(calls.some((c) => c.method === 'DELETE' && c.url.includes('mcp_oauth_refresh_tokens?token_hash=eq.'))).toBe(true);
  });

  it('replay (redeem a previously-revoked refresh) triggers family revocation', async () => {
    const replayed = 'replayedtoken';
    const refreshRow = {
      token_hash: await sha256Hex(replayed),
      client_id: 'claude_desktop',
      user_id: 'u',
      scope: 'mcp:invoke',
      aud_uri: CANONICAL_RESOURCE_URI,
      installation_id: '44444444-4444-4444-4444-444444444444',
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      created_at: new Date().toISOString(),
      last_used_at: null,
      revoked_at: new Date().toISOString(), // already revoked -> replay path
    };

    const { fetchImpl, calls } = makeFetchStub([
      { matchUrl: '/rest/v1/mcp_oauth_refresh_tokens?select=', status: 200, body: [refreshRow] },
      // family revoke
      { matchUrl: '/rest/v1/mcp_oauth_tokens', status: 200, body: [] },
      { matchUrl: '/rest/v1/mcp_oauth_refresh_tokens', status: 200, body: [] },
    ]);

    const res = await handleOauthToken(
      tokenReq(
        formBody({
          grant_type: 'refresh_token',
          refresh_token: replayed,
          resource: CANONICAL_RESOURCE_URI,
          client_id: 'claude_desktop',
        }),
      ),
      baseEnv,
      fetchImpl,
    );
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe('invalid_grant');

    // Family revoke fires: DELETE on mcp_oauth_tokens with installation_id filter
    const familyDelete = calls.find(
      (c) =>
        c.method === 'DELETE' &&
        c.url.includes('mcp_oauth_tokens?installation_id=eq.') &&
        c.url.includes(refreshRow.installation_id),
    );
    expect(familyDelete).toBeDefined();
  });

  it('unknown refresh returns invalid_grant', async () => {
    const { fetchImpl } = makeFetchStub([
      { matchUrl: '/rest/v1/mcp_oauth_refresh_tokens?select=', status: 200, body: [] },
    ]);
    const res = await handleOauthToken(
      tokenReq(
        formBody({
          grant_type: 'refresh_token',
          refresh_token: 'doesnotexist',
          resource: CANONICAL_RESOURCE_URI,
          client_id: 'claude_desktop',
        }),
      ),
      baseEnv,
      fetchImpl,
    );
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe('invalid_grant');
  });
});

// ----------------- helpers used across the happy-path tests -----------------

async function runHappyPathAuthorizationCode(): Promise<{
  res: Awaited<ReturnType<typeof handleOauthToken>>;
  calls: FetchCall[];
}> {
  const verifier = 'a'.repeat(64);
  const challenge = await pkceChallenge(verifier);

  const codeRow = {
    code_hash: 'precomputed-but-unused-since-we-match-on-url-substring',
    client_id: 'claude_desktop',
    user_id: '00000000-0000-0000-0000-000000000001',
    redirect_uri: 'http://localhost:0/oauth/callback',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    scope: 'mcp:invoke',
    resource_uri: CANONICAL_RESOURCE_URI,
    installation_id: '55555555-5555-5555-5555-555555555555',
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    used_at: null,
  };

  const { fetchImpl, calls } = makeFetchStub([
    // 1. SELECT code by hash
    { matchUrl: '/rest/v1/mcp_oauth_codes?select=', status: 200, body: [codeRow] },
    // 2. PATCH code mark used
    { matchUrl: '/rest/v1/mcp_oauth_codes?code_hash=eq.', status: 200, body: [codeRow] },
    // 3. POST access token insert
    { matchUrl: '/rest/v1/mcp_oauth_tokens', status: 201, body: [{}] },
    // 4. POST refresh token insert
    { matchUrl: '/rest/v1/mcp_oauth_refresh_tokens', status: 201, body: [{}] },
  ]);

  const res = await handleOauthToken(
    tokenReq(
      formBody({
        grant_type: 'authorization_code',
        code: 'a-real-code',
        code_verifier: verifier,
        redirect_uri: 'http://localhost:0/oauth/callback',
        resource: CANONICAL_RESOURCE_URI,
        client_id: 'claude_desktop',
      }),
    ),
    baseEnv,
    fetchImpl,
  );
  return { res, calls };
}

function scriptAuthorizationCodeLookup(args: {
  codeRow: Record<string, unknown>;
  extra?: Array<{ matchUrl: string; status: number; body: unknown }>;
}): { fetchImpl: typeof fetch; calls: FetchCall[] } {
  return makeFetchStub([
    { matchUrl: '/rest/v1/mcp_oauth_codes?select=', status: 200, body: [args.codeRow] },
    ...(args.extra ?? []),
  ]);
}
