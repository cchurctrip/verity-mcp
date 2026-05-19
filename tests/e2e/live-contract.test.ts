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
//  - The Worker wraps an upstream 2xx body in the JSON-RPC result envelope:
//    { jsonrpc, id, result: <upstream body> }. For an upstream 401/403 the
//    Worker preserves the HTTP status and forwards the upstream body inside
//    `result` verbatim.
//  - coordination-heat, cross-check-alert and disinfo-alert now forward to
//    the newer marketed operations, so the asserted result keys are the new
//    operations' keys, not the pre-rename legacy keys.
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
  result?: Record<string, unknown>;
  error?: { code: number; message?: string; data?: unknown };
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
  key: string | undefined,
): Promise<{ status: number; body: JsonRpcEnvelope }> {
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
  return { status: res.status, body };
}

function expectHasAll(obj: Record<string, unknown> | undefined, keys: readonly string[]): void {
  expect(obj, 'result envelope present').toBeTruthy();
  for (const k of keys) {
    expect(Object.prototype.hasOwnProperty.call(obj ?? {}, k), `result missing key "${k}"`).toBe(
      true,
    );
  }
}

liveDescribe('live contract: 6 tools vs mcp.verityskills.com', () => {
  // 1. coordination-heat -> /api/skills/coordination-score (now auth-required).
  it('coordination-heat returns the subject-score shape', async () => {
    const { status, body } = await callTool('coordination-heat', { subject: 'GME' }, TEST_KEY);
    expect(status).toBe(200);
    // The Worker forwards to the free-text subject scorer. Its 200 shape is
    // { subject, score, band, summary, signals_found, sources_checked,
    // window_hours }. This deliberately differs from the pre-rename 6-tab
    // leaderboard shape ({ tab, tickers, note? }) noted in the spec
    // appendix: that probe predated the rename. The empty-vs-nonempty
    // `note` field belonged to the leaderboard route, which the Worker no
    // longer targets. The subject scorer never emits a `note` field, so we
    // assert its stable key set instead.
    expectHasAll(body.result, [
      'subject',
      'score',
      'band',
      'summary',
      'signals_found',
      'sources_checked',
      'window_hours',
    ]);
    expect(body.result, 'subject scorer never emits a note field').not.toHaveProperty('note');
  });

  // 2. verity-score authenticated full shape (spec appendix, verbatim).
  it('verity-score (authenticated) returns ticker/score/explanation/breakdown/asof', async () => {
    const { status, body } = await callTool('verity-score', { subject: 'NVDA' }, TEST_KEY);
    expect(status).toBe(200);
    expectHasAll(body.result, ['ticker', 'score', 'explanation', 'breakdown', 'asof']);
  });

  // 3. morning-brief authenticated shape (spec appendix, verbatim). The
  // Worker schema now requires a non-empty watchlist and no longer
  // advertises the no-op `date` field.
  it('morning-brief (authenticated) returns variant/subject/tickers/asof', async () => {
    const { status, body } = await callTool(
      'morning-brief',
      { watchlist: ['AAPL', 'NVDA'] },
      TEST_KEY,
    );
    expect(status).toBe(200);
    expectHasAll(body.result, ['variant', 'subject', 'tickers', 'asof']);
  });

  // 4. verity-scan authenticated shape (spec appendix, verbatim). subject
  // alias wraps to a single-element tickers array upstream.
  it('verity-scan (authenticated) returns the anomaly-scan shape', async () => {
    const { status, body } = await callTool('verity-scan', { subject: 'AAPL' }, TEST_KEY);
    expect(status).toBe(200);
    expectHasAll(body.result, [
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
    const { status, body } = await callTool(
      'cross-check-alert',
      { claim: 'The Federal Reserve cut rates by 25 basis points on 2026-03-18.' },
      TEST_KEY,
    );
    expect(status).toBe(200);
    expectHasAll(body.result, [
      'verdict',
      'confidence',
      'sources_checked',
      'signals_matched',
      'citations',
      'source_conflicts',
      'summary',
    ]);
    expect(['CORROBORATED', 'CONFLICTED', 'UNVERIFIED', 'NO_SIGNAL']).toContain(
      body.result?.['verdict'],
    );
  });

  // 6. disinfo-alert -> /api/skills/disinfo-monitor. severity_threshold
  // is now required.
  it('disinfo-alert returns the ongoing-monitor shape', async () => {
    const { status, body } = await callTool(
      'disinfo-alert',
      { subject: 'TSLA', severity_threshold: 'medium' },
      TEST_KEY,
    );
    expect(status).toBe(200);
    expectHasAll(body.result, [
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
});

// C3: per-tool auth status codes. This is an intentional, documented
// inconsistency. It is pinned here verbatim so marketplace consumers can
// rely on it and so a future "consistency cleanup" is a deliberate,
// test-breaking decision rather than an accident. Do NOT "fix" this.
liveDescribe('live contract C3: per-tool auth status codes (documented inconsistency)', () => {
  const BOGUS_KEY = 'vtk_definitely_not_a_real_key_000000';

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
