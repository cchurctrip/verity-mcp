// Unit tests for src/mcp.ts.
//
// Covers:
//   - validateEnvelope: every -32600 path enumerated (non-object, array,
//     missing jsonrpc, wrong jsonrpc, missing id, wrong-type id, missing
//     method, non-string method). Plus the happy-path classifier.
//   - buildInitializeResult: byte-identical pinned result (Gate 2 BLOCKING #3).
//   - buildToolsListResult: 6 tools, fixed order, every entry has the four
//     advertised fields, requiresAuth matches manifest.json.
//   - outcomeToResponse: every ProxyOutcome kind mapped to its documented
//     HTTP status + body shape.
//   - handleMcpRequest: full IO orchestration. Parse error (-32700). Invalid
//     envelope (-32600). Unknown method (-32601). initialize round-trip with
//     echoed id. tools/list round-trip. tools/call dispatches through a
//     mocked upstream and threads the request_id and bearer correctly.

import { describe, expect, it } from 'vitest';
import {
  buildInitializeResult,
  buildToolsListResult,
  handleMcpRequest,
  outcomeToResponse,
  PROTOCOL_VERSION,
  SERVER_INFO,
  validateEnvelope,
} from '../src/mcp';
import type { ProxyOutcome } from '../src/upstream';
import { TOOLS } from '../src/tools';

function jsonRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('https://mcp.verityskills.com/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function rawBodyRequest(raw: string, headers: Record<string, string> = {}): Request {
  return new Request('https://mcp.verityskills.com/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: raw,
  });
}

describe('validateEnvelope', () => {
  it('accepts a canonical envelope', () => {
    const r = validateEnvelope({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    expect(r.kind).toBe('valid');
    if (r.kind === 'valid') {
      expect(r.envelope).toEqual({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    }
  });

  it('accepts string id', () => {
    const r = validateEnvelope({ jsonrpc: '2.0', id: 'req-1', method: 'tools/list', params: {} });
    expect(r.kind).toBe('valid');
  });

  it('accepts null id', () => {
    const r = validateEnvelope({ jsonrpc: '2.0', id: null, method: 'tools/list', params: {} });
    expect(r.kind).toBe('valid');
  });

  it('accepts envelope with omitted params (params becomes undefined)', () => {
    const r = validateEnvelope({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    expect(r.kind).toBe('valid');
    if (r.kind === 'valid') {
      expect(r.envelope.params).toBeUndefined();
    }
  });

  it.each([
    ['not an object', 'string body'],
    ['array body', [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }]],
    ['null', null],
    ['number', 42],
    ['boolean', true],
  ])('rejects non-object envelope (%s)', (_label, body) => {
    expect(validateEnvelope(body).kind).toBe('invalid');
  });

  it('rejects missing jsonrpc', () => {
    expect(validateEnvelope({ id: 1, method: 'tools/list' }).kind).toBe('invalid');
  });

  it('rejects jsonrpc !== "2.0"', () => {
    expect(validateEnvelope({ jsonrpc: '1.0', id: 1, method: 'tools/list' }).kind).toBe('invalid');
    expect(validateEnvelope({ jsonrpc: 2.0, id: 1, method: 'tools/list' }).kind).toBe('invalid');
  });

  it('rejects missing id', () => {
    expect(validateEnvelope({ jsonrpc: '2.0', method: 'tools/list' }).kind).toBe('invalid');
  });

  it('rejects wrong-type id', () => {
    expect(validateEnvelope({ jsonrpc: '2.0', id: { nested: 1 }, method: 'tools/list' }).kind).toBe('invalid');
    expect(validateEnvelope({ jsonrpc: '2.0', id: true, method: 'tools/list' }).kind).toBe('invalid');
    expect(validateEnvelope({ jsonrpc: '2.0', id: [1], method: 'tools/list' }).kind).toBe('invalid');
  });

  it('rejects missing method', () => {
    expect(validateEnvelope({ jsonrpc: '2.0', id: 1 }).kind).toBe('invalid');
  });

  it('rejects non-string method', () => {
    expect(validateEnvelope({ jsonrpc: '2.0', id: 1, method: 42 }).kind).toBe('invalid');
    expect(validateEnvelope({ jsonrpc: '2.0', id: 1, method: null }).kind).toBe('invalid');
    expect(validateEnvelope({ jsonrpc: '2.0', id: 1, method: ['tools/list'] }).kind).toBe('invalid');
  });

  it('recovers id on invalid envelope when id is well-typed', () => {
    const r = validateEnvelope({ jsonrpc: 'wrong', id: 42, method: 'tools/list' });
    if (r.kind === 'invalid') expect(r.id).toBe(42);
    else throw new Error('expected invalid');
  });

  it('returns null id on invalid envelope when id is malformed', () => {
    const r = validateEnvelope({ jsonrpc: 'wrong', id: { wat: 1 }, method: 'tools/list' });
    if (r.kind === 'invalid') expect(r.id).toBeNull();
    else throw new Error('expected invalid');
  });
});

describe('buildInitializeResult', () => {
  it('is byte-identical to the locked Gate 2 BLOCKING #3 shape', () => {
    // The structural assertion catches added keys, renamed keys, or value
    // drift. Updating any of these is a marketplace consumer break.
    expect(buildInitializeResult()).toEqual({
      protocolVersion: '2025-03-26',
      capabilities: { tools: {} },
      serverInfo: { name: 'verity-mcp', version: '1.0.0' },
    });
  });

  it('keeps PROTOCOL_VERSION matching the manifest mcp_spec_version', async () => {
    const manifest = await import('../manifest.json');
    expect(PROTOCOL_VERSION).toBe(manifest.default.mcp_spec_version);
  });

  it('keeps SERVER_INFO matching the manifest name and version', async () => {
    const manifest = await import('../manifest.json');
    expect(SERVER_INFO.name).toBe(manifest.default.name);
    expect(SERVER_INFO.version).toBe(manifest.default.version);
  });
});

describe('buildToolsListResult', () => {
  it('returns 6 tools in fixed order', () => {
    const { tools } = buildToolsListResult();
    expect(tools).toHaveLength(6);
    expect(tools.map((t) => t.name)).toEqual([
      'coordination-heat',
      'verity-score',
      'morning-brief',
      'verity-scan',
      'cross-check-alert',
      'disinfo-alert',
    ]);
  });

  it('every entry has the four required fields, plus optional outputSchema, and nothing else', () => {
    const { tools } = buildToolsListResult();
    const ALLOWED_KEYS = new Set(['description', 'inputSchema', 'name', 'requiresAuth', 'outputSchema']);
    for (const t of tools) {
      // No unknown fields (catches a future field that should not surface).
      for (const k of Object.keys(t)) {
        expect(ALLOWED_KEYS.has(k), `unexpected key ${k} on tool ${t.name}`).toBe(true);
      }
      // The four required fields are always present.
      expect(typeof t.name).toBe('string');
      expect(typeof t.description).toBe('string');
      expect(typeof t.inputSchema).toBe('object');
      expect(typeof t.requiresAuth).toBe('boolean');
      // outputSchema is optional. When present it is an object.
      if ('outputSchema' in t) {
        expect(typeof t.outputSchema).toBe('object');
      }
    }
  });

  it('outputSchema flows through to tools/list on the 3 VRT-160 tools', () => {
    const { tools } = buildToolsListResult();
    const withOutputSchema = tools.filter((t) => 'outputSchema' in t).map((t) => t.name);
    // Per VRT-160 + the source-of-truth assertion in tests/manifest.snapshot.test.ts.
    expect([...withOutputSchema].sort()).toEqual(['morning-brief', 'verity-scan', 'verity-score']);
  });

  it('outputSchema is absent on the 3 tools that did not declare one (no spurious empty object)', () => {
    const { tools } = buildToolsListResult();
    const noOutputSchema = tools.filter((t) => !('outputSchema' in t)).map((t) => t.name);
    expect([...noOutputSchema].sort()).toEqual(['coordination-heat', 'cross-check-alert', 'disinfo-alert']);
  });

  it('every outputSchema has `type: "object"` at the ROOT (MCP SDK ToolSchema requires this literal; #25 part 8)', () => {
    // The official @modelcontextprotocol/sdk ToolSchema (Zod) declares
    // `outputSchema.type = literal("object")`. mcp-remote, Cursor 1.x, and
    // Claude Desktop all parse tools/list with this schema and DROP the
    // entire response if any tool's outputSchema fails validation -- the
    // client then surfaces zero tools even though the connection is
    // healthy. The discriminator may sit at the root alongside `type`
    // (`.catchall(unknown())` lets `oneOf` / `anyOf` pass through), but
    // `type: "object"` MUST be present. A 2026-05-26 deploy that
    // omitted `type` on verity-score's outputSchema caused exactly this
    // failure end-to-end despite a fully working OAuth chain.
    const { tools } = buildToolsListResult();
    for (const t of tools) {
      if (!('outputSchema' in t)) continue;
      const schema = t.outputSchema as Record<string, unknown>;
      expect(
        schema['type'],
        `tool ${t.name}: outputSchema.type must be literal "object" (MCP SDK requirement)`,
      ).toBe('object');
    }
  });

  it('does NOT expose upstreamPath through tools/list (proxy detail stays internal)', () => {
    const { tools } = buildToolsListResult();
    for (const t of tools) {
      expect(t).not.toHaveProperty('upstreamPath');
    }
  });

  it('requiresAuth values match manifest.json', async () => {
    const manifest = await import('../manifest.json');
    const manifestByName = Object.fromEntries(
      manifest.default.tools.map((t) => [t.name, t.requires_auth] as const),
    );
    for (const t of TOOLS) {
      expect(t.requiresAuth).toBe(manifestByName[t.name]);
    }
  });
});

describe('outcomeToResponse', () => {
  const id = 7;

  it('forward wraps upstream 2xx body in MCP content envelope, no isError', () => {
    const outcome: ProxyOutcome = { kind: 'forward', status: 200, body: { ok: true }, upstreamStatus: 200 };
    expect(outcomeToResponse(outcome, id)).toEqual({
      body: {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: JSON.stringify({ ok: true }) }],
        },
      },
      status: 200,
    });
  });

  it('forward attaches WWW-Authenticate on upstream 401 (RFC 6750 §3; lazy-OAuth trigger for Claude Desktop et al)', () => {
    // Pre-fix: anonymous tools/call against an auth-required tool
    // (coordination-heat / verity-scan / cross-check-alert / disinfo-alert)
    // returned the upstream 401 verbatim with no WWW-Authenticate header.
    // Without it, Claude Desktop saw the 401 but had no protocol-level
    // signal to open the OAuth flow, so the connector silently stayed
    // unauthenticated. Confirmed live 2026-05-25; this test pins the
    // regression guard.
    const body = { error: 'X-Verity-Key header required. Get your API key from your account dashboard.' };
    const outcome: ProxyOutcome = { kind: 'forward', status: 401, body, upstreamStatus: 401 };
    const r = outcomeToResponse(outcome, id);
    expect(r.status).toBe(401);
    expect(r.headers).toEqual({
      'WWW-Authenticate':
        'Bearer realm="mcp.verityskills.com", resource_metadata="https://mcp.verityskills.com/.well-known/oauth-protected-resource"',
    });
    expect(r.body).toEqual({
      jsonrpc: '2.0',
      id,
      result: {
        content: [{ type: 'text', text: JSON.stringify(body) }],
        isError: true,
      },
    });
  });

  it('forward does NOT attach WWW-Authenticate on non-401 errors (402 trial cap, 5xx, etc.)', () => {
    const outcome: ProxyOutcome = { kind: 'forward', status: 402, body: { code: 'TRIAL_CAP_REACHED' }, upstreamStatus: 402 };
    const r = outcomeToResponse(outcome, id);
    expect(r.status).toBe(402);
    expect(r.headers).toBeUndefined();
  });

  it('forward preserves 402 status AND sets isError: true on non-2xx upstream forwards', () => {
    const body = { code: 'TRIAL_CAP_REACHED', upgrade_url: 'https://verityskills.com/upgrade?return_to=mcp&via=cap' };
    const outcome: ProxyOutcome = { kind: 'forward', status: 402, body, upstreamStatus: 402 };
    const r = outcomeToResponse(outcome, id);
    expect(r.status).toBe(402);
    expect(r.body).toEqual({
      jsonrpc: '2.0',
      id,
      result: {
        content: [{ type: 'text', text: JSON.stringify(body) }],
        isError: true,
      },
    });
  });

  // MCP tools/call response contract pin (regression guard for the Claude
  // Desktop "malformed response (missing content field)" failure mode):
  // every successful forward must yield a result.content[] array with a
  // single text block whose text parses back to the upstream body. The
  // pre-VRT-165 shape (`result: <upstream body>` unwrapped) shipped briefly
  // and broke every spec-conforming MCP client.
  it('forward result.content[0] is type=text and text parses back to the upstream body', () => {
    const upstream = { ticker: 'NVDA', score: 75, breakdown: { coordination: 0.4 } };
    const outcome: ProxyOutcome = { kind: 'forward', status: 200, body: upstream, upstreamStatus: 200 };
    const r = outcomeToResponse(outcome, id);
    const env = r.body as { result: { content: ReadonlyArray<{ type: string; text: string }>; isError?: boolean } };
    expect(env.result.content).toHaveLength(1);
    expect(env.result.content[0]!.type).toBe('text');
    expect(JSON.parse(env.result.content[0]!.text)).toEqual(upstream);
    expect(env.result.isError).toBeUndefined();
  });

  it('bearer_invalid returns HTTP 401 with INVALID_BEARER_FORMAT body (non JSON-RPC envelope)', () => {
    const outcome: ProxyOutcome = { kind: 'bearer_invalid' };
    // VRT-166: message extended to mention both vtk_ (user key) and vto_
    // (OAuth token) prefixes; 401 now carries WWW-Authenticate per RFC 6750.
    expect(outcomeToResponse(outcome, id)).toEqual({
      body: {
        code: 'INVALID_BEARER_FORMAT',
        error: "Authorization header must be 'Bearer vtk_<token>' or 'Bearer vto_<token>'",
      },
      status: 401,
      headers: {
        'WWW-Authenticate':
          'Bearer realm="mcp.verityskills.com", resource_metadata="https://mcp.verityskills.com/.well-known/oauth-protected-resource"',
      },
    });
  });

  it('tool_disabled returns HTTP 503 with TOOL_DISABLED body (non JSON-RPC envelope)', () => {
    const outcome: ProxyOutcome = { kind: 'tool_disabled', tool: 'verity-score' };
    expect(outcomeToResponse(outcome, id)).toEqual({
      body: { code: 'TOOL_DISABLED', tool: 'verity-score' },
      status: 503,
    });
  });

  it('unknown_tool returns HTTP 200 with -32602 invalid params', () => {
    const outcome: ProxyOutcome = { kind: 'unknown_tool', tool: 'ghost-tool' };
    const r = outcomeToResponse(outcome, id);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      jsonrpc: '2.0',
      id,
      error: { code: -32602, message: 'Unknown tool', data: { tool: 'ghost-tool' } },
    });
  });

  it('upstream_5xx returns HTTP 200 with -32603 and upstream_status + upstream_body in error.data', () => {
    const outcome: ProxyOutcome = {
      kind: 'upstream_5xx',
      upstreamStatus: 502,
      upstreamBody: { error: 'bad gateway' },
      cause: 'upstream 502 Bad Gateway',
    };
    const r = outcomeToResponse(outcome, id);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      jsonrpc: '2.0',
      id,
      error: {
        code: -32603,
        message: 'Upstream verity service unavailable, retry in 30s',
        data: { upstream_status: 502, upstream_body: { error: 'bad gateway' } },
      },
    });
  });

  it('upstream_network_error returns HTTP 200 with -32603 and error_name + cause in error.data', () => {
    const outcome: ProxyOutcome = {
      kind: 'upstream_network_error',
      errorName: 'AbortError',
      cause: 'The operation was aborted',
    };
    const r = outcomeToResponse(outcome, id);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      jsonrpc: '2.0',
      id,
      error: {
        code: -32603,
        message: 'Upstream verity service unreachable, retry in 30s',
        data: { error_name: 'AbortError', cause: 'The operation was aborted' },
      },
    });
  });
});

describe('handleMcpRequest', () => {
  const env = {};

  it('returns -32700 on unparseable body', async () => {
    const req = rawBodyRequest('{not json');
    const r = await handleMcpRequest(req, env);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error' },
    });
    expect(r.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('returns -32600 on invalid envelope and echoes parseable id', async () => {
    const req = jsonRequest({ id: 42, method: 'tools/list' });
    const r = await handleMcpRequest(req, env);
    expect(r.body).toEqual({
      jsonrpc: '2.0',
      id: 42,
      error: { code: -32600, message: 'Invalid Request' },
    });
  });

  it('returns -32600 with null id when id is unparseable', async () => {
    const req = jsonRequest({ jsonrpc: '1.0', id: { wat: 1 }, method: 'tools/list' });
    const r = await handleMcpRequest(req, env);
    expect(r.body).toMatchObject({ id: null, error: { code: -32600 } });
  });

  it('initialize returns byte-identical result and echoes id', async () => {
    const req = jsonRequest({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    const r = await handleMcpRequest(req, env);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'verity-mcp', version: '1.0.0' },
      },
    });
  });

  it('tools/list returns 6 tools and echoes id', async () => {
    const req = jsonRequest({ jsonrpc: '2.0', id: 'a', method: 'tools/list', params: {} });
    const r = await handleMcpRequest(req, env);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ jsonrpc: '2.0', id: 'a' });
    const result = (r.body as { result: { tools: unknown[] } }).result;
    expect(result.tools).toHaveLength(6);
  });

  it('unknown method returns -32601 and surfaces the offending method', async () => {
    const req = jsonRequest({ jsonrpc: '2.0', id: 1, method: 'mystery/probe', params: {} });
    const r = await handleMcpRequest(req, env);
    expect(r.body).toEqual({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32601, message: 'Method not found', data: { method: 'mystery/probe' } },
    });
  });

  it('tools/call with non-object params returns -32602', async () => {
    const req = jsonRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: 'not-an-object' });
    const r = await handleMcpRequest(req, env);
    expect(r.body).toMatchObject({ id: 1, error: { code: -32602 } });
  });

  it('tools/call with non-string name returns -32602', async () => {
    const req = jsonRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 42 } });
    const r = await handleMcpRequest(req, env);
    expect(r.body).toMatchObject({ id: 1, error: { code: -32602 } });
  });

  it('tools/call dispatches to upstream with bearer + request_id and forwards 200 result', async () => {
    let capturedUrl = '';
    let capturedHeaders: Headers = new Headers();
    let capturedBody = '';
    const fetchImpl: typeof fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = input.toString();
      capturedHeaders = new Headers(init?.headers);
      capturedBody = (init?.body as string) ?? '';
      return new Response(JSON.stringify({ score: 87 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const req = jsonRequest(
      { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'verity-score', arguments: { subject: 'NVDA' } } },
      { authorization: 'Bearer vtk_abc123' },
    );
    const r = await handleMcpRequest(req, env, fetchImpl);

    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      jsonrpc: '2.0',
      id: 9,
      result: {
        content: [{ type: 'text', text: JSON.stringify({ score: 87 }) }],
      },
    });

    // Bearer translated to x-verity-key with NO Bearer prefix (coupling #8).
    expect(capturedHeaders.get('x-verity-key')).toBe('vtk_abc123');
    expect(capturedHeaders.get('x-verity-key')).not.toMatch(/^Bearer/);
    // request_id propagated (coupling #9).
    expect(capturedHeaders.get('x-request-id')).toBe(r.requestId);
    // Body forwarded byte-identical.
    expect(JSON.parse(capturedBody)).toEqual({ subject: 'NVDA' });
    // Routed to the verity-score upstream skill route.
    expect(capturedUrl).toBe('https://verityskills.com/api/skills/verity-score');
  });

  it('tools/call with absent bearer forwards (no x-verity-key) and surfaces upstream 401', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ code: 'UNAUTHORIZED' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });

    const req = jsonRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'verity-score', arguments: { subject: 'AAPL' } },
    });
    const r = await handleMcpRequest(req, env, fetchImpl);
    expect(r.status).toBe(401);
    expect(r.body).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [{ type: 'text', text: JSON.stringify({ code: 'UNAUTHORIZED' }) }],
        isError: true,
      },
    });
  });

  it('tools/call with malformed bearer returns HTTP 401 INVALID_BEARER_FORMAT and never hits upstream', async () => {
    let fetchCalls = 0;
    const fetchImpl: typeof fetch = async () => {
      fetchCalls += 1;
      return new Response('should not happen', { status: 200 });
    };

    const req = jsonRequest(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'verity-score' } },
      { authorization: 'bogus vtk_x' },
    );
    const r = await handleMcpRequest(req, env, fetchImpl);
    expect(fetchCalls).toBe(0);
    expect(r.status).toBe(401);
    expect(r.body).toEqual({
      code: 'INVALID_BEARER_FORMAT',
      error: "Authorization header must be 'Bearer vtk_<token>' or 'Bearer vto_<token>'",
    });
  });

  it('tools/call with disabled tool returns HTTP 503 TOOL_DISABLED and never hits upstream', async () => {
    let fetchCalls = 0;
    const fetchImpl: typeof fetch = async () => {
      fetchCalls += 1;
      return new Response('should not happen', { status: 200 });
    };

    const req = jsonRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'verity-score', arguments: { subject: 'X' } },
    });
    const r = await handleMcpRequest(req, { MCP_TOOLS_DISABLED: 'verity-score' }, fetchImpl);
    expect(fetchCalls).toBe(0);
    expect(r.status).toBe(503);
    expect(r.body).toEqual({ code: 'TOOL_DISABLED', tool: 'verity-score' });
  });

  it('tools/call with unknown tool name returns -32602 unknown_tool envelope', async () => {
    const req = jsonRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'ghost-tool', arguments: {} },
    });
    const r = await handleMcpRequest(req, env);
    expect(r.body).toMatchObject({
      id: 1,
      error: { code: -32602, data: { tool: 'ghost-tool' } },
    });
  });

  it('tools/call surfaces upstream 5xx as -32603 with HTTP 200', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ msg: 'oops' }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      });

    const req = jsonRequest(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'verity-score', arguments: { subject: 'X' } } },
      { authorization: 'Bearer vtk_abc' },
    );
    const r = await handleMcpRequest(req, env, fetchImpl);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      id: 1,
      error: { code: -32603, data: { upstream_status: 503, upstream_body: { msg: 'oops' } } },
    });
  });

  it('tools/call surfaces network failure as -32603 with HTTP 200 and error_name/cause', async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new TypeError('fetch failed: ENOTFOUND');
    };

    const req = jsonRequest(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'verity-score', arguments: { subject: 'X' } } },
      { authorization: 'Bearer vtk_abc' },
    );
    const r = await handleMcpRequest(req, env, fetchImpl);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      id: 1,
      error: {
        code: -32603,
        data: { error_name: 'TypeError', cause: 'fetch failed: ENOTFOUND' },
      },
    });
  });

  it('tools/call with arguments omitted falls back to empty object for upstream body', async () => {
    let captured = '';
    const fetchImpl: typeof fetch = async (_url, init) => {
      captured = (init?.body as string) ?? '';
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const req = jsonRequest(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'coordination-heat' } },
    );
    await handleMcpRequest(req, env, fetchImpl);
    expect(JSON.parse(captured)).toEqual({});
  });

  // Argument-type validation (convergent finding: silent-failure P1 + type-design P1 +
  // pr-test P1-1 + pr-test P1-2 + code-reviewer P2.3). The worker is a thin
  // proxy and the upstream skill routes all consume objects; forwarding a
  // primitive arguments payload would silently misroute at upstream.
  it.each([
    ['null', null],
    ['number', 42],
    ['string', 'go'],
    ['boolean', true],
    ['array', ['a', 'b']],
  ])('tools/call with arguments=%s rejects with -32602 and never hits upstream', async (_label, badArgs) => {
    let fetchCalls = 0;
    const fetchImpl: typeof fetch = async () => {
      fetchCalls += 1;
      return new Response('{}', { status: 200 });
    };
    const req = jsonRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'verity-score', arguments: badArgs },
    });
    const r = await handleMcpRequest(req, env, fetchImpl);
    expect(fetchCalls).toBe(0);
    expect(r.body).toMatchObject({ id: 1, error: { code: -32602 } });
    expect(r.outcomeKind).toBe('invalid_params');
  });

  it('tools/call with explicit arguments={} forwards an empty object body', async () => {
    let captured = '';
    const fetchImpl: typeof fetch = async (_url, init) => {
      captured = (init?.body as string) ?? '';
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const req = jsonRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'coordination-heat', arguments: {} },
    });
    await handleMcpRequest(req, env, fetchImpl);
    expect(JSON.parse(captured)).toEqual({});
  });

  it('tools/call with tool name longer than 64 chars truncates the echoed name', async () => {
    const longName = 'x'.repeat(200);
    const req = jsonRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: longName, arguments: {} },
    });
    const r = await handleMcpRequest(req, env);
    const data = (r.body as { error: { data: { tool: string } } }).error.data;
    expect(data.tool.length).toBeLessThanOrEqual(67);
    expect(data.tool.endsWith('...')).toBe(true);
  });

  // Observability plumbing (5-lens convergent fix). HandleMcpResult must
  // surface tool / outcomeKind / upstreamStatus / errorDetail so the entry
  // layer can emit a useful structured log line. Each path is asserted here.
  it('observability fields are surfaced on initialize', async () => {
    const req = jsonRequest({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    const r = await handleMcpRequest(req, env);
    expect(r.tool).toBe('initialize');
    expect(r.outcomeKind).toBe('initialize_ok');
    expect(r.upstreamStatus).toBeNull();
    expect(r.errorDetail).toBeNull();
  });

  it('observability fields are surfaced on tools/list', async () => {
    const req = jsonRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    const r = await handleMcpRequest(req, env);
    expect(r.tool).toBe('tools/list');
    expect(r.outcomeKind).toBe('tools_list_ok');
  });

  it('observability fields are surfaced on parse error', async () => {
    const r = await handleMcpRequest(rawBodyRequest('{not-json'), env);
    expect(r.outcomeKind).toBe('parse_error');
    expect(r.errorDetail).toBeTruthy();
  });

  it('observability fields are surfaced on invalid envelope', async () => {
    const r = await handleMcpRequest(jsonRequest({ id: 1, method: 'x' }), env);
    expect(r.outcomeKind).toBe('invalid_envelope');
  });

  it('observability fields are surfaced on method_not_found', async () => {
    const r = await handleMcpRequest(jsonRequest({ jsonrpc: '2.0', id: 1, method: 'ghost', params: {} }), env);
    expect(r.outcomeKind).toBe('method_not_found');
    expect(r.tool).toBe('unknown');
    expect(r.errorDetail).toContain('ghost');
  });

  it('method_not_found truncates long method names in both body and errorDetail', async () => {
    const longMethod = 'm'.repeat(200);
    const r = await handleMcpRequest(
      jsonRequest({ jsonrpc: '2.0', id: 1, method: longMethod, params: {} }),
      env,
    );
    const method = (r.body as { error: { data: { method: string } } }).error.data.method;
    expect(method.length).toBeLessThanOrEqual(67);
    expect(method.endsWith('...')).toBe(true);
    expect(r.errorDetail).not.toContain(longMethod);
  });

  it('observability fields are surfaced on forward 200 with the upstream status', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
    const req = jsonRequest(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'verity-score', arguments: {} } },
      { authorization: 'Bearer vtk_a' },
    );
    const r = await handleMcpRequest(req, env, fetchImpl);
    expect(r.tool).toBe('verity-score');
    expect(r.outcomeKind).toBe('forward');
    expect(r.upstreamStatus).toBe(200);
  });

  it('observability fields carry forward 403 + upstream status', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response('{"code":"TIER_NOT_PERMITTED"}', { status: 403, headers: { 'content-type': 'application/json' } });
    const req = jsonRequest(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'verity-scan', arguments: { subject: 'X' } } },
      { authorization: 'Bearer vtk_a' },
    );
    const r = await handleMcpRequest(req, env, fetchImpl);
    expect(r.status).toBe(403);
    expect(r.body).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [{ type: 'text', text: JSON.stringify({ code: 'TIER_NOT_PERMITTED' }) }],
        isError: true,
      },
    });
    expect(r.outcomeKind).toBe('forward');
    expect(r.upstreamStatus).toBe(403);
  });

  it('observability fields surface upstream_5xx with upstream status + error detail', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response('{"x":1}', { status: 502, headers: { 'content-type': 'application/json' } });
    const req = jsonRequest(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'verity-score', arguments: {} } },
      { authorization: 'Bearer vtk_a' },
    );
    const r = await handleMcpRequest(req, env, fetchImpl);
    expect(r.outcomeKind).toBe('upstream_5xx');
    expect(r.upstreamStatus).toBe(502);
    expect(r.errorDetail).toContain('502');
  });

  it('observability fields surface upstream_network_error with errorName and cause', async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new TypeError('DNS lookup failed');
    };
    const req = jsonRequest(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'verity-score', arguments: {} } },
      { authorization: 'Bearer vtk_a' },
    );
    const r = await handleMcpRequest(req, env, fetchImpl);
    expect(r.outcomeKind).toBe('upstream_network_error');
    expect(r.upstreamStatus).toBeNull();
    expect(r.errorDetail).toBe('TypeError: DNS lookup failed');
  });

  it('observability fields carry bearer_invalid signal', async () => {
    const req = jsonRequest(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'verity-score' } },
      { authorization: 'broken vtk_x' },
    );
    const r = await handleMcpRequest(req, env);
    expect(r.outcomeKind).toBe('bearer_invalid');
    expect(r.errorDetail).toBe('INVALID_BEARER_FORMAT');
  });
});
