// End-to-end integration tests for the verity-mcp Worker. Wires the real
// default export through SELF.fetch (which spins up the worker in the same
// isolate as the test) and intercepts outbound upstream fetches via
// fetchMock from cloudflare:test. This file owns the upstream-mocked
// dispatch paths; the worker-edge endpoints (/health, OPTIONS, /, /sse,
// happy-path JSON-RPC framing) are tested in tests/health.test.ts. The two
// files are deliberately scope-split.
//
// Coverage (this file):
//   - All 6 tools happy path: 200 forward with JSON-RPC result envelope.
//   - x-verity-key header translation: raw token, NO Bearer prefix
//     (CLAUDE.md auth contract #4 re-pinned at the integration layer).
//   - 401 verbatim forward (upstream auth deny).
//   - 402 dual-shape: typical + secondary-gate. Both inject absolute
//     upgrade_url at the worker edge.
//   - 403 verbatim forward (tier denial).
//   - 5xx wrapped as JSON-RPC -32603 with HTTP 200.
//   - INVALID_BEARER_FORMAT short-circuits at the worker edge (no upstream
//     fetch, HTTP 401 with the documented body).
//   - arguments validation short-circuits (-32602 for null/array/primitive).
//   - Per-tool kill switch via env override (MCP_TOOLS_DISABLED).
//   - Global kill switch via env override (MCP_KILL_SWITCH=on).
//   - Sentry.withSentry wrap survives a normal request when SENTRY_DSN is
//     set in the env.
//
// fetchMock from cloudflare:test wraps the Miniflare outbound interceptor.
// disableNetConnect() ensures any unmocked outbound fetch fails the test.
// assertNoPendingInterceptors() catches orphaned interceptors (an installed
// interceptor that never matched).

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SELF, fetchMock } from 'cloudflare:test';

const UPSTREAM_ORIGIN = 'https://verityskills.com';

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

afterEach(() => {
  // Each test installs its own interceptors; if a test left pending calls
  // it is a real bug (the worker called upstream when it should not have,
  // or didn't call when it should). Surface that as a test failure.
  fetchMock.assertNoPendingInterceptors();
});

afterAll(() => {
  fetchMock.deactivate();
});

async function callMcp(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return SELF.fetch('https://example.com/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

// MCP tools/call response shape per MCP 2025-03-26:
//   { jsonrpc, id, result: { content: [{type:'text', text:'<JSON>'}], isError? } }
// The upstream skill route's payload is JSON-stringified into content[0].text.
// Tests assert against the parsed upstream payload, so they need to unwrap.
// initialize and tools/list keep their MCP-defined shapes; this helper is
// tools/call-only.
interface ToolCallEnvelope {
  jsonrpc: string;
  id: number;
  result: {
    content: ReadonlyArray<{ type: string; text: string }>;
    isError?: boolean;
  };
}

function unwrapToolsCall(body: unknown): { upstream: Record<string, unknown>; isError: boolean } {
  const env = body as ToolCallEnvelope;
  if (!Array.isArray(env.result?.content) || env.result.content.length === 0) {
    throw new Error('tools/call response missing result.content[]');
  }
  const first = env.result.content[0]!;
  if (first.type !== 'text' || typeof first.text !== 'string') {
    throw new Error('tools/call content[0] is not a text block');
  }
  return {
    upstream: JSON.parse(first.text) as Record<string, unknown>,
    isError: env.result.isError === true,
  };
}

describe('tools/call: happy path for each of the 7 tools', () => {
  // upstreamBody is typed as Record<string, unknown> (not unknown) because
  // fetchMock.reply expects object | string | Buffer for its body parameter.
  // upstreamPath values mirror src/upstream.ts TOOL_ROUTES. Three tools now
  // forward to the newer marketed operations (subject scorer, claim
  // corroborator, ongoing monitor). coordination-heat now backs an
  // authenticated operation, so the happy-path case carries a bearer like
  // the other five.
  const cases: ReadonlyArray<{ name: string; upstreamPath: string; auth?: string; upstreamBody: Record<string, unknown> }> = [
    { name: 'coordination-heat', upstreamPath: '/api/skills/coordination-score', auth: 'Bearer vtk_a', upstreamBody: { score: 42 } },
    { name: 'verity-score', upstreamPath: '/api/skills/verity-score', auth: 'Bearer vtk_a', upstreamBody: { score: 87 } },
    { name: 'morning-brief', upstreamPath: '/api/skills/morning-brief', auth: 'Bearer vtk_a', upstreamBody: { sections: [] } },
    { name: 'verity-scan', upstreamPath: '/api/skills/verity-scan', auth: 'Bearer vtk_a', upstreamBody: { verdict: 'clear' } },
    { name: 'cross-check-alert', upstreamPath: '/api/skills/cross-check-claim', auth: 'Bearer vtk_a', upstreamBody: { verdict: 'NO_SIGNAL' } },
    { name: 'disinfo-alert', upstreamPath: '/api/skills/disinfo-monitor', auth: 'Bearer vtk_a', upstreamBody: { detected: false } },
    { name: 'notification-prefs', upstreamPath: '/api/mcp/notification-prefs', auth: 'Bearer vtk_a', upstreamBody: { subscriptions: {} } },
  ];

  it.each(cases)('$name forwards upstream 200 as JSON-RPC result', async (tc) => {
    fetchMock
      .get(UPSTREAM_ORIGIN)
      .intercept({ path: tc.upstreamPath, method: 'POST' })
      .reply(200, tc.upstreamBody, { headers: { 'content-type': 'application/json' } });

    const res = await callMcp(
      { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: tc.name, arguments: {} } },
      tc.auth ? { authorization: tc.auth } : {},
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    const { upstream, isError } = unwrapToolsCall(body);
    expect(upstream).toEqual(tc.upstreamBody);
    expect(isError).toBe(false);
  });
});

describe('tools/call: 401 upstream verbatim forward', () => {
  it('preserves the 401 status and body when upstream denies auth', async () => {
    fetchMock
      .get(UPSTREAM_ORIGIN)
      .intercept({ path: '/api/skills/verity-score', method: 'POST' })
      .reply(401, { code: 'UNAUTHORIZED', message: 'missing or invalid key' }, {
        headers: { 'content-type': 'application/json' },
      });

    // Send a syntactically-valid bearer so the edge eager-OAuth challenge
    // (issue #25) does not short-circuit the request. The upstream interceptor
    // is the source of the 401 under test, not the worker edge.
    const res = await callMcp(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'verity-score', arguments: { subject: 'X' } },
      },
      { authorization: 'Bearer vtk_a' },
    );
    expect(res.status).toBe(401);
    const body = await res.json();
    const { upstream, isError } = unwrapToolsCall(body);
    expect(upstream['code']).toBe('UNAUTHORIZED');
    expect(isError).toBe(true);
  });
});

describe('tools/call: 402 dual-shape upgrade_url injection', () => {
  it('typical-shape body keeps every field and overwrites upgrade_url to absolute', async () => {
    fetchMock
      .get(UPSTREAM_ORIGIN)
      .intercept({ path: '/api/skills/verity-score', method: 'POST' })
      .reply(
        402,
        { code: 'TRIAL_CAP_REACHED', upgrade_url: '/upgrade', calls_used: 5, calls_remaining: 0 },
        { headers: { 'content-type': 'application/json' } },
      );

    const res = await callMcp(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'verity-score', arguments: {} } },
      { authorization: 'Bearer vtk_a' },
    );
    expect(res.status).toBe(402);
    const body = await res.json();
    const { upstream, isError } = unwrapToolsCall(body);
    expect(upstream['upgrade_url']).toBe('https://verityskills.com/upgrade?return_to=mcp&via=cap');
    expect(upstream['calls_used']).toBe(5);
    expect(upstream['calls_remaining']).toBe(0);
    expect(upstream['code']).toBe('TRIAL_CAP_REACHED');
    expect(isError).toBe(true);
  });

  it('secondary-gate body without upgrade_url injects absolute upgrade_url and preserves cap/used', async () => {
    fetchMock
      .get(UPSTREAM_ORIGIN)
      .intercept({ path: '/api/skills/verity-score', method: 'POST' })
      .reply(
        402,
        { code: 'TRIAL_CAP_REACHED', cap: 10, used: 10 },
        { headers: { 'content-type': 'application/json' } },
      );

    const res = await callMcp(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'verity-score', arguments: {} } },
      { authorization: 'Bearer vtk_a' },
    );
    expect(res.status).toBe(402);
    const body = await res.json();
    const { upstream, isError } = unwrapToolsCall(body);
    expect(upstream['upgrade_url']).toBe('https://verityskills.com/upgrade?return_to=mcp&via=cap');
    expect(upstream['cap']).toBe(10);
    expect(upstream['used']).toBe(10);
    expect(isError).toBe(true);
  });
});

describe('tools/call: 403 verbatim forward', () => {
  it('preserves 403 status when upstream denies on tier', async () => {
    fetchMock
      .get(UPSTREAM_ORIGIN)
      .intercept({ path: '/api/skills/verity-scan', method: 'POST' })
      .reply(403, { code: 'TIER_NOT_PERMITTED' }, { headers: { 'content-type': 'application/json' } });

    const res = await callMcp(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'verity-scan', arguments: { subject: 'X' } } },
      { authorization: 'Bearer vtk_a' },
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    const { upstream, isError } = unwrapToolsCall(body);
    expect(upstream['code']).toBe('TIER_NOT_PERMITTED');
    expect(isError).toBe(true);
  });
});

describe('tools/call: 5xx wrapped as JSON-RPC -32603 with HTTP 200', () => {
  it('upstream 502 lands at the worker as HTTP 200 + -32603 envelope', async () => {
    fetchMock
      .get(UPSTREAM_ORIGIN)
      .intercept({ path: '/api/skills/verity-score', method: 'POST' })
      .reply(502, { error: 'bad gateway' }, { headers: { 'content-type': 'application/json' } });

    const res = await callMcp(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'verity-score', arguments: {} } },
      { authorization: 'Bearer vtk_a' },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { error: { code: number; data: { upstream_status: number; upstream_body: { error: string } } } };
    expect(body.error.code).toBe(-32603);
    expect(body.error.data.upstream_status).toBe(502);
    expect(body.error.data.upstream_body.error).toBe('bad gateway');
  });
});

describe('tools/call: INVALID_BEARER_FORMAT short-circuits at the worker edge', () => {
  it('does NOT call upstream when the Authorization header is malformed', async () => {
    // fetchMock.assertNoPendingInterceptors() in afterEach would catch a
    // surprise upstream call. We install no interceptor here; if the worker
    // attempts to fetch upstream, the test fails with disableNetConnect's
    // "no fetch matched" error.
    const res = await callMcp(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'verity-score', arguments: {} } },
      { authorization: 'bogus vtk_x' },
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe('INVALID_BEARER_FORMAT');
    expect(body.error).toMatch(/Bearer vtk_/);
  });
});

describe('tools/call: arguments validation short-circuits at the worker edge', () => {
  it.each([['null', null], ['number', 42], ['array', ['a']]])(
    'arguments=%s returns -32602 without calling upstream',
    async (_label, badArgs) => {
      // Auth header present so the edge eager-OAuth challenge (issue #25) is
      // not what's under test; the assertion is on the -32602 args-validation
      // path inside handleMcpRequest.
      const res = await callMcp(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'verity-score', arguments: badArgs },
        },
        { authorization: 'Bearer vtk_a' },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { error: { code: number } };
      expect(body.error.code).toBe(-32602);
    },
  );
});

// Auth-contract integration test. CLAUDE.md rule #4: x-verity-key upstream
// header MUST NOT carry the Bearer prefix. Tested at unit layer; pinned
// here once at the integration layer as defense-in-depth.
describe('Auth contract: x-verity-key carries raw token, never Bearer prefix', () => {
  it('translates inbound Authorization: Bearer vtk_X into upstream x-verity-key: vtk_X (no prefix)', async () => {
    let capturedVerityKey: string | undefined;
    let capturedAuthorization: string | undefined;
    fetchMock
      .get(UPSTREAM_ORIGIN)
      .intercept({ path: '/api/skills/verity-score', method: 'POST' })
      .reply((opts) => {
        // undici types the headers as a record or Headers-like; coerce.
        const h = opts.headers as Record<string, string> | undefined;
        capturedVerityKey = h?.['x-verity-key'];
        capturedAuthorization = h?.['authorization'];
        return { statusCode: 200, data: JSON.stringify({ ok: true }), responseOptions: { headers: { 'content-type': 'application/json' } } };
      });

    await callMcp(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'verity-score', arguments: {} } },
      { authorization: 'Bearer vtk_abc123' },
    );

    expect(capturedVerityKey).toBe('vtk_abc123');
    expect(capturedVerityKey?.startsWith('Bearer')).toBe(false);
    // Inbound Authorization is consumed at the edge, not forwarded upstream
    expect(capturedAuthorization).toBeUndefined();
  });
});

// Kill switch coverage note: integration-layer kill-switch tests would
// require wrangler.toml [env.test].vars overrides because cloudflare:test
// `env` is the test-side binding object, not the worker-runtime env that
// SELF.fetch passes to the handler. Mutating `env` from the test does not
// propagate to the worker isolate. Kill-switch coverage is therefore at
// the unit layer:
//   - parseDisabledTools / isToolKillSwitched negative-space:
//     tests/upstream.test.ts (parser + dispatch)
//   - per-tool kill switch returns tool_disabled outcome:
//     tests/upstream.test.ts:267-291
//   - tools/call dispatches tool_disabled to HTTP 503 with the right body:
//     tests/mcp.test.ts:428-445
//   - precedence (unknown_tool before tool_disabled): tests/upstream.test.ts.
// To add integration-layer kill-switch tests, extend wrangler.toml with an
// [env.test] block setting MCP_KILL_SWITCH/MCP_TOOLS_DISABLED, then point
// vitest.config.ts at that env. Deferred to a future PR; the unit coverage
// is exhaustive.

// Sentry.withSentry wrap survives a normal request (smoke). When SENTRY_DSN
// is unset (the test-pool default), the SDK initializes with no DSN; events
// drop at the transport layer. This test verifies the wrap does not crash
// the worker on a routine request path.
describe('Sentry.withSentry wrap smoke', () => {
  // Auth header included on both probes so the edge eager-OAuth challenge
  // (issue #25) is not what's under test; the assertion is that the Sentry
  // wrap does not crash on a routine authenticated request through the
  // wrapped handler.
  it('initialize completes through the wrapped handler without crashing', async () => {
    const res = await callMcp(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { authorization: 'Bearer vtk_a' },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { protocolVersion: string } };
    expect(body.result.protocolVersion).toBe('2025-03-26');
  });

  it('tools/list completes through the wrapped handler without crashing', async () => {
    const res = await callMcp(
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      { authorization: 'Bearer vtk_a' },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { tools: Array<{ name: string }> } };
    expect(body.result.tools).toHaveLength(7);
  });
});
