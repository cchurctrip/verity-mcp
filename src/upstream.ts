// Upstream proxy: translates inbound MCP tool calls into requests to the main
// verityskills.com skill routes. Thin proxy, no state, no DB credentials.
//
// Per VRT-146a spec § Plan/Phase 2 src/upstream.ts and hidden couplings:
//
//   #1 readBearer({ kind: 'invalid' })  -> 401 INVALID_BEARER_FORMAT at Worker edge
//      readBearer({ kind: 'absent' })   -> forward without x-verity-key; upstream returns 401
//                                          for non-anonymous tools, anonymous proxy for
//                                          coordination-heat per VRT-098 policy
//      readBearer({ kind: 'valid' })    -> set x-verity-key to the raw vtk_ token
//
//   #2 402 dual-shape rewrite: typical (upgrade_url + calls_used + calls_remaining)
//      at main repo app/api/skills/verity-score/route.ts:162-171 OR secondary-gate
//      (cap, used, no upgrade_url) at :187-190. Rewrite predicate: status === 402
//      AND body.code === 'TRIAL_CAP_REACHED' -> inject absolute upgrade_url,
//      byte-identical preservation of all other fields (no extras added).
//      Property-tested.
//
//   #4 Per-tool kill switch MCP_TOOLS_DISABLED (comma-separated, trimmed,
//      lowercased) in addition to the global MCP_KILL_SWITCH (handled by the
//      Worker entry, not here).
//
//   #6 Upstream 5xx -> Worker returns Worker-edge HTTP 200 with JSON-RPC error
//      envelope { code: -32603, data: { upstream_status, upstream_body } }.
//      Network failure (DNS, TLS, AbortSignal timeout, non-Error throws) returns
//      a distinct ProxyOutcome kind so a future retry layer can apply correct
//      semantics (retry network errors with backoff; do NOT retry post-response
//      5xx for non-idempotent operations).
//
//   #8 x-verity-key MUST be the raw vtk_ token, no Bearer prefix. The main
//      repo's hashApiKey() at lib/apiKeyAuth.ts:15-17 SHA-256s the raw string.
//
//   #9 x-request-id propagated on every upstream call (including anonymous
//      requests) so on-call can cross-reference Worker logs with main-repo
//      Sentry + PostHog events.

import type { BearerResult } from './auth';

export interface ProxyEnv {
  MCP_TOOLS_DISABLED?: string;
}

const UPSTREAM_BASE = 'https://verityskills.com';
export const UPGRADE_URL_ABSOLUTE = 'https://verityskills.com/upgrade?return_to=mcp&via=cap';
const UPSTREAM_FETCH_TIMEOUT_MS = 30_000;

// The six MCP tools mapped one-to-one to main-repo skill routes. Tool names
// MUST match manifest.json.tools[].name; route paths MUST match the existing
// app/api/skills/<name>/route.ts files. Adding a tool here is one of three
// places to update (also manifest.json + src/tools/<name>.ts).
//
// `as const satisfies` lock-in: keeps the literal record narrow so `ToolName`
// is the exact union of the 6 names. A new tool name added to manifest.json
// but missing here becomes a compile error wherever the consumer imports
// `ToolName`.
export const TOOL_ROUTES = {
  'coordination-heat': '/api/skills/coordination-heat',
  'verity-score':      '/api/skills/verity-score',
  'morning-brief':     '/api/skills/morning-brief',
  'verity-scan':       '/api/skills/verity-scan',
  'cross-check-alert': '/api/skills/cross-check-alert',
  'disinfo-alert':     '/api/skills/disinfo-alert',
} as const satisfies Record<string, string>;

export type ToolName = keyof typeof TOOL_ROUTES;

// Type-guard form. After `if (isKnownTool(name))` the consumer's `name` narrows
// from `string` to `ToolName`, so `TOOL_ROUTES[name]` is typed `string` (not
// `string | undefined` under noUncheckedIndexedAccess).
export function isKnownTool(toolName: string): toolName is ToolName {
  return Object.prototype.hasOwnProperty.call(TOOL_ROUTES, toolName);
}

// Parser for MCP_TOOLS_DISABLED env var. Comma-separated, trimmed, lowercased.
// Empty entries (from leading/trailing/consecutive commas) are ignored.
// Property tests should cover: empty string, single entry, many entries,
// mixed case, embedded whitespace, leading + trailing + consecutive commas,
// unicode whitespace (NBSP, thin space).
export function parseDisabledTools(disabled: string | undefined): Set<string> {
  if (!disabled) return new Set();
  return new Set(
    disabled
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0),
  );
}

export function isToolKillSwitched(toolName: string, env: ProxyEnv): boolean {
  return parseDisabledTools(env.MCP_TOOLS_DISABLED).has(toolName.toLowerCase());
}

// Build the headers for an upstream call. x-request-id is ALWAYS set
// (coupling #9 propagation). x-verity-key is set ONLY when auth.kind ===
// 'valid'; the value is the raw vtk_ token without any Bearer prefix
// (coupling #8 hash equality at lib/apiKeyAuth.ts).
export function buildUpstreamHeaders(auth: BearerResult, requestId: string): Headers {
  const headers = new Headers();
  headers.set('content-type', 'application/json');
  headers.set('x-request-id', requestId);
  if (auth.kind === 'valid') {
    headers.set('x-verity-key', auth.token);
  }
  return headers;
}

// rewriteUpgradeUrl is the load-bearing 402 fix-up. Property-tested target 2
// of 3 from Gate 4. Predicate:
//
//   status === 402 AND body is an object AND body.code === 'TRIAL_CAP_REACHED'
//     -> return a new object with upgrade_url replaced by the absolute URL,
//        same shape as input (no extra keys), every other field byte-identical.
//   Otherwise -> return body unchanged (reference equality).
//
// Both upstream 402 shapes are covered: the typical shape that already has a
// relative upgrade_url field, and the secondary-gate shape with cap + used
// but no upgrade_url. After rewrite both shapes have the absolute URL.
//
// Nested upgrade_url fields (e.g., body.details.upgrade_url) are NOT touched;
// rewrite is top-level only. Property-tested.
export function rewriteUpgradeUrl(status: number, body: unknown): unknown {
  if (status !== 402) return body;
  if (typeof body !== 'object' || body === null) return body;
  const b = body as Record<string, unknown>;
  if (b['code'] !== 'TRIAL_CAP_REACHED') return body;
  return { ...b, upgrade_url: UPGRADE_URL_ABSOLUTE };
}

// ProxyOutcome is the result of a tool-call proxy attempt. The two upstream
// failure modes are kept distinct on purpose:
//   upstream_5xx           -> POST landed at upstream, server returned 5xx with
//                              a (possibly null) body. NOT generically retry-safe
//                              for non-idempotent operations.
//   upstream_network_error -> POST never reached the server (DNS, TLS, abort
//                              timeout, body-already-consumed, etc.). Often
//                              retry-safe with backoff.
//
// src/mcp.ts outcomeToResponse maps each kind to a JSON-RPC envelope:
//   forward                -> JSON-RPC result with the upstream body (status preserved)
//   bearer_invalid         -> HTTP 401 with INVALID_BEARER_FORMAT body
//   tool_disabled          -> HTTP 503 with TOOL_DISABLED body
//   unknown_tool           -> JSON-RPC -32602 (invalid params)
//   upstream_5xx           -> HTTP 200 + JSON-RPC -32603 with error.data
//                              carrying upstream_status + upstream_body
//   upstream_network_error -> HTTP 200 + JSON-RPC -32603 with error.data
//                              carrying error_name + cause
export type ProxyOutcome =
  | { kind: 'forward'; status: number; body: unknown; upstreamStatus: number }
  | { kind: 'bearer_invalid' }
  | { kind: 'tool_disabled'; tool: string }
  | { kind: 'unknown_tool'; tool: string }
  | { kind: 'upstream_5xx'; upstreamStatus: number; upstreamBody: unknown; cause: string }
  | { kind: 'upstream_network_error'; errorName: string; cause: string };

export async function proxyToolCall(
  toolName: string,
  params: unknown,
  auth: BearerResult,
  requestId: string,
  env: ProxyEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<ProxyOutcome> {
  // Reject unknown tools first so the kill-switch surface only reflects
  // the 6 advertised names. Otherwise an attacker probing arbitrary names
  // could distinguish "name in MCP_TOOLS_DISABLED" (-> 503) from "name not
  // in TOOL_ROUTES" (-> -32602) and partially exfiltrate the operator's
  // kill-switch config. Owner kill-switch values are still 6-name-bounded
  // in practice; reordering hardens the contract.
  if (!isKnownTool(toolName)) {
    return { kind: 'unknown_tool', tool: toolName };
  }

  // Per-tool kill switch. Owner can toggle MCP_TOOLS_DISABLED at runtime via
  // wrangler secret put without redeploying. Defense-in-depth alongside the
  // global MCP_KILL_SWITCH check at the entry layer.
  if (isToolKillSwitched(toolName, env)) {
    return { kind: 'tool_disabled', tool: toolName };
  }

  // Bearer regex miss with header present -> deny at the Worker edge with the
  // INVALID_BEARER_FORMAT signal. Spec hidden coupling #1.
  if (auth.kind === 'invalid') {
    return { kind: 'bearer_invalid' };
  }

  // For absent-bearer + non-anonymous tool, the spec is explicit: forward
  // anyway without x-verity-key and let upstream return 401. Keeps the
  // Worker thin and single-source-of-auth-truth. coordination-heat handles
  // anonymous specially upstream via VRT-098 policy. Both cases use the
  // same headers (no x-verity-key) so no special-case here.
  const headers = buildUpstreamHeaders(auth, requestId);
  const url = `${UPSTREAM_BASE}${TOOL_ROUTES[toolName]}`;

  let upstream: Response;
  try {
    upstream = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(params ?? {}),
      signal: AbortSignal.timeout(UPSTREAM_FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    // Pre-response failure. AbortError on timeout, TypeError on DNS/TLS,
    // assorted DOMExceptions on Workers runtime. Non-Error throws are
    // possible from user-instrumented fetchImpl in tests; coerce to string.
    return {
      kind: 'upstream_network_error',
      errorName: err instanceof Error ? err.name : 'NonError',
      cause: err instanceof Error ? err.message : String(err),
    };
  }

  // Parse body as JSON. Non-JSON content (HTML error page from a misbehaving
  // proxy, plain text from a misconfigured handler) becomes null. The 5xx
  // path returns the null body so debugging is preserved; the forward path
  // forwards null to the caller (mcp.ts decides how to render to MCP client).
  let upstreamBody: unknown = null;
  try {
    upstreamBody = await upstream.json();
  } catch {
    // Body was not JSON. Leave upstreamBody = null and let the caller decide.
  }

  // 5xx upstream -> coupling #6 returns a distinct outcome kind. The mcp.ts
  // caller wraps this into a JSON-RPC envelope with HTTP 200 and error.data
  // carrying upstream_status + upstream_body for cross-system debugging.
  if (upstream.status >= 500) {
    return {
      kind: 'upstream_5xx',
      upstreamStatus: upstream.status,
      upstreamBody,
      cause: `upstream ${upstream.status} ${upstream.statusText}`,
    };
  }

  // 402 with TRIAL_CAP_REACHED -> rewrite upgrade_url, forward verbatim
  // otherwise. 2xx, 401, 403 forwarded as-is.
  return {
    kind: 'forward',
    status: upstream.status,
    body: rewriteUpgradeUrl(upstream.status, upstreamBody),
    upstreamStatus: upstream.status,
  };
}
