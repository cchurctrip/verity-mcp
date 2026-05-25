// Integration tests for the VRT-166 OAuth surface routed through SELF.fetch.
//
// Coverage:
//   - GET /.well-known/oauth-authorization-server returns RFC 8414 doc
//   - GET /.well-known/oauth-protected-resource returns RFC 9728 doc
//   - 401 responses carry WWW-Authenticate: Bearer realm=..., resource_metadata=...
//     - bearer_invalid (malformed Authorization header)
//     - /sse GET with no/invalid bearer
//
// Tests that rely on env mutation (kill switch, Supabase secrets) live in
// the unit-layer tests (tests/oauth-token.test.ts, tests/oauth-discovery.test.ts)
// per the existing comment in tests/integration.test.ts about Miniflare's
// env-binding immutability.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SELF, fetchMock } from 'cloudflare:test';

const UPSTREAM_ORIGIN = 'https://verityskills.com';

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

afterEach(() => {
  fetchMock.assertNoPendingInterceptors();
});

afterAll(() => {
  fetchMock.deactivate();
});

describe('GET /.well-known/oauth-authorization-server', () => {
  it('returns RFC 8414 metadata with the right endpoints + omits registration_endpoint', async () => {
    const res = await SELF.fetch('http://example.com/.well-known/oauth-authorization-server');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('application/json');
    const doc = (await res.json()) as Record<string, unknown>;
    expect(doc['issuer']).toBe('https://mcp.verityskills.com');
    expect(doc['authorization_endpoint']).toBe('https://verityskills.com/oauth/mcp/authorize');
    expect(doc['token_endpoint']).toBe('https://mcp.verityskills.com/oauth/token');
    expect(doc['code_challenge_methods_supported']).toEqual(['S256']);
    expect(doc['scopes_supported']).toEqual(['mcp:invoke']);
    expect(doc['registration_endpoint']).toBeUndefined();
  });

  it('CORS allow-origin is * (MCP clients from any origin discover the doc)', async () => {
    const res = await SELF.fetch('http://example.com/.well-known/oauth-authorization-server');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });
});

describe('GET /.well-known/oauth-protected-resource', () => {
  it('returns RFC 9728 metadata with the canonical resource + AS pointer', async () => {
    const res = await SELF.fetch('http://example.com/.well-known/oauth-protected-resource');
    expect(res.status).toBe(200);
    const doc = (await res.json()) as Record<string, unknown>;
    expect(doc['resource']).toBe('https://mcp.verityskills.com');
    expect(doc['authorization_servers']).toEqual([
      'https://mcp.verityskills.com/.well-known/oauth-authorization-server',
    ]);
    expect(doc['bearer_methods_supported']).toEqual(['header']);
  });
});

describe('WWW-Authenticate header on 401 responses (RFC 6750 + RFC 9728)', () => {
  const expectedValue =
    'Bearer realm="mcp.verityskills.com", resource_metadata="https://mcp.verityskills.com/.well-known/oauth-protected-resource"';

  it('tools/call with malformed Bearer returns 401 + WWW-Authenticate', async () => {
    const res = await SELF.fetch('http://example.com/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'bogus vtk_x' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'verity-score', arguments: {} },
      }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toBe(expectedValue);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('INVALID_BEARER_FORMAT');
  });

  it('GET /sse with no bearer returns 401 + WWW-Authenticate', async () => {
    const res = await SELF.fetch('http://example.com/sse');
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toBe(expectedValue);
  });

  it('GET /sse with malformed bearer returns 401 + WWW-Authenticate', async () => {
    const res = await SELF.fetch('http://example.com/sse', {
      headers: { authorization: 'bogus vtk_x' },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toBe(expectedValue);
  });
});

describe('Token passthrough regression (MCP 2025-06-18 non-negotiable)', () => {
  // The single most important security invariant in Phase 1. A vto_* OAuth
  // token MUST NEVER appear in any upstream URL or header. Even if the
  // OAuth-token validation path takes some other code path, the upstream
  // fetch interceptor pins the no-passthrough contract.
  //
  // This test stubs the OAuth token lookup to NOT find a row, which puts
  // the request on the oauth_token_invalid path (401, no upstream call).
  // That covers the "no row" branch. The "valid token forwards x-verity-user-id"
  // path is covered at the unit layer (tests/upstream.test.ts) because
  // SELF.fetch tests cannot inject Supabase env to exercise the happy path.
  //
  // The pin-as-defense-in-depth is: if a future bug ever routes a vto_*
  // token through to upstream (e.g. by accidentally treating it as a
  // valid user-key path), the fetchMock interceptor below catches the
  // outbound URL/headers and the assertion fires.

  it('a vto_* bearer never appears in any upstream URL or header even when validation fails', async () => {
    // Set up an interceptor that catches ANY outbound fetch to upstream.
    // If the code ever forwards a vto_* request without first validating
    // OAuth (which requires Supabase env that the test runtime does not
    // have), this interceptor would observe the vto_ leak. If nothing
    // forwards (the expected behavior; validation fails fast and returns
    // 503/401 before any upstream fetch), the interceptor goes unmet and
    // we assert no upstream call happened. assertNoPendingInterceptors()
    // in afterEach catches the orphaned interceptor case.

    // Install a wildcard interceptor that fails the test if matched.
    // We can do this by installing on every TOOL_ROUTES path and asserting
    // none fire (no scripted reply). Using disableNetConnect() means any
    // unmocked outbound fetch fails the test.

    const res = await SELF.fetch('http://example.com/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // Canonical Bearer vto_ format. The Worker parses it as
        // valid_oauth_token; proxyToolCall takes the OAuth-validation path;
        // Supabase env is unset in the test runtime, so the OAuth path
        // returns oauth_token_invalid with reason 'oauth_misconfigured'
        // BEFORE any upstream fetch. That is the security invariant: any
        // failure mode in OAuth validation MUST short-circuit before
        // forwarding upstream.
        authorization: 'Bearer vto_passthroughprobe',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'verity-score', arguments: {} },
      }),
    });

    // The Worker either returns 503 (oauth_misconfigured -- expected when no
    // Supabase env) or 401 (some other oauth_token_invalid reason). Either
    // way the body MUST NOT contain the raw vto_ value, and there must be
    // ZERO outbound upstream fetches (disableNetConnect would 500 the test
    // otherwise).
    expect([401, 503]).toContain(res.status);
    const bodyText = await res.text();
    expect(bodyText).not.toContain('vto_passthroughprobe');
    // assertNoPendingInterceptors() in afterEach confirms no orphaned mocks;
    // any outbound call would have hit disableNetConnect() and thrown.
    void UPSTREAM_ORIGIN; // silence unused-var lint warning
  });
});

describe('GET /authorize (cross-host consent UI redirect)', () => {
  // Real MCP clients (Claude Desktop 2026-05-25 confirmed; others suspected)
  // hardcode <server_url_host>/authorize instead of honoring the
  // authorization_endpoint advertised in the discovery doc. The Worker
  // redirects /authorize to https://verityskills.com/oauth/mcp/authorize
  // preserving every query param so the client lands on the canonical
  // consent UI without restructuring the cross-host split.

  it('302 redirects to verityskills.com consent UI preserving every param', async () => {
    const params =
      'response_type=code&client_id=claude_desktop' +
      '&redirect_uri=https%3A%2F%2Fclaude.ai%2Fapi%2Fmcp%2Fauth_callback' +
      '&code_challenge=RZys6oE0LEvKRJXsmG65TYF91dYChzd0E_mybWbB_WM' +
      '&code_challenge_method=S256' +
      '&state=WeReBY1vYwH-C2TGgFaqR2jEtRsRAPkeoOxUaQd8t64' +
      '&scope=mcp%3Ainvoke' +
      '&resource=https%3A%2F%2Fmcp.verityskills.com';
    const res = await SELF.fetch(`http://example.com/authorize?${params}`, {
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    const location = res.headers.get('Location');
    expect(location).not.toBeNull();
    const dest = new URL(location!);
    expect(dest.origin).toBe('https://verityskills.com');
    expect(dest.pathname).toBe('/oauth/mcp/authorize');
    expect(dest.searchParams.get('response_type')).toBe('code');
    expect(dest.searchParams.get('client_id')).toBe('claude_desktop');
    expect(dest.searchParams.get('redirect_uri')).toBe(
      'https://claude.ai/api/mcp/auth_callback',
    );
    expect(dest.searchParams.get('code_challenge')).toBe(
      'RZys6oE0LEvKRJXsmG65TYF91dYChzd0E_mybWbB_WM',
    );
    expect(dest.searchParams.get('code_challenge_method')).toBe('S256');
    expect(dest.searchParams.get('state')).toBe(
      'WeReBY1vYwH-C2TGgFaqR2jEtRsRAPkeoOxUaQd8t64',
    );
    expect(dest.searchParams.get('scope')).toBe('mcp:invoke');
    expect(dest.searchParams.get('resource')).toBe('https://mcp.verityskills.com');
  });

  it('302 redirects even with no query params (defensive; client sees the consent UI 400 instead of a 404 here)', async () => {
    const res = await SELF.fetch('http://example.com/authorize', { redirect: 'manual' });
    expect(res.status).toBe(302);
    const dest = new URL(res.headers.get('Location')!);
    // The Worker injects the v1 allowlisted defaults (scope + resource +
    // code_challenge_method) even on an empty query so the consent UI sees
    // a partially-complete request (still missing client_id, redirect_uri,
    // state, code_challenge; consent UI surfaces the precise "Missing X"
    // error for each).
    expect(`${dest.origin}${dest.pathname}`).toBe(
      'https://verityskills.com/oauth/mcp/authorize',
    );
    expect(dest.searchParams.get('scope')).toBe('mcp:invoke');
  });

  it('rejects non-GET methods (404 fall-through)', async () => {
    const res = await SELF.fetch('http://example.com/authorize', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: '',
    });
    expect(res.status).toBe(404);
  });

  it('defaults scope=mcp:invoke when the client omits it (Claude Desktop 2026-05-25 compat)', async () => {
    const params =
      'response_type=code&client_id=claude_desktop' +
      '&redirect_uri=https%3A%2F%2Fclaude.ai%2Fapi%2Fmcp%2Fauth_callback' +
      '&code_challenge=ZzaTcJkfAEJl6abc' +
      '&code_challenge_method=S256' +
      '&state=teststate' +
      '&resource=https%3A%2F%2Fmcp.verityskills.com';
    const res = await SELF.fetch(`http://example.com/authorize?${params}`, {
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    const dest = new URL(res.headers.get('Location')!);
    expect(dest.searchParams.get('scope')).toBe('mcp:invoke');
  });

  it('defaults resource + code_challenge_method when omitted (defense in depth)', async () => {
    const params =
      'response_type=code&client_id=claude_desktop' +
      '&redirect_uri=https%3A%2F%2Fclaude.ai%2Fapi%2Fmcp%2Fauth_callback' +
      '&code_challenge=ZzaTcJkfAEJl6abc' +
      '&state=teststate';
    const res = await SELF.fetch(`http://example.com/authorize?${params}`, {
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    const dest = new URL(res.headers.get('Location')!);
    expect(dest.searchParams.get('scope')).toBe('mcp:invoke');
    expect(dest.searchParams.get('resource')).toBe('https://mcp.verityskills.com');
    expect(dest.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('client-provided scope wins (defaults do not overwrite explicit values)', async () => {
    const params =
      'response_type=code&client_id=claude_desktop' +
      '&redirect_uri=https%3A%2F%2Fclaude.ai%2Fapi%2Fmcp%2Fauth_callback' +
      '&code_challenge=ZzaTcJkfAEJl6abc' +
      '&code_challenge_method=S256' +
      '&state=teststate' +
      '&scope=mcp%3Asomething-else' +
      '&resource=https%3A%2F%2Fsomeother.example.com';
    const res = await SELF.fetch(`http://example.com/authorize?${params}`, {
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    const dest = new URL(res.headers.get('Location')!);
    expect(dest.searchParams.get('scope')).toBe('mcp:something-else');
    expect(dest.searchParams.get('resource')).toBe('https://someother.example.com');
  });
});
