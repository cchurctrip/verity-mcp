// Phase 1 smoke test. Validates that the Worker scaffold responds to the
// three endpoints required by the synthetic-smoke cron (/health), marketplace
// consumers (/sse stub, GET /), and MCP clients (OPTIONS preflight).
// Phase 2 will add real tests for /mcp dispatch, auth, upstream proxying.

import { describe, expect, it } from 'vitest';
import { SELF } from 'cloudflare:test';

describe('GET /health', () => {
  // /health MUST stay reachable when MCP_KILL_SWITCH is engaged so on-call
  // can distinguish operator-disabled from service-crashed states. The
  // kill_switch_engaged flag surfaces the disabled state to the smoke cron.
  it('returns 200 with status ok, uptime_s, and kill_switch_engaged', async () => {
    const res = await SELF.fetch('http://example.com/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['status']).toBe('ok');
    expect(typeof body['uptime_s']).toBe('number');
    expect(typeof body['commit']).toBe('string');
    expect(typeof body['kill_switch_engaged']).toBe('boolean');
    expect(body['kill_switch_engaged']).toBe(false);
  });
});

describe('OPTIONS preflight', () => {
  it('returns 204 with permissive CORS headers on /mcp', async () => {
    const res = await SELF.fetch('http://example.com/mcp', { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('authorization');
  });

  it('returns 204 with permissive CORS headers on /health', async () => {
    const res = await SELF.fetch('http://example.com/health', { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });
});

describe('GET /sse (stub)', () => {
  it('returns 405 with JSON-RPC -32601 envelope', async () => {
    const res = await SELF.fetch('http://example.com/sse');
    expect(res.status).toBe(405);
    const body = (await res.json()) as { error?: { code?: number } };
    expect(body.error?.code).toBe(-32601);
  });
});

describe('GET /', () => {
  it('redirects to verityskills.com/skills', async () => {
    const res = await SELF.fetch('http://example.com/', { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('https://verityskills.com/skills');
  });
});

describe('Unknown path', () => {
  it('returns 404', async () => {
    const res = await SELF.fetch('http://example.com/nope');
    expect(res.status).toBe(404);
  });
});
