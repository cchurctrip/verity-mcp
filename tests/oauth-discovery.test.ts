// Unit tests for src/oauth-discovery.ts (RFC 8414 + RFC 9728 docs).
//
// The two builders are pure; we exercise them directly without SELF.fetch.
// SELF.fetch coverage of the routing is implicit via the existing /health
// tests (any 404 here would already break those).

import { describe, expect, it } from 'vitest';
import {
  buildAuthorizationServerMetadata,
  buildProtectedResourceMetadata,
} from '../src/oauth-discovery';

describe('buildAuthorizationServerMetadata (RFC 8414)', () => {
  it('returns spec-required keys with the right values', () => {
    const doc = buildAuthorizationServerMetadata({});
    expect(doc['issuer']).toBe('https://mcp.verityskills.com');
    expect(doc['authorization_endpoint']).toBe('https://verityskills.com/oauth/mcp/authorize');
    expect(doc['token_endpoint']).toBe('https://mcp.verityskills.com/oauth/token');
    expect(doc['response_types_supported']).toEqual(['code']);
    expect(doc['grant_types_supported']).toEqual(['authorization_code', 'refresh_token']);
    expect(doc['code_challenge_methods_supported']).toEqual(['S256']);
    expect(doc['scopes_supported']).toEqual(['mcp:invoke']);
    expect(doc['token_endpoint_auth_methods_supported']).toEqual(['none']);
  });

  it('advertises registration_endpoint (issue #25: RFC 7591 DCR bridge)', () => {
    // Per issue #25 the AS metadata now advertises the registration endpoint
    // so RFC 7591 DCR clients (Cursor 1.x today) auto-discover the bridge.
    // The endpoint itself is implemented in src/oauth-register.ts and serves
    // the pre-registered allowlist client_ids.
    const doc = buildAuthorizationServerMetadata({});
    expect(doc['registration_endpoint']).toBe('https://mcp.verityskills.com/oauth/register');
  });

  it('omits authorization_endpoint + token_endpoint + registration_endpoint when MCP_OAUTH_KILL_SWITCH is on', () => {
    const doc = buildAuthorizationServerMetadata({ MCP_OAUTH_KILL_SWITCH: 'on' });
    expect(doc['authorization_endpoint']).toBeUndefined();
    expect(doc['token_endpoint']).toBeUndefined();
    expect(doc['registration_endpoint']).toBeUndefined();
    // issuer + non-OAuth-endpoint keys remain so clients can identify the doc
    expect(doc['issuer']).toBe('https://mcp.verityskills.com');
    expect(doc['scopes_supported']).toEqual(['mcp:invoke']);
  });

  it('treats any value other than "on" as off (defense against truthy-string drift)', () => {
    for (const v of ['true', '1', 'yes', 'ON', '']) {
      const doc = buildAuthorizationServerMetadata({ MCP_OAUTH_KILL_SWITCH: v });
      expect(doc['token_endpoint']).toBe('https://mcp.verityskills.com/oauth/token');
      expect(doc['registration_endpoint']).toBe('https://mcp.verityskills.com/oauth/register');
    }
  });
});

describe('buildProtectedResourceMetadata (RFC 9728)', () => {
  it('returns canonical resource + authorization_servers pointer + bearer header method', () => {
    const doc = buildProtectedResourceMetadata({});
    expect(doc['resource']).toBe('https://mcp.verityskills.com');
    expect(doc['authorization_servers']).toEqual([
      'https://mcp.verityskills.com/.well-known/oauth-authorization-server',
    ]);
    expect(doc['bearer_methods_supported']).toEqual(['header']);
  });

  it('returns empty authorization_servers when MCP_OAUTH_KILL_SWITCH is on', () => {
    const doc = buildProtectedResourceMetadata({ MCP_OAUTH_KILL_SWITCH: 'on' });
    expect(doc['resource']).toBe('https://mcp.verityskills.com');
    expect(doc['authorization_servers']).toEqual([]);
    // resource_documentation always present
    expect(typeof doc['resource_documentation']).toBe('string');
  });
});
