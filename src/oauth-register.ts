// POST /oauth/register endpoint (RFC 7591 Dynamic Client Registration).
//
// Why this exists: Cursor's mcp.json HTTP install path executes the RFC 7591
// DCR flow whenever it has no stored client information for the server.
// `discovery doc omits registration_endpoint` is the spec-correct signal to
// fall back to manual client_id entry per RFC 8414 §2, but Cursor 1.x does
// not honour that fallback and instead POSTs to a guessed default path.
// Without a 200 response from a registration endpoint, Cursor's MCP client
// FSM tombstones the connection after 5 consecutive 404s on retries and
// surfaces "The MCP server errored" in the UI. See issue #25 comment 2.
//
// Design: v1 of the Verity OAuth surface is allowlist-only — the consent UI
// at https://verityskills.com/oauth/mcp/authorize accepts a fixed set of
// pre-registered `client_id` values (`cursor`, `claude_desktop`,
// `chatgpt_desktop`, `gemini_cli`). Real DCR would mint a new row per
// registration, but the v1 surface does not support that.
//
// This handler bridges the gap: any DCR request returns a successful
// RFC 7591 §3.2.1 client information response containing one of the
// pre-registered client_ids. The mapping is driven by `client_name` in
// the request body (case-insensitive substring match). Unknown clients
// fall through to `cursor` because:
//
//   1. `cursor` is a public client (`token_endpoint_auth_method: none`),
//      same as every other allowlisted ID — handing it out adds no
//      incremental capability.
//   2. The consent UI re-validates the client_id against the allowlist
//      on every authorize request and will reject a spoofed value
//      regardless of what this endpoint returns.
//   3. The MCP audience-binding check (`aud_uri == CANONICAL_RESOURCE_URI`)
//      runs at every `tools/call` and blocks tokens issued for other
//      resources even if a client somehow obtained one.
//
// Token passthrough ban (parent spec line 387) is unaffected: no token is
// minted here, only a client_id is handed out. Upstream forwarding still
// uses `x-verity-user-id` (NEVER `x-verity-key: vto_*`) per the existing
// tools/call contract.
//
// Kill switch: when MCP_OAUTH_KILL_SWITCH === 'on', registration returns
// 503 with the same `temporarily_unavailable` shape as /oauth/token and
// /authorize, so an operator can disable the OAuth surface end-to-end
// without redeploy.
//
// Rate limiting: not applied here. The endpoint is idempotent (same input
// always returns the same client_id, no DB writes) so a flood attacker
// gains nothing besides CPU on the Worker. The Cloudflare-side L7 limits
// + the kill switch are sufficient.

export interface OauthRegisterEnv {
  MCP_OAUTH_KILL_SWITCH?: string;
}

export interface OauthRegisterResponse {
  body: Record<string, unknown>;
  status: number;
  headers?: Record<string, string>;
}

// Allowlisted client_ids per v1 spec. Order matters: longer / more-specific
// names match before the `cursor` fallback. `claude_desktop` must match
// before `claude` would be picked up by a future MCP client whose name
// starts with that prefix; pinning the full substring keeps the mapping
// stable.
const CLIENT_NAME_MAP: ReadonlyArray<{ pattern: string; clientId: string }> = [
  { pattern: 'claude', clientId: 'claude_desktop' },
  { pattern: 'chatgpt', clientId: 'chatgpt_desktop' },
  { pattern: 'gemini', clientId: 'gemini_cli' },
  { pattern: 'cursor', clientId: 'cursor' },
];

const DEFAULT_CLIENT_ID = 'cursor';

/**
 * Resolves an inbound `client_name` to one of the pre-registered allowlist
 * client_ids. Returns DEFAULT_CLIENT_ID on no match. Case-insensitive
 * substring match — Cursor 1.x sends `client_name: "Cursor"`, ChatGPT
 * Desktop sends `"chatgpt-mcp"`, etc.
 *
 * Exported for unit tests.
 */
export function resolveClientId(clientName: unknown): string {
  if (typeof clientName !== 'string') return DEFAULT_CLIENT_ID;
  const lower = clientName.toLowerCase();
  for (const { pattern, clientId } of CLIENT_NAME_MAP) {
    if (lower.includes(pattern)) return clientId;
  }
  return DEFAULT_CLIENT_ID;
}

/**
 * Top-level handler. The caller in src/index.ts wraps the returned body in
 * a Response and adds the standard CORS headers.
 */
export async function handleOauthRegister(
  req: Request,
  env: OauthRegisterEnv,
): Promise<OauthRegisterResponse> {
  if (env.MCP_OAUTH_KILL_SWITCH === 'on') {
    // Matches the shape /oauth/token and /authorize return on the same
    // switch so callers see one consistent error vocabulary. RFC 6749 §5.2
    // error code reused even though this is a registration endpoint; the
    // alternative `invalid_client_metadata` from RFC 7591 §3.2.2 implies
    // a client-side fix, which is wrong for an operator-disabled state.
    return {
      body: {
        error: 'temporarily_unavailable',
        error_description: 'OAuth temporarily disabled by operator.',
      },
      status: 503,
      headers: { 'Retry-After': '60' },
    };
  }

  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    // RFC 7591 §3.2.2 invalid_client_metadata for malformed body. Some
    // clients (Cursor 1.x observed) send no body at all on the first
    // registration probe; treat that as an empty object so the
    // allowlist-fallback path still hands back the default client_id.
    parsed = {};
  }
  const body = (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed))
    ? (parsed as Record<string, unknown>)
    : {};

  const clientId = resolveClientId(body['client_name']);
  const nowSec = Math.floor(Date.now() / 1000);

  // RFC 7591 §3.2.1 client information response. We surface the exact set
  // of grants + response types + auth method the v1 allowlist permits so
  // a conforming client does not need to consult the AS metadata doc
  // separately. `client_secret` is intentionally omitted: every v1 client
  // is public per `token_endpoint_auth_methods_supported: ["none"]`.
  return {
    body: {
      client_id: clientId,
      client_id_issued_at: nowSec,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: 'mcp:invoke',
      // Echo redirect_uris when the client supplied them so the response
      // shape matches what RFC 7591 §3.2.1 calls for. Validation against
      // the allowlist happens at /authorize, not here.
      ...(Array.isArray(body['redirect_uris']) ? { redirect_uris: body['redirect_uris'] } : {}),
      // Echo client_name so clients can verify the server understood
      // their identity hint. Truncated to 200 chars defensively (DCR
      // requests can carry long descriptive names that would otherwise
      // bloat the response).
      ...(typeof body['client_name'] === 'string'
        ? { client_name: (body['client_name'] as string).slice(0, 200) }
        : {}),
    },
    status: 201,
  };
}
