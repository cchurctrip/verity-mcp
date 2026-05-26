// Unit + integration tests for src/oauth-register.ts (RFC 7591 DCR bridge).
//
// Issue #25: Cursor 1.x's mcp.json HTTP install path POSTs to /oauth/register
// before completing OAuth. The Worker now answers with one of the pre-
// registered allowlist client_ids so Cursor proceeds past DCR instead of
// tombstoning the connection on 404.
//
// Coverage:
//   - resolveClientId() maps client_name → allowlisted client_id correctly
//   - POST /oauth/register returns RFC 7591 §3.2.1 success shape (201)
//   - Missing / malformed body falls back to default client_id (`cursor`)
//   - MCP_OAUTH_KILL_SWITCH === 'on' returns 503 + Retry-After
//   - CORS headers present on both 201 and 503 paths

import { describe, expect, it } from 'vitest';
import { SELF } from 'cloudflare:test';
import { handleOauthRegister, resolveClientId } from '../src/oauth-register';

describe('resolveClientId (allowlist mapping)', () => {
  it('matches Cursor (the issue #25 target) case-insensitively', () => {
    expect(resolveClientId('Cursor')).toBe('cursor');
    expect(resolveClientId('cursor-mcp')).toBe('cursor');
    expect(resolveClientId('CURSOR Desktop')).toBe('cursor');
  });

  it('matches Claude Desktop without colliding with the cursor fallback', () => {
    expect(resolveClientId('Claude')).toBe('claude_desktop');
    expect(resolveClientId('claude-desktop')).toBe('claude_desktop');
    expect(resolveClientId('Claude Code')).toBe('claude_desktop');
  });

  it('matches ChatGPT Desktop', () => {
    expect(resolveClientId('ChatGPT')).toBe('chatgpt_desktop');
    expect(resolveClientId('chatgpt-mcp')).toBe('chatgpt_desktop');
  });

  it('matches Gemini CLI', () => {
    expect(resolveClientId('Gemini CLI')).toBe('gemini_cli');
    expect(resolveClientId('gemini')).toBe('gemini_cli');
  });

  it('defaults to cursor on unknown client_name (allowlist-fallback policy)', () => {
    // The fallback intentionally hands back the cursor client_id because
    // every allowlisted client is public (token_endpoint_auth_method: none),
    // so the choice does not grant incremental capability. The downstream
    // /authorize endpoint re-validates the client_id against the consent
    // UI allowlist regardless of what this function returns.
    expect(resolveClientId('SomeNewMcpClient')).toBe('cursor');
    expect(resolveClientId('')).toBe('cursor');
  });

  it('defaults to cursor on non-string client_name (defends against type drift)', () => {
    expect(resolveClientId(undefined)).toBe('cursor');
    expect(resolveClientId(null)).toBe('cursor');
    expect(resolveClientId(42)).toBe('cursor');
    expect(resolveClientId({ name: 'cursor' })).toBe('cursor');
  });
});

describe('handleOauthRegister (unit)', () => {
  function makeReq(body: unknown | undefined): Request {
    if (body === undefined) {
      return new Request('https://mcp.verityskills.com/oauth/register', {
        method: 'POST',
      });
    }
    return new Request('https://mcp.verityskills.com/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  }

  it('returns 201 + RFC 7591 §3.2.1 success shape for a Cursor-shaped request', async () => {
    const res = await handleOauthRegister(
      makeReq({
        client_name: 'Cursor',
        redirect_uris: ['http://localhost:0/oauth/callback'],
      }),
      {},
    );
    expect(res.status).toBe(201);
    expect(res.body['client_id']).toBe('cursor');
    expect(res.body['token_endpoint_auth_method']).toBe('none');
    expect(res.body['grant_types']).toEqual(['authorization_code', 'refresh_token']);
    expect(res.body['response_types']).toEqual(['code']);
    expect(res.body['scope']).toBe('mcp:invoke');
    expect(res.body['redirect_uris']).toEqual(['http://localhost:0/oauth/callback']);
    expect(res.body['client_name']).toBe('Cursor');
    expect(typeof res.body['client_id_issued_at']).toBe('number');
    // client_secret MUST be absent for a public client (RFC 7591 §3.2.1)
    expect(res.body['client_secret']).toBeUndefined();
  });

  it('omits redirect_uris and client_name in the response when the request did not send them', async () => {
    const res = await handleOauthRegister(makeReq({ scope: 'mcp:invoke' }), {});
    expect(res.status).toBe(201);
    expect(res.body['client_id']).toBe('cursor');
    expect(res.body['redirect_uris']).toBeUndefined();
    expect(res.body['client_name']).toBeUndefined();
  });

  it('treats missing body (empty POST) as an empty object and still returns the default client_id', async () => {
    // Cursor 1.x has been observed to issue the initial DCR probe with no
    // body at all. This path must succeed; otherwise the connection
    // tombstones on the 5th retry and the user sees "MCP server errored".
    const res = await handleOauthRegister(makeReq(undefined), {});
    expect(res.status).toBe(201);
    expect(res.body['client_id']).toBe('cursor');
  });

  it('tolerates malformed JSON body (treats as empty object)', async () => {
    const res = await handleOauthRegister(makeReq('not-json-at-all'), {});
    expect(res.status).toBe(201);
    expect(res.body['client_id']).toBe('cursor');
  });

  it('returns 503 + Retry-After when MCP_OAUTH_KILL_SWITCH is on', async () => {
    const res = await handleOauthRegister(
      makeReq({ client_name: 'Cursor' }),
      { MCP_OAUTH_KILL_SWITCH: 'on' },
    );
    expect(res.status).toBe(503);
    expect(res.body['error']).toBe('temporarily_unavailable');
    expect(res.headers?.['Retry-After']).toBe('60');
  });

  it('treats kill-switch values other than "on" as off', async () => {
    for (const v of ['true', '1', 'ON', '', 'yes']) {
      const res = await handleOauthRegister(
        makeReq({ client_name: 'Cursor' }),
        { MCP_OAUTH_KILL_SWITCH: v },
      );
      expect(res.status, `kill switch value=${v}`).toBe(201);
    }
  });

  it('truncates an over-long client_name to 200 chars in the response (defensive)', async () => {
    const longName = 'A'.repeat(500);
    const res = await handleOauthRegister(makeReq({ client_name: longName }), {});
    expect(res.status).toBe(201);
    expect((res.body['client_name'] as string).length).toBe(200);
  });
});

describe('POST /oauth/register (integration via SELF.fetch)', () => {
  it('returns 201 with CORS allow-origin: * for a Cursor-shaped registration', async () => {
    const res = await SELF.fetch('http://example.com/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Cursor',
        redirect_uris: ['http://localhost:0/oauth/callback'],
      }),
    });
    expect(res.status).toBe(201);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['client_id']).toBe('cursor');
    expect(body['token_endpoint_auth_method']).toBe('none');
  });

  it('answers CORS preflight (OPTIONS) with 204 + allow-headers list', async () => {
    const res = await SELF.fetch('http://example.com/oauth/register', {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:3000',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization, content-type',
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('content-type');
  });

  it('returns 201 even when the request has no body (Cursor first-probe shape)', async () => {
    const res = await SELF.fetch('http://example.com/oauth/register', {
      method: 'POST',
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['client_id']).toBe('cursor');
  });

  it('GET /oauth/register is not exposed (registration is POST-only per RFC 7591)', async () => {
    const res = await SELF.fetch('http://example.com/oauth/register', {
      method: 'GET',
    });
    // The Worker's catch-all path returns 404 for unknown routes; this
    // assertion pins that contract so a future refactor cannot silently
    // expose registration over GET.
    expect(res.status).toBe(404);
  });
});
