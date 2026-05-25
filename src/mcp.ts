// JSON-RPC 2.0 framing for the MCP server.
//
// Per VRT-146a spec § Plan/Phase 2 src/mcp.ts. Method dispatch:
//
//   initialize  : returns the byte-identical capability advertisement pinned
//                  by tests/mcp.test.ts (Gate 2 BLOCKING #3 absorbed).
//                  protocolVersion locks to manifest.json.mcp_spec_version.
//   tools/list  : returns the 6 tool definitions from src/tools/index.ts.
//   tools/call  : extracts tool name + arguments from params, runs
//                  proxyToolCall(), then maps each ProxyOutcome kind to a
//                  JSON-RPC envelope per the contract block in upstream.ts.
//
// Envelope validation contract (hidden coupling #6 absorbed):
//   - body parse failure (non-JSON) returns code -32700.
//   - missing or wrong fields ({ jsonrpc, id, method } any absent, jsonrpc not
//     equal to '2.0', method not a string) return code -32600. The id is
//     echoed when parseable; otherwise null per JSON-RPC 2.0 § 5 errors with
//     unparseable requests.
//   - method that passes envelope validation but is not one of the three
//     handled names returns code -32601.
//
// HTTP-status policy (mirrors upstream.ts ProxyOutcome comment block):
//   forward (any non-5xx)       : HTTP = upstream.status, body = JSON-RPC
//                                     result wrapping the (possibly rewritten)
//                                     upstream body. Includes 2xx, 401, 402
//                                     (post upgrade_url rewrite), 403, 404,
//                                     429, etc. The only status that does NOT
//                                     reach this branch is 5xx (handled below).
//   bearer_invalid                : HTTP 401, body = INVALID_BEARER_FORMAT
//                                     plain-object signal. Not wrapped in a
//                                     JSON-RPC envelope so transport-layer
//                                     retry logic (rate limiters, browser
//                                     fetch retries) can see the real status.
//   tool_disabled                 : HTTP 503, body = TOOL_DISABLED plain
//                                     object. Same rationale as above.
//   unknown_tool                  : HTTP 200, JSON-RPC -32602 (invalid params).
//   upstream_5xx                  : HTTP 200, JSON-RPC -32603 with
//                                     error.data.upstream_status and
//                                     error.data.upstream_body. Per spec the
//                                     200 prevents JSON-RPC clients from
//                                     entering HTTP-level retry loops on
//                                     upstream transient failures.
//   upstream_network_error        : HTTP 200, JSON-RPC -32603 with
//                                     error.data.error_name and
//                                     error.data.cause. Same 200 rationale.
//
// All consumers of this module (src/index.ts) wrap the returned { body, status }
// in a Response with CORS headers. Returning the parsed body (not a Response)
// keeps the unit tests free of Response parsing boilerplate.

import { readBearer } from './auth';
import { generateRequestId, type OutcomeKind } from './observability';
import { proxyToolCall, type ProxyEnv, type ProxyOutcome } from './upstream';
import { TOOLS, type Tool } from './tools';

export type McpEnv = ProxyEnv;

export const PROTOCOL_VERSION = '2025-03-26';
export const SERVER_INFO = { name: 'verity-mcp', version: '1.0.0' } as const;

// RFC 6750 §3 + RFC 9728 §5.1. Every 401 emitted from the Worker carries
// this header so MCP clients can discover the protected-resource metadata
// document from a single probe call (the "this connector needs auth, here
// is how" signal Claude Desktop and ChatGPT Desktop key off).
//
// The value uses double quotes per RFC 7235 §2.1; the resource_metadata
// parameter is the RFC 9728-defined pointer to the document on the same
// origin as the resource. Kept as a single exported constant so future
// changes (e.g. adding scope= or error= parameters per RFC 6750) land in
// one place.
export const WWW_AUTHENTICATE_VALUE =
  'Bearer realm="mcp.verityskills.com", resource_metadata="https://mcp.verityskills.com/.well-known/oauth-protected-resource"';

// JSON-RPC 2.0 id is `string | number | null` per spec § 4. Requests without
// an id (notifications) are not supported here: the property test predicate
// rejects them as -32600, matching the MCP request/response model.
export type JsonRpcId = string | number | null;

export interface JsonRpcEnvelope {
  jsonrpc: '2.0';
  id: JsonRpcId;
  method: string;
  params: unknown;
}

export type EnvelopeValidation =
  | { kind: 'valid'; envelope: JsonRpcEnvelope }
  | { kind: 'invalid'; id: JsonRpcId };

// validateEnvelope is pure: same input always yields the same output. The id
// is recovered when the request has a parseable id, otherwise null. This is
// what lets the -32600 response carry the original id when present (per
// JSON-RPC 2.0 § 5: "If there was an error in detecting the id ... it MUST
// be Null").
export function validateEnvelope(body: unknown): EnvelopeValidation {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { kind: 'invalid', id: null };
  }
  const b = body as Record<string, unknown>;
  // Recover the id first so the invalid-envelope return can echo it back
  // even when other fields are malformed (per JSON-RPC 2.0 § 5).
  // `isValidId(undefined)` returns false, so a missing or `undefined` id
  // collapses to `null` here without an extra `'id' in b` check.
  const rawId = b['id'];
  const id: JsonRpcId = isValidId(rawId) ? rawId : null;

  if (b['jsonrpc'] !== '2.0') return { kind: 'invalid', id };
  if (!isValidId(rawId)) return { kind: 'invalid', id };
  if (typeof b['method'] !== 'string') return { kind: 'invalid', id };

  return {
    kind: 'valid',
    envelope: {
      jsonrpc: '2.0',
      id,
      method: b['method'],
      params: b['params'],
    },
  };
}

function isValidId(v: unknown): v is JsonRpcId {
  return typeof v === 'string' || typeof v === 'number' || v === null;
}

// Initialize result is pinned byte-identical. Adding or renaming a key here
// is a marketplace-consumer breakage and a Gate 2 BLOCKING #3 regression.
// The wrapping envelope (jsonrpc + id) varies per request and is not part of
// the byte-identical contract.
export function buildInitializeResult(): {
  protocolVersion: string;
  capabilities: { tools: Record<string, never> };
  serverInfo: typeof SERVER_INFO;
} {
  return {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: { tools: {} },
    serverInfo: SERVER_INFO,
  };
}

// Tools list shape mirrors the MCP spec tools/list response. Each entry
// surfaces the agent-facing description and the JSON Schema for arguments;
// requiresAuth is exposed as a non-spec hint that MCP-client UIs can use to
// prompt for the bearer before issuing tools/call.
//
// outputSchema is optional per the MCP spec and per src/tools/index.ts:Tool.
// VRT-160 added outputSchema to 3 tools (verity-score, verity-scan,
// morning-brief); MCP clients calling tools/list must be able to see those
// schemas. Earlier versions of this builder stripped outputSchema before
// serializing, which kept VRT-160's documentation invisible on the wire.
// The conditional spread keeps tools without outputSchema (currently 3 of 6)
// emitting the same object shape they emit today.
export function buildToolsListResult(): {
  tools: Array<{
    name: string;
    description: string;
    inputSchema: object;
    outputSchema?: object;
    requiresAuth: boolean;
  }>;
} {
  // Widen the per-tool type to Tool here so the optional outputSchema field
  // is reachable. TOOLS is `as const satisfies readonly Tool[]`, which keeps
  // each element at its narrow literal type (and narrow literals do not have
  // optional fields they did not declare).
  const widened: ReadonlyArray<Tool> = TOOLS as ReadonlyArray<Tool>;
  return {
    tools: widened.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      ...(t.outputSchema !== undefined ? { outputSchema: t.outputSchema } : {}),
      requiresAuth: t.requiresAuth,
    })),
  };
}

export interface McpResponse {
  body: unknown;
  status: number;
  // VRT-166: optional response headers beyond the entry layer's default CORS
  // + content-type. Currently used to attach the WWW-Authenticate challenge
  // to every 401 response (RFC 6750 + RFC 9728 resource_metadata pointer).
  headers?: Record<string, string>;
}

// outcomeToResponse maps each ProxyOutcome to its HTTP-status + body. Kept
// separate from handleMcpRequest so the mapping logic can be unit-tested
// without spinning up a fake Request.
//
// MCP tools/call response contract: result MUST include a `content` array
// of content blocks. The verityskills.com skill routes return their raw
// domain payload as JSON (ticker/score/explanation/...); we wrap that
// payload in MCP's content envelope so spec-conforming MCP clients (Claude
// Desktop, ChatGPT Desktop, Comet, Gemini) can render the result. Without
// the wrap, Claude Desktop 1.8500+ surfaces "MCP server returned a
// malformed response (missing content field)" on every tool call. The
// 9/9 transport probes in scripts/multi-client-probe.sh only validated
// framing; this is the inner MCP content-shape contract.
//
// For upstream non-2xx forwards (401/402/403) set isError: true so MCP
// clients render the failure to the user rather than treat the error
// body as a successful tool result.
export function outcomeToResponse(outcome: ProxyOutcome, id: JsonRpcId): McpResponse {
  switch (outcome.kind) {
    case 'forward': {
      const isError = outcome.status < 200 || outcome.status >= 300;
      return {
        body: {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(outcome.body) }],
            ...(isError ? { isError: true } : {}),
          },
        },
        status: outcome.status,
      };
    }
    case 'bearer_invalid':
      return {
        body: {
          code: 'INVALID_BEARER_FORMAT',
          error: "Authorization header must be 'Bearer vtk_<token>' or 'Bearer vto_<token>'",
        },
        status: 401,
        headers: { 'WWW-Authenticate': WWW_AUTHENTICATE_VALUE },
      };
    case 'oauth_token_invalid': {
      // The reason narrowing drives both the HTTP status (401 vs 503) and
      // the error code in the body. Audience mismatch and unknown/expired
      // tokens are 401 with a WWW-Authenticate challenge so clients know to
      // re-run the OAuth flow. Misconfigured / killed / db-unreachable are
      // 503 with Retry-After so on-call sees the operational signal.
      const r = outcome.reason;
      if (r === 'oauth_misconfigured' || r === 'oauth_killed' || r === 'db_unreachable') {
        return {
          body: { code: r.toUpperCase(), error: oauthReasonHuman(r) },
          status: 503,
          headers: { 'Retry-After': '60' },
        };
      }
      // r === 'unknown_token' | 'expired' | 'audience_mismatch'
      const errCode =
        r === 'audience_mismatch' ? 'INVALID_TOKEN_AUDIENCE' : 'OAUTH_TOKEN_INVALID';
      return {
        body: { code: errCode, error: oauthReasonHuman(r) },
        status: 401,
        headers: { 'WWW-Authenticate': WWW_AUTHENTICATE_VALUE },
      };
    }
    case 'tool_disabled':
      return {
        body: { code: 'TOOL_DISABLED', tool: truncateEchoedIdent(outcome.tool) },
        status: 503,
      };
    case 'unknown_tool':
      return {
        body: {
          jsonrpc: '2.0',
          id,
          error: {
            code: -32602,
            message: 'Unknown tool',
            data: { tool: truncateEchoedIdent(outcome.tool) },
          },
        },
        status: 200,
      };
    case 'upstream_5xx':
      return {
        body: {
          jsonrpc: '2.0',
          id,
          error: {
            code: -32603,
            message: 'Upstream verity service unavailable, retry in 30s',
            data: {
              upstream_status: outcome.upstreamStatus,
              upstream_body: outcome.upstreamBody,
            },
          },
        },
        status: 200,
      };
    case 'upstream_network_error':
      return {
        body: {
          jsonrpc: '2.0',
          id,
          error: {
            code: -32603,
            message: 'Upstream verity service unreachable, retry in 30s',
            data: {
              error_name: outcome.errorName,
              cause: outcome.cause,
            },
          },
        },
        status: 200,
      };
  }
}

// Maximum length of a caller-supplied identifier (tool name, JSON-RPC
// method name) that gets echoed back into an error response body. The
// bearer-auth proxy is a public surface; an attacker submitting a 1 MB
// identifier would otherwise see it reflected unbounded. The cap is well
// above the longest real tool name (`cross-check-alert` = 17 chars) and
// the longest expected method name (`tools/list` = 10 chars) plus margin.
const MAX_ECHOED_IDENT_LEN = 64;

function truncateEchoedIdent(name: string): string {
  return name.length > MAX_ECHOED_IDENT_LEN
    ? `${name.slice(0, MAX_ECHOED_IDENT_LEN)}...`
    : name;
}

// Human-readable error strings for each oauth_token_invalid reason. The
// strings are stable (clients log them) but carry no token value. Audience
// mismatch surfaces a distinct INVALID_TOKEN_AUDIENCE code per arch review
// R1; the others share OAUTH_TOKEN_INVALID with a per-reason message so
// on-call can triage from one PR-comment search.
function oauthReasonHuman(
  reason:
    | 'unknown_token'
    | 'expired'
    | 'audience_mismatch'
    | 'db_unreachable'
    | 'oauth_misconfigured'
    | 'oauth_killed',
): string {
  switch (reason) {
    case 'unknown_token':
      return 'OAuth access token not recognized. Re-authorize via the OAuth flow.';
    case 'expired':
      return 'OAuth access token expired. Use the refresh_token grant or re-authorize.';
    case 'audience_mismatch':
      return 'OAuth access token not issued for this resource (audience mismatch).';
    case 'db_unreachable':
      return 'OAuth token store temporarily unreachable. Retry in 60 seconds.';
    case 'oauth_misconfigured':
      return 'OAuth not configured on this Worker. Operator action required.';
    case 'oauth_killed':
      return 'OAuth temporarily disabled by operator. Use a vtk_ user API key.';
  }
}

// Maps a ProxyOutcome to the (upstreamStatus, errorDetail) pair the
// entry-layer log line carries. Exhaustively switched on outcome.kind so a
// new ProxyOutcome variant becomes a compile error here, not a runtime
// silent-default. The same data feeds the JSON-RPC response in
// outcomeToResponse; this helper exists separately because the response
// shape and the log shape have different field names.
function outcomeLogFields(outcome: ProxyOutcome): {
  upstreamStatus: number | null;
  errorDetail: string | null;
} {
  switch (outcome.kind) {
    case 'forward':
      return { upstreamStatus: outcome.upstreamStatus, errorDetail: null };
    case 'upstream_5xx':
      return { upstreamStatus: outcome.upstreamStatus, errorDetail: outcome.cause };
    case 'upstream_network_error':
      return { upstreamStatus: null, errorDetail: `${outcome.errorName}: ${outcome.cause}` };
    case 'bearer_invalid':
      return { upstreamStatus: null, errorDetail: 'INVALID_BEARER_FORMAT' };
    case 'tool_disabled':
      return { upstreamStatus: null, errorDetail: `TOOL_DISABLED:${truncateEchoedIdent(outcome.tool)}` };
    case 'unknown_tool':
      return { upstreamStatus: null, errorDetail: `unknown_tool:${truncateEchoedIdent(outcome.tool)}` };
    case 'oauth_token_invalid':
      return { upstreamStatus: null, errorDetail: `oauth_token_invalid:${outcome.reason}` };
  }
}

// HandleMcpResult carries the response plus the observability fields the
// entry layer needs to emit a useful structured log line: the method (or
// tool name for tools/call), the outcome classification, and the upstream
// HTTP status when one was observed. Without these, every /mcp request
// logs identically and on-call cannot distinguish a bearer-invalid 401
// from an upstream 503 from a kill-switched tool.
export interface HandleMcpResult extends McpResponse {
  requestId: string;
  // The method dispatched: 'initialize' | 'tools/list' | the tool name for
  // tools/call | 'unknown' for any other parsed method | null when the body
  // never parsed or failed envelope validation.
  tool: string | null;
  // Classification of the dispatch outcome. Drives log-line filtering for
  // on-call triage. The canonical OutcomeKind union lives in
  // src/observability.ts and is shared with the structured log line.
  outcomeKind: OutcomeKind;
  // Upstream HTTP status code when proxyToolCall reached the upstream and
  // got a response. Null for outcomes that never produced an upstream call
  // (initialize, tools/list, bearer_invalid, tool_disabled, unknown_tool,
  // upstream_network_error, parse_error, invalid_envelope).
  upstreamStatus: number | null;
  // Surface a short error string when the outcome was a failure. Used by
  // the entry-layer log line to populate the optional `error` field. Null
  // for success outcomes.
  errorDetail: string | null;
}

// handleMcpRequest is the only IO-bearing function in this module. The caller
// in src/index.ts wraps the returned body in a Response and adds CORS
// headers. Returning requestId, tool, outcomeKind, upstreamStatus, and
// errorDetail out-of-band lets the caller log a structured line per
// request that on-call can actually triage with.
export async function handleMcpRequest(
  req: Request,
  env: McpEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<HandleMcpResult> {
  const requestId = generateRequestId();

  let body: unknown;
  try {
    body = await req.json();
  } catch (err) {
    return {
      body: {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' },
      },
      status: 200,
      requestId,
      tool: null,
      outcomeKind: 'parse_error',
      upstreamStatus: null,
      errorDetail: err instanceof Error ? err.message : 'unparseable body',
    };
  }

  const validation = validateEnvelope(body);
  if (validation.kind === 'invalid') {
    return {
      body: {
        jsonrpc: '2.0',
        id: validation.id,
        error: { code: -32600, message: 'Invalid Request' },
      },
      status: 200,
      requestId,
      tool: null,
      outcomeKind: 'invalid_envelope',
      upstreamStatus: null,
      errorDetail: 'envelope failed jsonrpc/id/method validation',
    };
  }

  const { envelope } = validation;

  switch (envelope.method) {
    case 'initialize':
      return {
        body: { jsonrpc: '2.0', id: envelope.id, result: buildInitializeResult() },
        status: 200,
        requestId,
        tool: 'initialize',
        outcomeKind: 'initialize_ok',
        upstreamStatus: null,
        errorDetail: null,
      };

    case 'tools/list':
      return {
        body: { jsonrpc: '2.0', id: envelope.id, result: buildToolsListResult() },
        status: 200,
        requestId,
        tool: 'tools/list',
        outcomeKind: 'tools_list_ok',
        upstreamStatus: null,
        errorDetail: null,
      };

    case 'tools/call': {
      // params must be a plain object. Reject arrays, null, primitives, and
      // omitted-params with -32602 before any further dispatch. The check
      // sits at the JSON-RPC envelope layer (not at proxyToolCall) so the
      // worker never forwards a non-object payload upstream.
      if (typeof envelope.params !== 'object' || envelope.params === null || Array.isArray(envelope.params)) {
        return {
          body: {
            jsonrpc: '2.0',
            id: envelope.id,
            error: {
              code: -32602,
              message: 'Invalid params: tools/call requires an object with a name field',
            },
          },
          status: 200,
          requestId,
          tool: null,
          outcomeKind: 'invalid_params',
          upstreamStatus: null,
          errorDetail: 'params not an object',
        };
      }
      const p = envelope.params as Record<string, unknown>;
      const toolName = p['name'];
      if (typeof toolName !== 'string') {
        return {
          body: {
            jsonrpc: '2.0',
            id: envelope.id,
            error: {
              code: -32602,
              message: 'Invalid params: name must be a string',
            },
          },
          status: 200,
          requestId,
          tool: null,
          outcomeKind: 'invalid_params',
          upstreamStatus: null,
          errorDetail: 'name not a string',
        };
      }
      // arguments must be a plain object when present. Omitted -> {} (spec
      // allows omission). null / array / primitive -> -32602: the worker is
      // a thin proxy and the upstream skill routes all consume objects;
      // forwarding a primitive would silently fail upstream with a wrong-
      // shape error that is hard to attribute back to the caller.
      const rawArgs = p['arguments'];
      if (rawArgs !== undefined && (typeof rawArgs !== 'object' || rawArgs === null || Array.isArray(rawArgs))) {
        return {
          body: {
            jsonrpc: '2.0',
            id: envelope.id,
            error: {
              code: -32602,
              message: 'Invalid params: arguments must be an object when present',
            },
          },
          status: 200,
          requestId,
          tool: truncateEchoedIdent(toolName),
          outcomeKind: 'invalid_params',
          upstreamStatus: null,
          errorDetail: 'arguments not an object',
        };
      }
      const args = rawArgs ?? {};

      const auth = readBearer(req);
      const outcome = await proxyToolCall(toolName, args, auth, requestId, env, fetchImpl);
      const { body: respBody, status, headers: respHeaders } = outcomeToResponse(outcome, envelope.id);
      const { upstreamStatus, errorDetail } = outcomeLogFields(outcome);
      return {
        body: respBody,
        status,
        ...(respHeaders !== undefined ? { headers: respHeaders } : {}),
        requestId,
        tool: truncateEchoedIdent(toolName),
        outcomeKind: outcome.kind,
        upstreamStatus,
        errorDetail,
      };
    }

    default: {
      const echoedMethod = truncateEchoedIdent(envelope.method);
      return {
        body: {
          jsonrpc: '2.0',
          id: envelope.id,
          error: {
            code: -32601,
            message: 'Method not found',
            data: { method: echoedMethod },
          },
        },
        status: 200,
        requestId,
        tool: 'unknown',
        outcomeKind: 'method_not_found',
        upstreamStatus: null,
        errorDetail: `unknown method: ${echoedMethod}`,
      };
    }
  }
}
