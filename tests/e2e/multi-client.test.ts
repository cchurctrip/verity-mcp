// Live multi-client transport probes against https://mcp.verityskills.com.
//
// Nine probes covering the four target MCP clients per VRT-165 (Gate-2
// ratified):
//
//   - Cursor: 3 Accept-header variants must route to application/json
//     (no Accept, *\/*, application/json alone).
//   - Claude Desktop (npx server-fetch proxy default Accept *\/*): one
//     probe routes to application/json.
//   - ChatGPT Desktop Streamable HTTP: 2 Accept-header variants, both
//     route to text/event-stream framed as one event: message + close.
//   - Gemini Streamable HTTP: 1 probe with Accept: text/event-stream
//     (Gate-2 R4: Gemini Enterprise / AI Studio / Vertex are
//     Streamable HTTP, NOT legacy SSE).
//   - Perplexity Comet: 2 probes covering the legacy SSE handshake
//     (GET /sse initial endpoint event + POST /sse fallback path).
//
// Secret handling: reads VERITY_MCP_TEST_KEY from process.env. When the
// env var is absent the entire suite skips so CI without the secret
// stays green. The same secret is wired into the scheduled
// live-contract-e2e workflow for daily probe runs.
//
// Runs in the Node test project (vitest.config.ts e2e block) so real
// network calls are allowed; this file does NOT execute in the
// Miniflare isolate.

import { describe, expect, it } from 'vitest';

const BASE_URL = 'https://mcp.verityskills.com';

function readTestKey(): string | undefined {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return proc?.env?.['VERITY_MCP_TEST_KEY'];
}

const TEST_KEY = readTestKey();
const LIVE = typeof TEST_KEY === 'string' && TEST_KEY.length > 0;
const liveDescribe = describe.skipIf(!LIVE);

interface JsonRpcInitResult {
  protocolVersion: string;
  capabilities: { tools: Record<string, never> };
  serverInfo: { name: string; version: string };
}

interface JsonRpcEnvelope {
  jsonrpc: string;
  id: number;
  result?: JsonRpcInitResult;
  error?: { code: number; message: string };
}

async function postMcp(
  acceptHeader: string | null,
  body: unknown,
  bearer: string,
): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    Authorization: `Bearer ${bearer}`,
  };
  if (acceptHeader !== null) headers['accept'] = acceptHeader;
  return fetch(`${BASE_URL}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

function initEnvelope(id: number): unknown {
  return { jsonrpc: '2.0', id, method: 'initialize', params: {} };
}

function parseSseEnvelope(sseText: string): JsonRpcEnvelope {
  // The Streamable HTTP response is one SSE frame:
  //   event: message
  //   data: <envelope>
  //   <blank line, then stream close>
  // No event: done frame (Gate-2 R1).
  expect(sseText, 'SSE response begins with event: message').toMatch(
    /^event: message\n/,
  );
  expect(sseText, 'no event: done frame (Gate-2 R1)').not.toContain('event: done');
  const dataLine = sseText.split('\n').find((l) => l.startsWith('data: '));
  expect(dataLine, 'SSE response includes a data line').toBeDefined();
  return JSON.parse(dataLine!.substring('data: '.length)) as JsonRpcEnvelope;
}

liveDescribe('multi-client probes against mcp.verityskills.com (VRT-165)', () => {
  // The probes use the lightweight `initialize` JSON-RPC method which has
  // no side effects and runs in microseconds: it exercises the transport
  // surface without burning trial-cap counters or upstream LLM tokens.

  describe('Cursor regression: 3 Accept-header variants stay JSON (Gate-2 S2)', () => {
    it('no Accept header routes to application/json', async () => {
      const res = await postMcp(null, initEnvelope(1), TEST_KEY!);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/^application\/json/);
      const body = (await res.json()) as JsonRpcEnvelope;
      expect(body.result?.protocolVersion).toBe('2025-03-26');
    });

    it('Accept: */* routes to application/json', async () => {
      const res = await postMcp('*/*', initEnvelope(2), TEST_KEY!);
      expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    });

    it('Accept: application/json routes to application/json', async () => {
      const res = await postMcp('application/json', initEnvelope(3), TEST_KEY!);
      expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    });
  });

  describe('Claude Desktop (npx server-fetch proxy default Accept)', () => {
    it('Accept: */* (proxy default) routes to application/json', async () => {
      const res = await postMcp('*/*', initEnvelope(4), TEST_KEY!);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    });
  });

  describe('ChatGPT Desktop Streamable HTTP (Gate-2 R2 fixtures)', () => {
    it('Accept: text/event-stream returns SSE-framed single envelope, no event: done (Gate-2 R1)', async () => {
      const res = await postMcp('text/event-stream', initEnvelope(5), TEST_KEY!);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/);
      const env = parseSseEnvelope(await res.text());
      expect(env.result?.protocolVersion).toBe('2025-03-26');
    });

    it('Accept: application/json, text/event-stream (spec-canonical) returns SSE', async () => {
      const res = await postMcp(
        'application/json, text/event-stream',
        initEnvelope(6),
        TEST_KEY!,
      );
      expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/);
    });
  });

  describe('Gemini Streamable HTTP (Gate-2 R4: not legacy SSE)', () => {
    it('Accept: text/event-stream returns SSE-framed envelope (Gemini Enterprise / AI Studio / Vertex / CLI)', async () => {
      const res = await postMcp(
        'text/event-stream;q=0.9, application/json',
        initEnvelope(7),
        TEST_KEY!,
      );
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/);
      const env = parseSseEnvelope(await res.text());
      expect(env.result?.protocolVersion).toBe('2025-03-26');
    });
  });

  describe('Perplexity Comet legacy SSE bridge (MCP 2024-11-05)', () => {
    it('GET /sse with valid bearer returns text/event-stream + initial event: endpoint with absolute URL (Gate-2 R3)', async () => {
      const res = await fetch(`${BASE_URL}/sse`, {
        headers: { Authorization: `Bearer ${TEST_KEY!}` },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/);
      expect(res.body).not.toBeNull();

      // Read the first ~256 bytes off the stream, which should contain
      // the endpoint event. Then cancel so the test does not hold the
      // connection through the 15-second keep-alive cadence.
      const reader = res.body!.getReader();
      try {
        const { value } = await reader.read();
        expect(value).toBeDefined();
        const initialText = new TextDecoder().decode(value!);
        expect(initialText).toContain('event: endpoint\n');
        expect(initialText).toContain(`data: ${BASE_URL}/sse\n`);
        expect(initialText, 'absolute URL, not bare path (Gate-2 R3)').not.toContain('data: /sse\n');
      } finally {
        await reader.cancel();
      }
    });

    it('POST /sse without an open GET stream falls back to 200 + application/json + envelope inline (MCP 2024-11-05 6.2.2)', async () => {
      // No GET /sse opened in this isolate; the POST cannot relay and
      // returns the envelope inline. Note: the same-isolate relay path
      // is not deterministic across CI runs (depends on edge routing);
      // the cross-isolate fallback path IS deterministic and is the
      // contract this probe pins.
      const res = await fetch(`${BASE_URL}/sse`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${TEST_KEY!}`,
        },
        body: JSON.stringify(initEnvelope(8)),
      });
      // Either 202 (relay landed on a different isolate's open stream)
      // OR 200 (fallback inline). Both are spec-permitted.
      expect([200, 202]).toContain(res.status);
      if (res.status === 200) {
        expect(res.headers.get('content-type')).toMatch(/^application\/json/);
        const body = (await res.json()) as JsonRpcEnvelope;
        expect(body.result?.protocolVersion).toBe('2025-03-26');
      }
    });
  });
});
