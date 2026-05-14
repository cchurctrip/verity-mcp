// Unit tests for src/upstream.ts.
//
// Covers:
//   - parseDisabledTools / isToolKillSwitched: the per-tool kill switch parser
//     negative-space (empty, single, many, mixed case, whitespace including
//     unicode NBSP / thin space, commas)
//   - isKnownTool: 6 known tools + rejections + type-guard narrowing
//   - buildUpstreamHeaders: x-request-id always set; x-verity-key gated on
//     auth.kind === 'valid'; NEVER a Bearer prefix on x-verity-key (coupling
//     #8); content-type always application/json
//   - rewriteUpgradeUrl: both 402 body shapes, byte-identical preservation,
//     non-mutation, nested upgrade_url left untouched
//   - proxyToolCall: all ProxyOutcome kinds via mocked fetch including
//     network errors (DNS, timeout/AbortError, non-Error throw), 5xx
//     boundary (499 forwards, 500/502/503/504/520/599 all return upstream_5xx
//     with upstream_body preserved), per-tool URL parametrized

import { describe, expect, it } from 'vitest';
import {
  buildUpstreamHeaders,
  isKnownTool,
  isToolKillSwitched,
  parseDisabledTools,
  proxyToolCall,
  rewriteUpgradeUrl,
  TOOL_ROUTES,
  UPGRADE_URL_ABSOLUTE,
} from '../src/upstream';
import type { BearerResult } from '../src/auth';

const REQUEST_ID = '0190b3e8-7f12-7abc-9def-0123456789ab';

function mockResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('parseDisabledTools', () => {
  it('returns empty set when input is undefined', () => {
    expect(parseDisabledTools(undefined).size).toBe(0);
  });

  it('returns empty set when input is empty string', () => {
    expect(parseDisabledTools('').size).toBe(0);
  });

  it('parses a single entry', () => {
    const result = parseDisabledTools('verity-score');
    expect(result.size).toBe(1);
    expect(result.has('verity-score')).toBe(true);
  });

  it('parses multiple comma-separated entries', () => {
    const result = parseDisabledTools('verity-score,morning-brief,disinfo-alert');
    expect(result.size).toBe(3);
    expect(result.has('verity-score')).toBe(true);
    expect(result.has('morning-brief')).toBe(true);
    expect(result.has('disinfo-alert')).toBe(true);
  });

  it('lowercases entries for case-insensitive matching', () => {
    const result = parseDisabledTools('Verity-Score,DISINFO-ALERT');
    expect(result.has('verity-score')).toBe(true);
    expect(result.has('disinfo-alert')).toBe(true);
  });

  it('trims ASCII whitespace around entries', () => {
    const result = parseDisabledTools('  verity-score  ,\tdisinfo-alert\n');
    expect(result.has('verity-score')).toBe(true);
    expect(result.has('disinfo-alert')).toBe(true);
  });

  it('trims unicode whitespace (NBSP U+00A0, thin space U+2009)', () => {
    // JavaScript's String.prototype.trim() strips unicode whitespace.
    // Pin this so a future refactor that hand-rolls trimming catches the
    // regression.
    const NBSP = '\u00a0';
    const THIN = '\u2009';
    const result = parseDisabledTools(`${NBSP}verity-score${NBSP},${THIN}disinfo-alert${THIN}`);
    expect(result.has('verity-score')).toBe(true);
    expect(result.has('disinfo-alert')).toBe(true);
  });

  it('treats whitespace-only entries as empty', () => {
    expect(parseDisabledTools('   ,\t,\n').size).toBe(0);
  });

  it('ignores empty entries from leading, trailing, and consecutive commas', () => {
    const result = parseDisabledTools(',,verity-score,,,disinfo-alert,,');
    expect(result.size).toBe(2);
    expect(result.has('verity-score')).toBe(true);
    expect(result.has('disinfo-alert')).toBe(true);
  });
});

describe('isToolKillSwitched', () => {
  it('returns false when MCP_TOOLS_DISABLED is unset', () => {
    expect(isToolKillSwitched('verity-score', {})).toBe(false);
  });

  it('returns true when the tool is in the disabled list', () => {
    expect(isToolKillSwitched('verity-score', { MCP_TOOLS_DISABLED: 'verity-score' })).toBe(true);
  });

  it('case-insensitive match against the env var', () => {
    expect(isToolKillSwitched('Verity-Score', { MCP_TOOLS_DISABLED: 'verity-score' })).toBe(true);
    expect(isToolKillSwitched('verity-score', { MCP_TOOLS_DISABLED: 'VERITY-SCORE' })).toBe(true);
  });

  it('returns false for tools not in the disabled list', () => {
    expect(
      isToolKillSwitched('morning-brief', { MCP_TOOLS_DISABLED: 'verity-score,disinfo-alert' }),
    ).toBe(false);
  });
});

describe('isKnownTool + TOOL_ROUTES', () => {
  it('TOOL_ROUTES has exactly the 6 spec-named tools', () => {
    const tools = Object.keys(TOOL_ROUTES).sort();
    expect(tools).toEqual([
      'coordination-heat',
      'cross-check-alert',
      'disinfo-alert',
      'morning-brief',
      'verity-scan',
      'verity-score',
    ]);
  });

  it('every tool route is /api/skills/<tool>', () => {
    for (const [name, path] of Object.entries(TOOL_ROUTES)) {
      expect(path).toBe(`/api/skills/${name}`);
    }
  });

  it('isKnownTool returns true for the 6 known tools and false otherwise', () => {
    expect(isKnownTool('coordination-heat')).toBe(true);
    expect(isKnownTool('verity-score')).toBe(true);
    expect(isKnownTool('disinfo-alert')).toBe(true);
    expect(isKnownTool('non-existent')).toBe(false);
    expect(isKnownTool('')).toBe(false);
    // Prototype-pollution check
    expect(isKnownTool('__proto__')).toBe(false);
    expect(isKnownTool('hasOwnProperty')).toBe(false);
  });
});

describe('buildUpstreamHeaders', () => {
  it('always sets content-type application/json regardless of auth kind', () => {
    for (const auth of [
      { kind: 'absent' } as const,
      { kind: 'invalid' } as const,
      { kind: 'valid', token: 'vtk_abc' } as const,
    ]) {
      expect(buildUpstreamHeaders(auth, REQUEST_ID).get('content-type')).toBe('application/json');
    }
  });

  it('sets x-request-id and content-type for absent bearer', () => {
    const headers = buildUpstreamHeaders({ kind: 'absent' }, REQUEST_ID);
    expect(headers.get('x-request-id')).toBe(REQUEST_ID);
    expect(headers.get('x-verity-key')).toBeNull();
  });

  it('sets x-verity-key to the raw token (NO Bearer prefix) when auth is valid', () => {
    // coupling #8: hashApiKey() at lib/apiKeyAuth.ts:15-17 in the main repo
    // SHA-256s the raw token. A Bearer prefix would break hash equality.
    const headers = buildUpstreamHeaders({ kind: 'valid', token: 'vtk_abc123' }, REQUEST_ID);
    expect(headers.get('x-verity-key')).toBe('vtk_abc123');
    expect(headers.get('x-verity-key')?.startsWith('Bearer')).toBe(false);
  });

  it('does NOT set x-verity-key when auth is invalid', () => {
    expect(buildUpstreamHeaders({ kind: 'invalid' }, REQUEST_ID).get('x-verity-key')).toBeNull();
  });

  it('always sets x-request-id regardless of auth kind (coupling #9)', () => {
    expect(buildUpstreamHeaders({ kind: 'absent' }, REQUEST_ID).get('x-request-id')).toBe(REQUEST_ID);
    expect(buildUpstreamHeaders({ kind: 'invalid' }, REQUEST_ID).get('x-request-id')).toBe(REQUEST_ID);
    expect(
      buildUpstreamHeaders({ kind: 'valid', token: 'vtk_abc' }, REQUEST_ID).get('x-request-id'),
    ).toBe(REQUEST_ID);
  });
});

describe('rewriteUpgradeUrl', () => {
  it('does not modify body when status is not 402', () => {
    const body = { code: 'TRIAL_CAP_REACHED', upgrade_url: '/upgrade' };
    expect(rewriteUpgradeUrl(200, body)).toBe(body);
    expect(rewriteUpgradeUrl(401, body)).toBe(body);
    expect(rewriteUpgradeUrl(500, body)).toBe(body);
  });

  it('does not modify body when status is 402 but code is not TRIAL_CAP_REACHED', () => {
    const body = { code: 'OTHER_402_REASON', detail: 'something' };
    expect(rewriteUpgradeUrl(402, body)).toBe(body);
  });

  it('does not modify non-object bodies', () => {
    expect(rewriteUpgradeUrl(402, null)).toBeNull();
    expect(rewriteUpgradeUrl(402, 'string')).toBe('string');
    expect(rewriteUpgradeUrl(402, 42)).toBe(42);
  });

  it('rewrites typical 402 shape with relative upgrade_url (lines 162-171 from main repo)', () => {
    const body = {
      error: 'Trial cap reached',
      code: 'TRIAL_CAP_REACHED',
      upgrade_url: '/upgrade',
      calls_used: 10,
      calls_remaining: 0,
    };
    const result = rewriteUpgradeUrl(402, body) as Record<string, unknown>;
    expect(result['upgrade_url']).toBe(UPGRADE_URL_ABSOLUTE);
    expect(result['error']).toBe('Trial cap reached');
    expect(result['code']).toBe('TRIAL_CAP_REACHED');
    expect(result['calls_used']).toBe(10);
    expect(result['calls_remaining']).toBe(0);
  });

  it('rewrites secondary-gate 402 shape WITHOUT upgrade_url (lines 187-190 from main repo)', () => {
    // No upgrade_url field on the input; rewrite injects it.
    const body = {
      error: 'TRIAL_CAP_REACHED',
      code: 'TRIAL_CAP_REACHED',
      cap: 10,
      used: 10,
    };
    const result = rewriteUpgradeUrl(402, body) as Record<string, unknown>;
    expect(result['upgrade_url']).toBe(UPGRADE_URL_ABSOLUTE);
    expect(result['cap']).toBe(10);
    expect(result['used']).toBe(10);
    expect(result['code']).toBe('TRIAL_CAP_REACHED');
  });

  it('returns a new object reference (immutable input)', () => {
    const body = { code: 'TRIAL_CAP_REACHED', other: 'data' };
    const result = rewriteUpgradeUrl(402, body);
    expect(result).not.toBe(body);
    expect((body as Record<string, unknown>)['upgrade_url']).toBeUndefined();
  });

  it('does NOT touch nested upgrade_url fields (top-level rewrite only)', () => {
    const body = {
      code: 'TRIAL_CAP_REACHED',
      details: { upgrade_url: '/inner-should-stay' },
    };
    const result = rewriteUpgradeUrl(402, body) as Record<string, unknown>;
    expect(result['upgrade_url']).toBe(UPGRADE_URL_ABSOLUTE);
    expect((result['details'] as Record<string, unknown>)['upgrade_url']).toBe('/inner-should-stay');
  });

  it('only adds the upgrade_url key (no extraneous keys)', () => {
    const body = { code: 'TRIAL_CAP_REACHED', cap: 10, used: 10 };
    const result = rewriteUpgradeUrl(402, body) as Record<string, unknown>;
    expect(Object.keys(result).sort()).toEqual(['cap', 'code', 'upgrade_url', 'used']);
  });
});

describe('proxyToolCall', () => {
  const validAuth: BearerResult = { kind: 'valid', token: 'vtk_abc123' };
  const absentAuth: BearerResult = { kind: 'absent' };
  const invalidAuth: BearerResult = { kind: 'invalid' };

  it('returns tool_disabled for kill-switched tools', async () => {
    const fetchSpy = async () => mockResponse(200, {});
    const result = await proxyToolCall(
      'verity-score',
      {},
      validAuth,
      REQUEST_ID,
      { MCP_TOOLS_DISABLED: 'verity-score' },
      fetchSpy,
    );
    expect(result).toEqual({ kind: 'tool_disabled', tool: 'verity-score' });
  });

  it('returns unknown_tool for tools not in TOOL_ROUTES', async () => {
    const fetchSpy = async () => mockResponse(200, {});
    const result = await proxyToolCall(
      'made-up-tool',
      {},
      validAuth,
      REQUEST_ID,
      {},
      fetchSpy,
    );
    expect(result).toEqual({ kind: 'unknown_tool', tool: 'made-up-tool' });
  });

  it('returns bearer_invalid when auth.kind === invalid', async () => {
    const fetchSpy = async () => mockResponse(200, {});
    const result = await proxyToolCall(
      'verity-score',
      {},
      invalidAuth,
      REQUEST_ID,
      {},
      fetchSpy,
    );
    expect(result).toEqual({ kind: 'bearer_invalid' });
  });

  it('forwards a valid bearer with x-verity-key (no Bearer prefix)', async () => {
    let capturedHeaders: Headers | undefined;
    const fetchSpy = async (_url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      capturedHeaders = init?.headers as Headers;
      return mockResponse(200, { ok: true });
    };
    await proxyToolCall('verity-score', { ticker: 'AAPL' }, validAuth, REQUEST_ID, {}, fetchSpy);
    expect(capturedHeaders?.get('x-verity-key')).toBe('vtk_abc123');
    expect(capturedHeaders?.get('x-request-id')).toBe(REQUEST_ID);
    expect(capturedHeaders?.get('x-verity-key')?.startsWith('Bearer')).toBe(false);
  });

  it('forwards an absent bearer WITHOUT x-verity-key (anonymous path)', async () => {
    let capturedHeaders: Headers | undefined;
    const fetchSpy = async (_url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      capturedHeaders = init?.headers as Headers;
      return mockResponse(200, { ok: true });
    };
    await proxyToolCall('coordination-heat', {}, absentAuth, REQUEST_ID, {}, fetchSpy);
    expect(capturedHeaders?.get('x-verity-key')).toBeNull();
    expect(capturedHeaders?.get('x-request-id')).toBe(REQUEST_ID);
  });

  it('forwards 2xx upstream response verbatim', async () => {
    const fetchSpy = async () => mockResponse(200, { score: 0.95 });
    const result = await proxyToolCall('verity-score', { ticker: 'AAPL' }, validAuth, REQUEST_ID, {}, fetchSpy);
    expect(result.kind).toBe('forward');
    if (result.kind === 'forward') {
      expect(result.status).toBe(200);
      expect(result.body).toEqual({ score: 0.95 });
    }
  });

  it('forwards 401 verbatim (upstream auth denial)', async () => {
    const fetchSpy = async () => mockResponse(401, { error: 'invalid api key' });
    const result = await proxyToolCall('verity-score', {}, validAuth, REQUEST_ID, {}, fetchSpy);
    expect(result.kind).toBe('forward');
    if (result.kind === 'forward') expect(result.status).toBe(401);
  });

  it('forwards 403 verbatim (upstream tier denial)', async () => {
    const fetchSpy = async () => mockResponse(403, { error: 'requires Pro tier' });
    const result = await proxyToolCall('verity-scan', {}, validAuth, REQUEST_ID, {}, fetchSpy);
    expect(result.kind).toBe('forward');
    if (result.kind === 'forward') expect(result.status).toBe(403);
  });

  it('forwards 499 verbatim (boundary check: 499 must NOT trigger 5xx path)', async () => {
    const fetchSpy = async () => mockResponse(499, { error: 'client closed' });
    const result = await proxyToolCall('verity-score', {}, validAuth, REQUEST_ID, {}, fetchSpy);
    expect(result.kind).toBe('forward');
    if (result.kind === 'forward') expect(result.status).toBe(499);
  });

  it('rewrites 402 typical shape with absolute upgrade_url', async () => {
    const fetchSpy = async () =>
      mockResponse(402, {
        error: 'Trial cap reached',
        code: 'TRIAL_CAP_REACHED',
        upgrade_url: '/upgrade',
        calls_used: 10,
        calls_remaining: 0,
      });
    const result = await proxyToolCall('verity-score', {}, validAuth, REQUEST_ID, {}, fetchSpy);
    expect(result.kind).toBe('forward');
    if (result.kind === 'forward') {
      expect(result.status).toBe(402);
      const body = result.body as Record<string, unknown>;
      expect(body['upgrade_url']).toBe(UPGRADE_URL_ABSOLUTE);
      expect(body['calls_used']).toBe(10);
    }
  });

  it('rewrites 402 secondary-gate shape (cap, used, no upgrade_url) by injecting upgrade_url', async () => {
    const fetchSpy = async () =>
      mockResponse(402, { error: 'TRIAL_CAP_REACHED', code: 'TRIAL_CAP_REACHED', cap: 10, used: 10 });
    const result = await proxyToolCall('verity-score', {}, validAuth, REQUEST_ID, {}, fetchSpy);
    expect(result.kind).toBe('forward');
    if (result.kind === 'forward') {
      const body = result.body as Record<string, unknown>;
      expect(body['upgrade_url']).toBe(UPGRADE_URL_ABSOLUTE);
      expect(body['cap']).toBe(10);
      expect(body['used']).toBe(10);
    }
  });

  // 5xx boundary parametrized: catches off-by-one regressions in the `>= 500`
  // gate. Cloudflare 520-527 (upstream from Vercel edge) is in particular a
  // realistic production failure mode.
  const fiveXxCases: Array<[number]> = [[500], [502], [503], [504], [520], [599]];
  it.each(fiveXxCases)('returns upstream_5xx on %d with upstream_body preserved', async (status) => {
    const upstreamBody = { error: 'maintenance', detail: 'planned downtime' };
    const fetchSpy = async () => mockResponse(status, upstreamBody);
    const result = await proxyToolCall('verity-score', {}, validAuth, REQUEST_ID, {}, fetchSpy);
    expect(result.kind).toBe('upstream_5xx');
    if (result.kind === 'upstream_5xx') {
      expect(result.upstreamStatus).toBe(status);
      expect(result.upstreamBody).toEqual(upstreamBody);
      expect(result.cause).toContain(String(status));
    }
  });

  it('returns upstream_network_error on TypeError (DNS/TLS failure)', async () => {
    const fetchSpy = async () => {
      throw new TypeError('connect ECONNREFUSED');
    };
    const result = await proxyToolCall('verity-score', {}, validAuth, REQUEST_ID, {}, fetchSpy);
    expect(result.kind).toBe('upstream_network_error');
    if (result.kind === 'upstream_network_error') {
      expect(result.errorName).toBe('TypeError');
      expect(result.cause).toContain('ECONNREFUSED');
    }
  });

  it('returns upstream_network_error on AbortError (AbortSignal.timeout)', async () => {
    const fetchSpy = async () => {
      const err = new DOMException('signal aborted by timeout', 'TimeoutError');
      throw err;
    };
    const result = await proxyToolCall('verity-score', {}, validAuth, REQUEST_ID, {}, fetchSpy);
    expect(result.kind).toBe('upstream_network_error');
    if (result.kind === 'upstream_network_error') {
      expect(result.errorName).toBe('TimeoutError');
    }
  });

  it('returns upstream_network_error on non-Error throw (defensive coercion)', async () => {
    const fetchSpy = async () => {
      // Intentional non-Error throw: tests defensive coercion in catch block.
      throw 'string error not wrapped in Error';
    };
    const result = await proxyToolCall('verity-score', {}, validAuth, REQUEST_ID, {}, fetchSpy);
    expect(result.kind).toBe('upstream_network_error');
    if (result.kind === 'upstream_network_error') {
      expect(result.errorName).toBe('NonError');
      expect(result.cause).toBe('string error not wrapped in Error');
    }
  });

  it('sends the body as JSON-stringified params', async () => {
    let capturedBody: BodyInit | undefined;
    const fetchSpy = async (_url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      capturedBody = init?.body ?? undefined;
      return mockResponse(200, {});
    };
    await proxyToolCall(
      'verity-score',
      { ticker: 'AAPL', depth: 3 },
      validAuth,
      REQUEST_ID,
      {},
      fetchSpy,
    );
    expect(capturedBody).toBe(JSON.stringify({ ticker: 'AAPL', depth: 3 }));
  });

  // Parametrized per-tool URL construction. Each of the 6 tools must land
  // at the correct upstream skill route. The previous coverage was a single
  // disinfo-alert test; this catches per-tool routing typos.
  it.each(Object.entries(TOOL_ROUTES))(
    'proxies %s to https://verityskills.com%s',
    async (tool, path) => {
      let capturedUrl = '';
      const fetchSpy = async (url: RequestInfo | URL): Promise<Response> => {
        capturedUrl = typeof url === 'string' ? url : url.toString();
        return mockResponse(200, {});
      };
      await proxyToolCall(tool, {}, validAuth, REQUEST_ID, {}, fetchSpy);
      expect(capturedUrl).toBe(`https://verityskills.com${path}`);
    },
  );
});
