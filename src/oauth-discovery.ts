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
//
// registration_endpoint is intentionally OMITTED per arch review R4: v1 is
// allowlist-only; DCR-attempting clients fail-fast and fall through to manual
// client_id entry.
//
// Kill-switch behavior: when MCP_OAUTH_KILL_SWITCH === 'on', the AS-metadata
// doc omits OAuth-specific endpoints (`authorization_endpoint`, `token_endpoint`)
// so DCR-attempting clients fail-fast and operators can disable OAuth at
// runtime without redeploy. `vtk_*` user-key bearers continue to work.
// The protected-resource doc still advertises the resource but reports no
// authorization servers so MCP clients know not to attempt OAuth.

import { CANONICAL_RESOURCE_URI } from './oauth-canonical';

export interface OauthDiscoveryEnv {
  MCP_OAUTH_KILL_SWITCH?: string;
}

const AUTHORIZATION_ENDPOINT = 'https://verityskills.com/oauth/mcp/authorize';
const TOKEN_ENDPOINT = `${CANONICAL_RESOURCE_URI}/oauth/token`;
const RESOURCE_METADATA_URL = `${CANONICAL_RESOURCE_URI}/.well-known/oauth-protected-resource`;
const AS_METADATA_URL = `${CANONICAL_RESOURCE_URI}/.well-known/oauth-authorization-server`;

/**
 * RFC 8414 §3.1 Authorization Server Metadata.
 *
 * Required keys (RFC 8414 §2): issuer, authorization_endpoint, token_endpoint,
 * response_types_supported, grant_types_supported, code_challenge_methods_supported,
 * scopes_supported. We intentionally omit `registration_endpoint` (R4) and
 * `jwks_uri` (opaque tokens; no JWT signature verification needed).
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
 * Kill-switch: clears `authorization_servers` so MCP clients know not to
 * attempt OAuth and fall back to the bearer path documented in the manifest.
 */
export function buildProtectedResourceMetadata(env: OauthDiscoveryEnv): Record<string, unknown> {
  const killed = env.MCP_OAUTH_KILL_SWITCH === 'on';

  return {
    resource: CANONICAL_RESOURCE_URI,
    authorization_servers: killed ? [] : [AS_METADATA_URL],
    bearer_methods_supported: ['header'],
    resource_documentation: 'https://verityskills.com/skills',
  };
}

export const RESOURCE_METADATA_URL_EXPORT = RESOURCE_METADATA_URL;
