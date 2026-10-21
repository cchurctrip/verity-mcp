// Live end-to-end contract tests against the deployed Worker at
// https://mcp.verityskills.com. These exercise the REAL upstream skill
// routes through the live Worker proxy and pin the response shapes a
// marketplace consumer will see after the VRT-149f contract alignment.
//
// Secret handling: the integration-test API key is read from
// process.env.VERITY_MCP_TEST_KEY. It is NEVER hardcoded or committed. When
// the env var is absent (the default in CI without the secret) the entire
// suite skips cleanly so the pipeline stays green. A developer with the
// secret exported locally runs the live assertions.
//
// This file runs in the plain Node project (see vitest.config.ts) so it can
// make real network calls and read process.env. It does NOT run in the
// Cloudflare Workers pool used by every other test file.
//
// Shape notes:
//  - The Worker wraps the upstream payload in MCP tools/call shape:
//    { jsonrpc, id, result: { content: [{type:'text', text:'<JSON>'}], isError? } }
//    per MCP 2025-03-26. The upstream skill route's domain payload is
//    JSON-stringified into content[0].text. Tests below assert against the
//    parsed payload, accessed via the `upstream` field on the callTool
//    helper return.
//  - For an upstream 401/403 the Worker preserves the HTTP status, sets
//    isError: true, and forwards the upstream body inside content[0].text.
//  - coordination-heat, cross-check-alert and disinfo-alert now forward to
//    the newer marketed operations, so the asserted upstream keys are the
//    new operations' keys, not the pre-rename legacy keys.
//  - C3 documented inconsistency (pinned verbatim, intentionally NOT
//    "fixed"): verity-score answers an invalid key with 401; verity-scan,
//    cross-check-alert, disinfo-alert and coordination-heat answer a
//    non-entitled tier with 403.

import { describe, expect, it } from 'vitest';

const MCP_URL = 'https://mcp.verityskills.com/mcp';

// process.env is read without pulling @types/node into the tsconfig (the
// shared types array is Workers-only on purpose). This narrow accessor reads
// the env bag off globalThis and stays undefined-safe when it is absent.
function readTestKey(): string | undefined {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return proc?.env?.['VERITY_MCP_TEST_KEY'];
}

const TEST_KEY = readTestKey();
const LIVE = typeof TEST_KEY === 'string' && TEST_KEY.length > 0;

// describe.skipIf keeps the suite green when the secret is absent. The
// negation is intentional: skip WHEN NOT live.
const liveDescribe = describe.skipIf(!LIVE);

interface JsonRpcEnvelope {
  jsonrpc: string;
  id: number;
  result?: {
    content?: ReadonlyArray<{ type: string; text: string }>;
    isError?: boolean;
  };
  error?: { code: number; message?: string; data?: unknown };
}

interface CallToolResult {
  status: number;
  body: JsonRpcEnvelope;
  // Parsed upstream payload (content[0].text JSON-parsed). undefined when
  // the response is a JSON-RPC error envelope or otherwise unwrappable.
  upstream: Record<string, unknown> | undefined;
  isError: boolean;
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
  key: string | undefined,
): Promise<CallToolResult> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (key) headers['authorization'] = `Bearer ${key}`;
  const res = await fetch(MCP_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  const body = (await res.json()) as JsonRpcEnvelope;
  const text = body.result?.content?.[0]?.text;
  let upstream: Record<string, unknown> | undefined;
  if (typeof text === 'string') {
    try {
      upstream = JSON.parse(text) as Record<string, unknown>;
    } catch {
      upstream = undefined;
    }
  }
  return { status: res.status, body, upstream, isError: body.result?.isError === true };
}

function expectHasAll(obj: Record<string, unknown> | undefined, keys: readonly string[]): void {
  expect(obj, 'upstream payload present (unwrapped from result.content[0].text)').toBeTruthy();
  for (const k of keys) {
    expect(Object.prototype.hasOwnProperty.call(obj ?? {}, k), `upstream missing key "${k}"`).toBe(
      true,
    );
  }
}

liveDescribe('live contract: 7 tools vs mcp.verityskills.com', () => {
  // 1. coordination-heat -> /api/skills/coordination-score (now auth-required).
  it('coordination-heat returns the subject-score shape', async () => {
    const { status, upstream, isError } = await callTool('coordination-heat', { subject: 'GME' }, TEST_KEY);
    expect(status).toBe(200);
    expect(isError).toBe(false);
    // The Worker forwards to the free-text subject scorer. Its 200 shape is
    // { subject, score, band, summary, signals_found, sources_checked,
    // window_hours }. This deliberately differs from the pre-rename 6-tab
    // leaderboard shape ({ tab, tickers, note? }) noted in the spec
    // appendix: that probe predated the rename. The empty-vs-nonempty
    // `note` field belonged to the leaderboard route, which the Worker no
    // longer targets. The subject scorer never emits a `note` field, so we
    // assert its stable key set instead.
    //
    // A quiet lookback window is a legitimate 200: the scorer answers
    // { subject, status: 'insufficient_data', summary, signals_found,
    // sources_checked, window_hours } with NO score/band rather than
    // fabricating a zero. Both shapes are part of the contract a
    // marketplace consumer sees, so the test accepts either; scored
    // windows still pin the full scored key set.
    const sharedKeys = ['subject', 'summary', 'signals_found', 'sources_checked', 'window_hours'] as const;
    if (upstream && upstream['status'] === 'insufficient_data') {
      expectHasAll(upstream, sharedKeys);
      expect(upstream, 'insufficient_data never carries a score').not.toHaveProperty('score');
      expect(upstream, 'insufficient_data never carries a band').not.toHaveProperty('band');
    } else {
      expectHasAll(upstream, [...sharedKeys, 'score', 'band']);
    }
    expect(upstream, 'subject scorer never emits a note field').not.toHaveProperty('note');
  });

  // 2. verity-score authenticated full shape (spec appendix, verbatim).
  it('verity-score (authenticated) returns ticker/score/explanation/breakdown/asof', async () => {
    const { status, upstream, isError } = await callTool('verity-score', { subject: 'NVDA' }, TEST_KEY);
    expect(status).toBe(200);
    expect(isError).toBe(false);
    expectHasAll(upstream, ['ticker', 'score', 'explanation', 'breakdown', 'asof']);
  });

  // 3. morning-brief authenticated shape (spec appendix, verbatim). The
  // Worker schema now requires a non-empty watchlist and no longer
  // advertises the no-op `date` field.
  it('morning-brief (authenticated) returns variant/subject/tickers/asof', async () => {
    const { status, upstream, isError } = await callTool(
      'morning-brief',
      { watchlist: ['AAPL', 'NVDA'] },
      TEST_KEY,
    );
    expect(status).toBe(200);
    expect(isError).toBe(false);
    expectHasAll(upstream, ['variant', 'subject', 'tickers', 'asof']);
  });

  // 4. verity-scan authenticated shape (spec appendix, verbatim). subject
  // alias wraps to a single-element tickers array upstream.
  it('verity-scan (authenticated) returns the anomaly-scan shape', async () => {
    const { status, upstream, isError } = await callTool('verity-scan', { subject: 'AAPL' }, TEST_KEY);
    expect(status).toBe(200);
    expect(isError).toBe(false);
    expectHasAll(upstream, [
      'tickers_checked',
      'scan_window_hours',
      'anomalies',
      'clean',
      'anomaly_count',
      'scanned_at',
    ]);
  });

  // 5. cross-check-alert -> /api/skills/cross-check-claim. 4-value verdict.
  it('cross-check-alert returns the claim-corroboration shape with a 4-value verdict', async () => {
    const { status, upstream, isError } = await callTool(
      'cross-check-alert',
      { claim: 'The Federal Reserve cut rates by 25 basis points on 2026-03-18.' },
      TEST_KEY,
    );
    expect(status).toBe(200);
    expect(isError).toBe(false);
    expectHasAll(upstream, [
      'verdict',
      'confidence',
      'sources_checked',
      'signals_matched',
      'citations',
      'source_conflicts',
      'summary',
    ]);
    expect(['CORROBORATED', 'CONFLICTED', 'UNVERIFIED', 'NO_SIGNAL']).toContain(
      upstream?.['verdict'],
    );
  });

  // 6. disinfo-alert -> /api/skills/disinfo-monitor. severity_threshold
  // is now required.
  it('disinfo-alert returns the ongoing-monitor shape', async () => {
    const { status, upstream, isError } = await callTool(
      'disinfo-alert',
      { subject: 'TSLA', severity_threshold: 'medium' },
      TEST_KEY,
    );
    expect(status).toBe(200);
    expect(isError).toBe(false);
    expectHasAll(upstream, [
      'subject',
      'severity_threshold',
      'detected',
      'status',
      'patterns',
      'summary',
      'signals_found',
      'sources_checked',
      'analyzed_at',
    ]);
  });

  it('notification-prefs (action:get) returns the subscriptions shape', async () => {
    const { status, upstream, isError } = await callTool('notification-prefs', { action: 'get' }, TEST_KEY);
    expect(status).toBe(200);
    expect(isError).toBe(false);
    expectHasAll(upstream, ['subscriptions']);
  });

  // MCP tools/call response shape regression guard (Claude Desktop smoke
  // VRT-165): every successful forward must include result.content[0]
  // with type:text and parseable JSON text. The transport-level 9-probe
  // matrix validated framing; this validates the inner MCP content shape.
  it('every tool response wraps the upstream payload in result.content[0].text (MCP 2025-03-26)', async () => {
    const { body } = await callTool('verity-score', { subject: 'NVDA' }, TEST_KEY);
    expect(body.result).toBeDefined();
    expect(Array.isArray(body.result?.content)).toBe(true);
    expect(body.result?.content).toHaveLength(1);
    expect(body.result?.content?.[0]?.type).toBe('text');
    expect(typeof body.result?.content?.[0]?.text).toBe('string');
    // text round-trips through JSON.parse to a non-null object.
    const parsed = JSON.parse(body.result!.content![0]!.text);
    expect(typeof parsed).toBe('object');
    expect(parsed).not.toBeNull();
  });
});

// C3: per-tool auth status codes. This is an intentional, documented
// inconsistency. It is pinned here verbatim so marketplace consumers can
// rely on it and so a future "consistency cleanup" is a deliberate,
// test-breaking decision rather than an accident. Do NOT "fix" this.
liveDescribe('live contract C3: per-tool auth status codes (documented inconsistency)', () => {
  // Must be a WELL-FORMED bearer (matches the Worker bearer regex
  // vtk_[A-Za-z0-9]+, no underscores after vtk_) but not a real or
  // entitled key. A malformed key would be rejected by the Worker with an
  // edge 401 INVALID_BEARER_FORMAT before it ever reaches upstream, so the
  // per-tool upstream auth statuses below (the actual C3 contract) would
  // never be exercised. Keep this alphanumeric.
  const BOGUS_KEY = 'vtk_definitelynotarealkey0000000000';

  it('verity-score answers an invalid key with 401', async () => {
    const { status } = await callTool('verity-score', { subject: 'NVDA' }, BOGUS_KEY);
    expect(status).toBe(401);
  });

  it('verity-scan answers a non-entitled key with 403', async () => {
    const { status } = await callTool('verity-scan', { subject: 'AAPL' }, BOGUS_KEY);
    expect(status).toBe(403);
  });

  it('cross-check-alert answers a non-entitled key with 403', async () => {
    const { status } = await callTool(
      'cross-check-alert',
      { claim: 'A test claim.' },
      BOGUS_KEY,
    );
    expect(status).toBe(403);
  });

  it('disinfo-alert answers a non-entitled key with 403', async () => {
    const { status } = await callTool(
      'disinfo-alert',
      { subject: 'TSLA', severity_threshold: 'low' },
      BOGUS_KEY,
    );
    expect(status).toBe(403);
  });

  it('coordination-heat answers a non-entitled key with 403 (now auth-required)', async () => {
    const { status } = await callTool('coordination-heat', { subject: 'GME' }, BOGUS_KEY);
    expect(status).toBe(403);
  });
});
