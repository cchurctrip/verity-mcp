// OAuth 2.1 discovery documents for VRT-166 Phase 1.
//
// Two endpoints, both unauthenticated, both gated by MCP_OAUTH_KILL_SWITCH.
//
//   GET /.well-known/oauth-authorization-server     RFC 8414
//   GET /.well-known/oauth-protected-resource       RFC 9728
//
// Surface split (per spec):
//   - authorization_endpoint lives at https://verityskills.com/oauth/mcp/authorize
//     (Phase 2; consent UI on Next.js)
//   - token_endpoint lives at https://mcp.verityskills.com/oauth/token (this Worker)
//   - registration_endpoint lives at https://mcp.verityskills.com/oauth/register
//     (issue #25; allowlist-only, returns one of the pre-registered client_ids
//     per RFC 7591 client information response shape)
//
// Note: in v1 the registration endpoint was intentionally OMITTED per arch
// review R4 with the assumption that DCR-attempting clients would fall
// through to manual client_id entry. Cursor 1.x does not honour that
// fallback and instead POSTs to a guessed default path, tombstoning the
// connection after 5 consecutive 404s. Issue #25 added the endpoint as a
// minimal allowlist-bridge so Cursor's mcp.json HTTP install path works
// without a manual client_id paste step. See src/oauth-register.ts for
// the implementation rationale.
//
// Kill-switch behavior: when MCP_OAUTH_KILL_SWITCH === 'on', the AS-metadata
// doc omits OAuth-specific endpoints (`authorization_endpoint`,
// `token_endpoint`, `registration_endpoint`) so DCR-attempting clients
// fail-fast and operators can disable OAuth at runtime without redeploy.
// `vtk_*` user-key bearers continue to work. The protected-resource doc
// still advertises the resource but reports no authorization servers so
// MCP clients know not to attempt OAuth.

import { CANONICAL_RESOURCE_URI } from './oauth-canonical';

export interface OauthDiscoveryEnv {
  MCP_OAUTH_KILL_SWITCH?: string;
}

const AUTHORIZATION_ENDPOINT = 'https://verityskills.com/oauth/mcp/authorize';
const TOKEN_ENDPOINT = `${CANONICAL_RESOURCE_URI}/oauth/token`;
const REGISTRATION_ENDPOINT = `${CANONICAL_RESOURCE_URI}/oauth/register`;
const RESOURCE_METADATA_URL = `${CANONICAL_RESOURCE_URI}/.well-known/oauth-protected-resource`;

/**
 * RFC 8414 §3.1 Authorization Server Metadata.
 *
 * Required keys (RFC 8414 §2): issuer, authorization_endpoint, token_endpoint,
 * response_types_supported, grant_types_supported, code_challenge_methods_supported,
 * scopes_supported. `registration_endpoint` advertised so RFC 7591 DCR clients
 * (Cursor 1.x today) auto-discover the bridge endpoint. `jwks_uri` omitted
 * (opaque tokens; no JWT signature verification needed).
 */
export function buildAuthorizationServerMetadata(env: OauthDiscoveryEnv): Record<string, unknown> {
  const killed = env.MCP_OAUTH_KILL_SWITCH === 'on';

  // Issuer per RFC 8414 is the canonical resource URI of the AS, which here
  // is the Worker origin. Even with the kill switch on, the issuer field
  // stays so clients can identify the document; only the endpoint fields
  // drop so clients fail-fast.
  const doc: Record<string, unknown> = {
    issuer: CANONICAL_RESOURCE_URI,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: ['mcp:invoke'],
    token_endpoint_auth_methods_supported: ['none'],
  };

  if (!killed) {
    doc['authorization_endpoint'] = AUTHORIZATION_ENDPOINT;
    doc['token_endpoint'] = TOKEN_ENDPOINT;
    doc['registration_endpoint'] = REGISTRATION_ENDPOINT;
  }

  return doc;
}

/**
 * RFC 9728 §3 Protected Resource Metadata.
 *
 * MCP 2025-06-18 mandates this doc lives on the same origin as the resource.
 * `bearer_methods_supported: ["header"]` per RFC 6750 §2.1 (Authorization
 * request header).
 *
 * `authorization_servers` carries the AS *issuer* identifier (RFC 8414 §2
 * `issuer` value), NOT the AS metadata URL. The MCP TypeScript SDK
 * (mcp-remote, Cursor 1.x, Claude Code 0.x, the official @modelcontextprotocol
 * /sdk) takes `authorization_servers[0]` and runs its OWN buildDiscoveryUrls()
 * against it: for a URL with no path it tries
 * `<origin>/.well-known/oauth-authorization-server`; for a URL with a path
 * it tries `<origin>/.well-known/oauth-authorization-server<path>` plus
 * OIDC variants. If we hand back the metadata URL itself the SDK
 * double-prefixes — `/.well-known/oauth-authorization-server/.well-known/
 * oauth-authorization-server` — gets 404 on every candidate, fails open
 * with `metadata = undefined`, and then `registerClient(asUrl, { metadata:
 * undefined })` falls back to `new URL("/register", asUrl)` which resolves
 * to `https://mcp.verityskills.com/register` (also 404 here). The 404 the
 * client logs is the DCR fallback, not the metadata discovery itself.
 *
 * The PostHog reference server gets this right: its protected-resource
 * metadata returns `authorization_servers: ["https://oauth.posthog.com"]`
 * (issuer URL with no path) and SDK clients construct
 * `https://oauth.posthog.com/.well-known/oauth-authorization-server`
 * correctly.
 *
 * For Verity the AS is colocated with the resource server on the same
 * origin so the issuer is just `CANONICAL_RESOURCE_URI`. Issue #25 part 5.
 *
 * Kill-switch: clears `authorization_servers` so MCP clients know not to
 * attempt OAuth and fall back to the bearer path documented in the manifest.
 */
export function buildProtectedResourceMetadata(env: OauthDiscoveryEnv): Record<string, unknown> {
  const killed = env.MCP_OAUTH_KILL_SWITCH === 'on';

  return {
    resource: CANONICAL_RESOURCE_URI,
    authorization_servers: killed ? [] : [CANONICAL_RESOURCE_URI],
    bearer_methods_supported: ['header'],
    resource_documentation: 'https://verityskills.com/skills',
  };
}

export const RESOURCE_METADATA_URL_EXPORT = RESOURCE_METADATA_URL;
