// Unit tests for the VRT-166 OAuth-token branch of src/upstream.ts.
//
// Covers:
//   - happy-path OAuth validation: token hash lookup -> aud_uri check ->
//     user_id resolved -> upstream forwarded with x-verity-user-id header
//   - audience mismatch: aud_uri != canonical -> oauth_token_invalid 'audience_mismatch'
//   - unknown token (no row): oauth_token_invalid 'unknown_token'
//   - expired token: oauth_token_invalid 'expired'
//   - oauth_misconfigured (no SUPABASE_URL): oauth_token_invalid 'oauth_misconfigured'
//   - OAuth kill switch: oauth_token_invalid 'oauth_killed'
//   - Token passthrough invariant: NO vto_ value ever appears in any upstream
//     URL or header (load-bearing security pin per spec line 387 + arch
//     review STRIDE E row 3).

import { describe, expect, it } from 'vitest';
import { proxyToolCall, type ProxyEnv } from '../src/upstream';
import { sha256Hex } from '../src/oauth-crypto';
import { CANONICAL_RESOURCE_URI } from '../src/oauth-canonical';
import type { BearerResult } from '../src/auth';

const REQUEST_ID = '0190b3e8-7f12-7abc-9def-0123456789ab';
const RAW_OAUTH_TOKEN = 'vto_testtokenforupstreamvalidation';

// VRT-166: WORKER_SHARED_SECRET is required on the OAuth path so the
// Worker can prove its x-verity-user-id header came from a real OAuth
// validation. The OAuth-path tests below assume it is present; a separate
// test case below covers the misconfigured-secret 'oauth_misconfigured'
// short-circuit.
const supabaseEnv: ProxyEnv = {
  SUPABASE_URL: 'https://test-project.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'test-key',
  WORKER_SHARED_SECRET: 'test-shared-secret-64-chars-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
};

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

/**
 * Two-stage fetch stub: first call should be the OAuth token lookup, second
 * call should be the upstream skill route. Either can be scripted to return
 * a custom response or fail the test.
 */
function makeStub(
  tokenLookupResp: { status: number; body: unknown } | null,
  upstreamResp: { status: number; body: unknown } | null,
): { fetchImpl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
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

    if (url.includes('/rest/v1/mcp_oauth_tokens')) {
      if (tokenLookupResp === null) throw new Error('unexpected token lookup');
      return new Response(JSON.stringify(tokenLookupResp.body), {
        status: tokenLookupResp.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.startsWith('https://verityskills.com/')) {
      if (upstreamResp === null) throw new Error('unexpected upstream call');
      return new Response(JSON.stringify(upstreamResp.body), {
        status: upstreamResp.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`unhandled stub URL: ${url}`);
  };
  return { fetchImpl, calls };
}

const oauthAuth: BearerResult = { kind: 'valid_oauth_token', token: RAW_OAUTH_TOKEN };

describe('proxyToolCall OAuth-token branch: happy path', () => {
  it('valid token: resolves user_id, forwards x-verity-user-id, NEVER forwards the raw token', async () => {
    const tokenRow = {
      token_hash: await sha256Hex(RAW_OAUTH_TOKEN),
      client_id: 'claude_desktop',
      user_id: '99999999-9999-9999-9999-999999999999',
      scope: 'mcp:invoke',
      aud_uri: CANONICAL_RESOURCE_URI,
      installation_id: 'inst',
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      created_at: new Date().toISOString(),
      last_used_at: null,
    };
    const { fetchImpl, calls } = makeStub(
      { status: 200, body: [tokenRow] },
      { status: 200, body: { ok: true } },
    );

    const outcome = await proxyToolCall(
      'verity-score',
      {},
      oauthAuth,
      REQUEST_ID,
      supabaseEnv,
      fetchImpl,
    );
    expect(outcome.kind).toBe('forward');

    // Two outbound calls: token lookup, then upstream skill route.
    expect(calls).toHaveLength(2);

    const upstreamCall = calls.find((c) => c.url.startsWith('https://verityskills.com/'))!;
    expect(upstreamCall.headers['x-verity-user-id']).toBe(
      '99999999-9999-9999-9999-999999999999',
    );
    // VRT-166: the shared secret MUST accompany x-verity-user-id so the
    // upstream can prove the headers came from this Worker. Pinned to
    // the exact env value so a future bug (e.g. forwarding a typo or
    // truncated secret) becomes a test failure.
    expect(upstreamCall.headers['x-worker-shared-secret']).toBe(
      supabaseEnv.WORKER_SHARED_SECRET,
    );
    // The raw token must NEVER appear in any upstream URL, header, or body.
    expect(upstreamCall.url).not.toContain(RAW_OAUTH_TOKEN);
    expect(upstreamCall.url).not.toContain('vto_');
    for (const [name, value] of Object.entries(upstreamCall.headers)) {
      expect(value).not.toContain(RAW_OAUTH_TOKEN);
      expect(value).not.toContain('vto_');
      // x-verity-key MUST NOT be set on the OAuth path
      expect(name).not.toBe('x-verity-key');
    }
    expect(upstreamCall.body).not.toContain(RAW_OAUTH_TOKEN);
    expect(upstreamCall.body).not.toContain('vto_');
  });
});

describe('proxyToolCall OAuth-token branch: validation failures', () => {
  it('unknown token (no row) returns oauth_token_invalid:unknown_token + NO upstream call', async () => {
    const { fetchImpl, calls } = makeStub({ status: 200, body: [] }, null);

    const outcome = await proxyToolCall(
      'verity-score',
      {},
      oauthAuth,
      REQUEST_ID,
      supabaseEnv,
      fetchImpl,
    );
    expect(outcome.kind).toBe('oauth_token_invalid');
    if (outcome.kind === 'oauth_token_invalid') {
      expect(outcome.reason).toBe('unknown_token');
    }
    // No upstream forward at all.
    expect(calls.filter((c) => c.url.startsWith('https://verityskills.com/'))).toHaveLength(0);
  });

  it('expired token returns oauth_token_invalid:expired + NO upstream call', async () => {
    const expiredRow = {
      token_hash: await sha256Hex(RAW_OAUTH_TOKEN),
      client_id: 'cd',
      user_id: 'u',
      scope: 'mcp:invoke',
      aud_uri: CANONICAL_RESOURCE_URI,
      installation_id: 'i',
      expires_at: new Date(Date.now() - 1000).toISOString(),
      created_at: new Date().toISOString(),
      last_used_at: null,
    };
    const { fetchImpl, calls } = makeStub({ status: 200, body: [expiredRow] }, null);

    const outcome = await proxyToolCall(
      'verity-score',
      {},
      oauthAuth,
      REQUEST_ID,
      supabaseEnv,
      fetchImpl,
    );
    expect(outcome.kind).toBe('oauth_token_invalid');
    if (outcome.kind === 'oauth_token_invalid') {
      expect(outcome.reason).toBe('expired');
    }
    expect(calls.filter((c) => c.url.startsWith('https://verityskills.com/'))).toHaveLength(0);
  });

  it('audience mismatch returns oauth_token_invalid:audience_mismatch + NO upstream call', async () => {
    const wrongAudRow = {
      token_hash: await sha256Hex(RAW_OAUTH_TOKEN),
      client_id: 'cd',
      user_id: 'u',
      scope: 'mcp:invoke',
      aud_uri: 'https://other.example.com',
      installation_id: 'i',
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      created_at: new Date().toISOString(),
      last_used_at: null,
    };
    const { fetchImpl, calls } = makeStub({ status: 200, body: [wrongAudRow] }, null);

    const outcome = await proxyToolCall(
      'verity-score',
      {},
      oauthAuth,
      REQUEST_ID,
      supabaseEnv,
      fetchImpl,
    );
    expect(outcome.kind).toBe('oauth_token_invalid');
    if (outcome.kind === 'oauth_token_invalid') {
      expect(outcome.reason).toBe('audience_mismatch');
    }
    expect(calls.filter((c) => c.url.startsWith('https://verityskills.com/'))).toHaveLength(0);
  });

  it('oauth_misconfigured: missing SUPABASE_URL returns oauth_token_invalid:oauth_misconfigured + no DB call', async () => {
    const { fetchImpl, calls } = makeStub(null, null);
    const outcome = await proxyToolCall(
      'verity-score',
      {},
      oauthAuth,
      REQUEST_ID,
      { SUPABASE_SERVICE_ROLE_KEY: 'k' }, // SUPABASE_URL omitted
      fetchImpl,
    );
    expect(outcome.kind).toBe('oauth_token_invalid');
    if (outcome.kind === 'oauth_token_invalid') {
      expect(outcome.reason).toBe('oauth_misconfigured');
    }
    expect(calls).toHaveLength(0);
  });

  it('oauth_misconfigured: missing WORKER_SHARED_SECRET returns oauth_token_invalid:oauth_misconfigured BEFORE any DB or upstream call', async () => {
    // VRT-166 fail-closed: if the Worker is deployed without the shared
    // secret set, the OAuth path MUST refuse to forward upstream. A
    // silent forward would 401 at the upstream (no shared-secret match)
    // and look like infrastructure breakage instead of a config bug.
    const { fetchImpl, calls } = makeStub(null, null);
    const outcome = await proxyToolCall(
      'verity-score',
      {},
      oauthAuth,
      REQUEST_ID,
      // SUPABASE_* set, but WORKER_SHARED_SECRET intentionally omitted.
      {
        SUPABASE_URL: 'https://test-project.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'test-key',
      },
      fetchImpl,
    );
    expect(outcome.kind).toBe('oauth_token_invalid');
    if (outcome.kind === 'oauth_token_invalid') {
      expect(outcome.reason).toBe('oauth_misconfigured');
    }
    // No DB call AND no upstream call: the fail-closed must short-circuit
    // before any network I/O.
    expect(calls).toHaveLength(0);
  });

  it('oauth_misconfigured: empty-string WORKER_SHARED_SECRET also fails closed', async () => {
    const { fetchImpl, calls } = makeStub(null, null);
    const outcome = await proxyToolCall(
      'verity-score',
      {},
      oauthAuth,
      REQUEST_ID,
      {
        SUPABASE_URL: 'https://test-project.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'test-key',
        WORKER_SHARED_SECRET: '',
      },
      fetchImpl,
    );
    expect(outcome.kind).toBe('oauth_token_invalid');
    if (outcome.kind === 'oauth_token_invalid') {
      expect(outcome.reason).toBe('oauth_misconfigured');
    }
    expect(calls).toHaveLength(0);
  });

  it('oauth_killed: MCP_OAUTH_KILL_SWITCH=on returns oauth_token_invalid:oauth_killed + no DB call', async () => {
    const { fetchImpl, calls } = makeStub(null, null);
    const outcome = await proxyToolCall(
      'verity-score',
      {},
      oauthAuth,
      REQUEST_ID,
      { ...supabaseEnv, MCP_OAUTH_KILL_SWITCH: 'on' },
      fetchImpl,
    );
    expect(outcome.kind).toBe('oauth_token_invalid');
    if (outcome.kind === 'oauth_token_invalid') {
      expect(outcome.reason).toBe('oauth_killed');
    }
    expect(calls).toHaveLength(0);
  });
});

describe('proxyToolCall OAuth-token branch: token-passthrough invariant (property)', () => {
  it('audience-mismatch property: 100 random non-canonical aud_uri values all reject (arch review R8 test 3)', async () => {
    // Direct array of probe URIs because the OAuth path is async and pulls
    // through a fetchImpl that's not trivially shareable across fc cases.
    // We hand-script 100 plausible non-canonical audiences.
    const probes: string[] = [];
    for (let i = 0; i < 100; i++) {
      // Spread across the failure modes: wrong host, http scheme, trailing
      // slash, path, query string, fragment, port mismatch, garbage.
      const variants = [
        `https://other${i}.example.com`,
        `http://mcp.verityskills.com`,
        `https://mcp.verityskills.com/`,
        `https://mcp.verityskills.com/path${i}`,
        `https://mcp.verityskills.com?x=${i}`,
        `https://mcp.verityskills.com#frag${i}`,
        `https://mcp.verityskills.com:8443`,
        `not-a-url-${i}`,
      ];
      probes.push(variants[i % variants.length]!);
    }

    for (const audUri of probes) {
      const tokenRow = {
        token_hash: await sha256Hex(RAW_OAUTH_TOKEN),
        client_id: 'cd',
        user_id: 'u',
        scope: 'mcp:invoke',
        aud_uri: audUri,
        installation_id: 'i',
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        created_at: new Date().toISOString(),
        last_used_at: null,
      };
      const { fetchImpl, calls } = makeStub({ status: 200, body: [tokenRow] }, null);
      const outcome = await proxyToolCall(
        'verity-score',
        {},
        oauthAuth,
        REQUEST_ID,
        supabaseEnv,
        fetchImpl,
      );
      expect(outcome.kind).toBe('oauth_token_invalid');
      if (outcome.kind === 'oauth_token_invalid') {
        expect(outcome.reason).toBe('audience_mismatch');
      }
      // Crucially: ZERO upstream calls for any of the 100 probes.
      expect(calls.filter((c) => c.url.startsWith('https://verityskills.com/'))).toHaveLength(0);
    }
  });
});
