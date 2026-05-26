// Worker entry. Routes /health, /mcp, /sse, and / and applies the global
// kill switch + CORS to every response. The JSON-RPC dispatch logic lives in
// src/mcp.ts; this module is the IO boundary that wraps the handler return
// in a Response with permissive CORS headers and emits the structured log
// line.
//
// VRT-165 multi-client transport:
//   - POST /mcp content-negotiates on the Accept header. When Accept
//     contains text/event-stream, the JSON-RPC response is wrapped as a
//     single SSE `event: message` frame and the stream closes (Streamable
//     HTTP, MCP 2025-03-26). Otherwise it stays Content-Type
//     application/json (legacy Cursor + synthetic-smoke contract).
//   - GET /sse opens an EventSource-style stream and emits an
//     `event: endpoint` frame for the POST endpoint (legacy SSE, MCP
//     2024-11-05).
//   - POST /sse forwards the JSON-RPC envelope through handleMcpRequest
//     and relays the response over the open GET /sse stream when both
//     sides landed on the same isolate; falls back to HTTP 202 with the
//     envelope in the body when they did not.
//
// Transport-level errors (bearer_invalid 401, tool_disabled 503, kill
// switch 503) stay non-envelope JSON regardless of Accept. Streaming a
// 503 would confuse clients that retry on HTTP status, not on envelope
// content.
//
// The default export is wrapped with Sentry.withSentry so any uncaught
// exception inside the fetch handler flows to Sentry with the
// scrubAuthorization beforeSend hook applied. When SENTRY_DSN is unset
// (local dev, pre-deploy), buildSentryConfig returns undefined and
// withSentry gracefully no-ops; the handler runs unwrapped.

import * as Sentry from '@sentry/cloudflare';

import { readBearer } from './auth';
import { handleMcpRequest, WWW_AUTHENTICATE_VALUE, type McpEnv } from './mcp';
import {
  buildAuthorizationServerMetadata,
  buildProtectedResourceMetadata,
  type OauthDiscoveryEnv,
} from './oauth-discovery';
import { CANONICAL_RESOURCE_URI } from './oauth-canonical';
import { handleOauthRegister, type OauthRegisterEnv } from './oauth-register';
import { handleOauthToken, type OauthTokenEnv } from './oauth-token';
import {
  buildLogLine,
  buildSentryConfig,
  logRequest,
  type ObservabilityEnv,
} from './observability';
import {
  acceptHeaderRequestsSse,
  openSseEndpointStream,
  relaySsePostToStream,
  respondSseEnvelope,
  sha256HexBearer,
} from './transport-sse';

// Env is the union of every binding the Worker entry needs. Extending the
// two sub-module env shapes makes the coupling load-bearing in the type
// system: adding a required key to McpEnv or ObservabilityEnv becomes a
// compile error here rather than silently working until the first request
// in production.
export interface Env extends McpEnv, ObservabilityEnv, OauthDiscoveryEnv, OauthRegisterEnv, OauthTokenEnv {
  MCP_KILL_SWITCH?: string;
  /**
   * Build-time stamped git SHA of the deployed Worker. Set by the deploy
   * command via `wrangler deploy --var COMMIT_SHA:$(git rev-parse HEAD)`.
   * Surfaces in /health so an operator (or the synthetic-smoke cron in the
   * parent repo) can confirm which commit is live without grepping logs or
   * re-running the live-contract probe. Falls back to 'unknown' when not
   * set (local `wrangler dev`, or a deploy that skipped the --var injection).
   */
  COMMIT_SHA?: string;
}

// Cloudflare Workers production runtime returns 0 from Date.now() at module
// scope (Spectre mitigation; Date.now() only returns a real time after some
// I/O has happened). workerd locally returns the real time and hides this.
// Initialize lazily on the first request so uptime_s is computed correctly
// in production. First request sees uptime_s = 0; subsequent requests on the
// same isolate see real positive uptime.
let bootTimeMs: number | null = null;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
} as const;

const handler = {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Lazy boot-time initialization. See comment near declaration: Date.now()
    // returns 0 at module scope in production but the real time inside a
    // request handler. Capturing on first request gives correct uptime math.
    bootTimeMs ??= Date.now();

    const url = new URL(req.url);

    // OPTIONS preflight is independent of the kill switch (browsers must
    // resolve CORS before sending the real request that would hit it).
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // /health is the synthetic-smoke target. It MUST stay reachable when the
    // kill switch is engaged so on-call can distinguish "operator-disabled
    // (kill_switch_engaged: true)" from "service crashed (no response)".
    // The smoke cron reads kill_switch_engaged and records status=skipped
    // when true instead of paging Sentry.
    if (req.method === 'GET' && url.pathname === '/health') {
      const killSwitchEngaged = env.MCP_KILL_SWITCH === 'on';
      return jsonResponse(
        {
          status: 'ok',
          commit: env.COMMIT_SHA ?? 'unknown',
          uptime_s: Math.floor((Date.now() - bootTimeMs) / 1000),
          kill_switch_engaged: killSwitchEngaged,
        },
        200,
      );
    }

    if (env.MCP_KILL_SWITCH === 'on') {
      return jsonResponse(
        {
          jsonrpc: '2.0',
          id: null,
          error: {
            code: -32000,
            message: 'Service temporarily unavailable',
            data: { code: 'KILL_SWITCH_ENGAGED' },
          },
        },
        503,
      );
    }

    // VRT-166 OAuth 2.1 surface. Four routes (two discovery + token +
    // register).
    //
    // Discovery endpoints (RFC 8414 + RFC 9728) are public, unauthenticated,
    // and gated only by the global MCP_KILL_SWITCH (already returned above)
    // and the OAuth-specific MCP_OAUTH_KILL_SWITCH (handled inside the
    // builders, which omit OAuth-specific fields including the
    // registration_endpoint so DCR-attempting clients fail-fast and fall
    // through to the bearer path).
    //
    // Path-scoped well-known URLs (issue #25 follow-up): MCP 2025-06-18 §2.3
    // mandates that when the MCP endpoint lives at a sub-path, the metadata
    // URL is constructed by inserting `/.well-known/<doc>` between host and
    // path. For Verity's `/mcp` endpoint that means clients query
    // `/.well-known/oauth-protected-resource/mcp` (and the AS analog).
    // Cursor 1.x and Claude Code 0.x both probe the path-scoped form before
    // falling back to the unscoped form; without these routes Cursor sees
    // 404 on discovery, then 404 on its DCR fallback path, and tombstones
    // the streamable-HTTP connection after 5 consecutive 404s. PostHog's
    // MCP server serves both forms (mcp.posthog.com/.well-known/
    // oauth-protected-resource/mcp returns 200), which is how this was
    // diagnosed.
    //
    // Both forms return identical documents — the canonical resource value
    // stays `https://mcp.verityskills.com` (host-only, no `/mcp` path) so
    // audience binding for existing `vto_*` tokens (aud: canonical resource)
    // continues to work unchanged. The path suffix in the metadata URL is
    // purely a discovery-routing artifact, not a separate resource.
    if (
      req.method === 'GET'
      && (url.pathname === '/.well-known/oauth-authorization-server'
        || url.pathname === '/.well-known/oauth-authorization-server/mcp')
    ) {
      return jsonResponse(buildAuthorizationServerMetadata(env), 200);
    }
    if (
      req.method === 'GET'
      && (url.pathname === '/.well-known/oauth-protected-resource'
        || url.pathname === '/.well-known/oauth-protected-resource/mcp')
    ) {
      return jsonResponse(buildProtectedResourceMetadata(env), 200);
    }

    // GET /authorize: 302 redirect to the consent UI on the Verity Next.js
    // origin, preserving every query param after normalizing the
    // `resource` param to the canonical no-trailing-slash form. Every
    // OAuth-capable MCP client funnels through here now (#25 part 6):
    //   - Spec-conformant clients (mcp-remote, the official
    //     @modelcontextprotocol/sdk, Cursor 1.x via mcp-remote, Claude
    //     Code 0.x) honor `authorization_endpoint` from the discovery
    //     doc, which we point at this Worker route.
    //   - Spec-loose clients (Claude Desktop confirmed 2026-05-25; some
    //     paths in Cursor 1.x + ChatGPT Desktop + Gemini CLI) construct
    //     the authorize URL as `<server_url_host>/authorize` and ignore
    //     the metadata. Same route, same handler.
    // The normalization step matters because the WHATWG URL parser
    // (used by the SDK to build the authorize URL) ALWAYS adds a
    // trailing slash to `https://mcp.verityskills.com`, so SDK clients
    // emit `resource=https://mcp.verityskills.com/` which the consent
    // UI's strict-equality v1 allowlist then rejects with "Connection
    // blocked / resource must be 'https://mcp.verityskills.com'". The
    // looser canonical comparator below catches that case (and the
    // other RFC 3986 §6 equivalent forms: lowercase host, default
    // port, mixed case) without weakening the downstream audience
    // check on tokens.
    //
    // Gated by MCP_OAUTH_KILL_SWITCH per parity with the discovery doc
    // (which omits authorization_endpoint when on) and /oauth/token
    // (which returns 503 oauth_killed when on). Without this guard the
    // redirect would still send users to the consent UI, which would
    // then hit a kill-switched /oauth/token and surface a confusing
    // generic 503 instead of a clean Retry-After signal at the entry
    // point.
    if (req.method === 'GET' && url.pathname === '/authorize') {
      if (env.MCP_OAUTH_KILL_SWITCH === 'on') {
        // RFC 6749 §5.2 error code. Matches the shape /oauth/token returns
        // on the same switch so callers see one consistent error vocabulary.
        return jsonResponse(
          {
            error: 'temporarily_unavailable',
            error_description: 'OAuth temporarily disabled by operator.',
          },
          503,
          { 'Retry-After': '60' },
        );
      }
      const consentUrl = new URL('https://verityskills.com/oauth/mcp/authorize');
      url.searchParams.forEach((value, key) => {
        consentUrl.searchParams.set(key, value);
      });
      // Default the v1 allowlisted values for params some MCP clients omit.
      // Claude Desktop confirmed 2026-05-25: emits the authorize URL with
      // response_type + client_id + redirect_uri + code_challenge + state
      // but NO scope (and sometimes no resource or no
      // code_challenge_method). The Phase 2 consent UI is strict and
      // rejects with "Missing scope" otherwise. Since v1's pre-registered
      // allowlist permits exactly one scope (`mcp:invoke`), one resource
      // (`https://mcp.verityskills.com`), and one PKCE method (`S256`),
      // defaulting at the entry point is equivalent to enforcing the
      // allowlist downstream and saves a manual reconfig step on the
      // client side. The consent UI re-validates either way, so a
      // tampered request reaching the consent UI directly still gets
      // the same enforcement. Client-provided values win (no overwrite).
      if (!consentUrl.searchParams.has('scope')) {
        consentUrl.searchParams.set('scope', 'mcp:invoke');
      }
      if (!consentUrl.searchParams.has('resource')) {
        consentUrl.searchParams.set('resource', CANONICAL_RESOURCE_URI);
      }
      if (!consentUrl.searchParams.has('code_challenge_method')) {
        consentUrl.searchParams.set('code_challenge_method', 'S256');
      }
      // Canonicalize the resource: if the client sent a value that points
      // to the canonical host with at most a bare-slash path (e.g.,
      // trailing-slash variant `https://mcp.verityskills.com/`, mixed-case
      // host, explicit-default port :443), normalize to the literal
      // constant so the Phase 2 consent UI's strict-equality match works.
      // Claude Desktop 2026-05-25 confirmed: emits
      // resource=https://mcp.verityskills.com/ (trailing slash) which the
      // consent UI strict-rejects. We deliberately do NOT use the strict
      // isCanonicalResourceUri helper here (it rejects any path including
      // bare `/`); the looser parse-then-compare logic accepts the
      // equivalent forms a real OAuth client emits without weakening the
      // security check downstream (consent UI + Worker tools/call audience
      // check both re-validate against the canonical constant). Values
      // that fail this loose match pass through and the consent UI
      // rejects with the same `resource must be "..."` message.
      const requestedResource = consentUrl.searchParams.get('resource');
      if (requestedResource !== null && isCanonicalEquivalent(requestedResource)) {
        consentUrl.searchParams.set('resource', CANONICAL_RESOURCE_URI);
      }
      return Response.redirect(consentUrl.toString(), 302);
    }

    // /oauth/register (RFC 7591). Dynamic Client Registration bridge for
    // allowlist-only v1 (issue #25). Returns the pre-registered client_id
    // matching the inbound `client_name` (case-insensitive substring) so
    // Cursor 1.x's mcp.json HTTP install path proceeds past its DCR step
    // instead of tombstoning the connection on a 404. Kill-switched in
    // parity with /oauth/token. See src/oauth-register.ts for the
    // security argument.
    if (req.method === 'POST' && url.pathname === '/oauth/register') {
      const registerResult = await handleOauthRegister(req, env);
      return jsonResponse(registerResult.body, registerResult.status, registerResult.headers);
    }

    // /oauth/token (RFC 6749). authorization_code + refresh_token grants
    // with PKCE S256 + RFC 8707 resource indicator + audience binding.
    // Kill-switch returns 503 with Retry-After; misconfigured (no Supabase
    // secret) returns 503 with the oauth_misconfigured sentinel so operators
    // can see the misconfiguration in the smoke cron.
    if (req.method === 'POST' && url.pathname === '/oauth/token') {
      const tokenResult = await handleOauthToken(req, env);
      return jsonResponse(tokenResult.body, tokenResult.status, tokenResult.headers);
    }

    // Legacy SSE bridge for clients that need EventSource-style handshake
    // (Perplexity Comet, MCP 2024-11-05). GET opens the stream; POST
    // forwards a JSON-RPC envelope through the existing dispatch and
    // relays the response over the open same-isolate stream. See
    // src/transport-sse.ts for the framing contract and cross-isolate
    // fallback policy (VRT-165).
    //
    // Path-scoped /sse/mcp accepted for symmetry with the path-scoped
    // well-known URLs (MCP 2025-06-18 §2.3). Cursor 1.x's streamable-HTTP
    // failure path falls back to legacy SSE by appending the MCP server
    // sub-path to the SSE URL — without the alias the fallback hits 404
    // and the user sees `Error connecting to SSE server after fallback`
    // in the MCP log even though the streamable-HTTP failure was unrelated
    // to /sse semantics.
    if (
      req.method === 'GET'
      && (url.pathname === '/sse' || url.pathname === '/sse/mcp')
    ) {
      const auth = readBearer(req);
      // /sse currently supports only the vtk_* user-API-key path. OAuth-token
      // (vto_) callers are explicitly rejected here because the legacy SSE
      // bridge stores the bearer-hash without round-tripping through the
      // OAuth validation layer; a future story can extend the bridge for
      // OAuth tokens but for Phase 1 the vto_ path uses Streamable HTTP on
      // POST /mcp only.
      if (auth.kind !== 'valid') {
        return jsonResponse(
          {
            code: 'INVALID_BEARER_FORMAT',
            error: "Authorization header must be 'Bearer vtk_<token>'",
          },
          401,
          { 'WWW-Authenticate': WWW_AUTHENTICATE_VALUE },
        );
      }
      const bearerHash = await sha256HexBearer(auth.token);
      return openSseEndpointStream(bearerHash, url, ctx);
    }

    if (
      req.method === 'POST'
      && (url.pathname === '/sse' || url.pathname === '/sse/mcp')
    ) {
      const startedAt = Date.now();
      const result = await handleMcpRequest(req, env);
      logRequest(
        buildLogLine({
          request_id: result.requestId,
          outcome_kind: result.outcomeKind,
          tool: result.tool,
          upstream_status: result.upstreamStatus,
          latency_ms: Date.now() - startedAt,
          auth_present: req.headers.get('authorization') !== null,
          ...(result.errorDetail !== null ? { error: result.errorDetail } : {}),
        }),
      );

      // Try to relay the response over the open GET /sse stream for this
      // bearer when both sides landed on the same isolate. On success the
      // client receives the envelope as an SSE `event: message` on the GET
      // stream and the POST replies HTTP 202 with no body. Transport-level
      // errors (status !== 200) and bearer-absent/invalid cases skip the
      // relay and respond with the envelope inline so the client sees the
      // right HTTP status on its retry layer.
      //
      // The relay returns a three-valued outcome so a "no open stream"
      // (the documented cross-isolate fallback) is distinguishable in logs
      // from a "stream open but write errored" (a real anomaly worth
      // investigating). Both fall back to the inline-envelope response;
      // only the log lines differ.
      if (result.status === 200) {
        const auth = readBearer(req);
        if (auth.kind === 'valid') {
          const bearerHash = await sha256HexBearer(auth.token);
          const relayOutcome = await relaySsePostToStream(result.body, bearerHash);
          if (relayOutcome === 'relayed') {
            return new Response(null, { status: 202, headers: CORS_HEADERS });
          }
        }
      }

      // MCP 2024-11-05 section 6.2.2 fallback.
      return jsonResponse(result.body, result.status, result.headers);
    }

    // GET /mcp → 405 Method Not Allowed (MCP 2025-03-26 §3.5 Streamable
    // HTTP). The spec allows two modes for the server-to-client direction:
    // (a) open an SSE stream on GET, or (b) return 405 to signal "no
    // server-initiated streaming, client posts only". Verity implements (b)
    // because all current tool calls are synchronous request/response
    // (upstream verityskills.com returns JSON envelopes, no long-running
    // jobs that would need server-push) and adding an SSE stream here
    // would complicate the auth + token-passthrough story without a
    // user-visible win.
    //
    // Without this branch GET /mcp falls through to the catch-all 404,
    // which Cursor 1.x's MCP client interprets as "streamable HTTP not
    // supported, fall back to legacy SSE". The fallback chain then also
    // 404s (since Cursor probes /sse/mcp before our path-scoped alias
    // existed) and the user sees `Error connecting to streamableHttp
    // server` plus `Error connecting to SSE server after fallback` in the
    // MCP log even though POST /mcp would have worked. 405 is the
    // spec-correct "don't fall back" signal.
    //
    // Path-scoped /mcp/mcp is not aliased here intentionally: the MCP
    // server URL is /mcp, period. The path-scoped well-known URLs are a
    // discovery convention (RFC 9728 §3.1), not a request-routing
    // convention.
    if (req.method === 'GET' && url.pathname === '/mcp') {
      return new Response(
        JSON.stringify({
          code: 'METHOD_NOT_ALLOWED',
          error: 'GET /mcp is not supported; POST a JSON-RPC envelope instead. See MCP 2025-03-26 §3.5.',
        }),
        {
          status: 405,
          headers: {
            ...CORS_HEADERS,
            'Content-Type': 'application/json',
            // RFC 7231 §7.4.1: 405 responses MUST include Allow.
            Allow: 'POST, OPTIONS',
          },
        },
      );
    }

    if (req.method === 'POST' && url.pathname === '/mcp') {
      // RFC 6750 + RFC 9728 eager-OAuth challenge (issue #25). When the
      // request has no Authorization header at all, short-circuit with a
      // 401 + WWW-Authenticate BEFORE handleMcpRequest. This is what drives
      // Cursor's `mcp.json` direct-HTTP install path through OAuth: Cursor's
      // FSM keys off the 401 challenge during connection-open to discover
      // the auth server and trigger the consent flow. Without the challenge
      // Cursor stays in `auth=unknown`, never enumerates tools, and the
      // user sees "No tools, prompts, or resources" in the MCP settings
      // panel even though OAuth metadata was fetched.
      //
      // Previously the Worker served unauthenticated `initialize` and
      // `tools/list` as 200 to support a lazy-OAuth pattern (anonymous
      // metadata exchange, then 401 on the first `tools/call`). That
      // pattern works for Claude Desktop today (see comment in
      // outcomeToResponse 'forward' case in src/mcp.ts) but is incompatible
      // with Cursor 1.x's mcp.json HTTP path, ChatGPT Desktop's connector
      // flow, and the RFC 6750 §3 expectation that any access to a
      // protected resource without a valid token gets a 401 challenge.
      // The eager challenge subsumes the lazy one: clients that handle
      // 401-on-tools/call (Claude Desktop today) also handle 401-on-any-
      // request because the OAuth response to a 401 is the same. The
      // anonymous-fallback story for verity-score / morning-brief is
      // dropped intentionally; both tools returned zero-stub data without
      // auth and were not useful in practice.
      //
      // A malformed Authorization header (kind === 'invalid') is NOT
      // caught here. handleMcpRequest's existing bearer_invalid path
      // returns 401 + WWW-Authenticate with the INVALID_BEARER_FORMAT
      // code, which gives clients a distinct signal ("you sent something,
      // but I don't recognize it" vs "you sent nothing"). Valid vtk_ or
      // vto_ tokens pass through; OAuth-token validity is re-checked at
      // tools/call dispatch time against mcp_oauth_tokens.
      const inboundAuth = readBearer(req);
      if (inboundAuth.kind === 'absent') {
        return new Response(
          JSON.stringify({
            code: 'AUTHENTICATION_REQUIRED',
            error:
              "Authorization header required. Complete OAuth at https://mcp.verityskills.com/authorize or send 'Bearer vtk_<token>'.",
          }),
          {
            status: 401,
            headers: {
              ...CORS_HEADERS,
              'Content-Type': 'application/json',
              'WWW-Authenticate': WWW_AUTHENTICATE_VALUE,
            },
          },
        );
      }

      const startedAt = Date.now();
      const result = await handleMcpRequest(req, env);

      // Structured log line. Carries the dispatched tool (or method name for
      // initialize / tools/list), the outcome classification, and the
      // upstream HTTP status when one was observed. On-call uses
      // outcome_kind to distinguish upstream_5xx from upstream_network_error
      // from bearer_invalid; tool to attribute regressions to a specific
      // skill route; upstream_status to spot upstream-side regressions
      // separate from Worker-side. Never logs the bearer token or request
      // body. The bearer is captured only as the `auth_present` boolean.
      logRequest(
        buildLogLine({
          request_id: result.requestId,
          outcome_kind: result.outcomeKind,
          tool: result.tool,
          upstream_status: result.upstreamStatus,
          latency_ms: Date.now() - startedAt,
          auth_present: req.headers.get('authorization') !== null,
          ...(result.errorDetail !== null ? { error: result.errorDetail } : {}),
        }),
      );

      // Streamable HTTP content negotiation (VRT-165). When the Accept
      // header lists text/event-stream AND the dispatch returned a 200
      // (i.e., not a transport-level error), wrap the envelope in a single
      // SSE `event: message` frame and close the stream. Otherwise respond
      // with Content-Type application/json (existing contract for Cursor +
      // synthetic-smoke). Transport-level errors stay non-envelope JSON
      // regardless of Accept.
      const wantsSse =
        result.status === 200 &&
        acceptHeaderRequestsSse(req.headers.get('accept'));
      if (wantsSse) {
        return respondSseEnvelope(result.body, result.status);
      }
      return jsonResponse(result.body, result.status, result.headers);
    }

    if (req.method === 'GET' && url.pathname === '/') {
      // Manual 302 instead of Response.redirect() so we can attach CORS
      // headers. Response.redirect() returns a fixed response with no way
      // to add headers; browser clients hitting cross-origin would fail the
      // preflight before following the redirect.
      return new Response(null, {
        status: 302,
        headers: {
          ...CORS_HEADERS,
          Location: 'https://verityskills.com/skills',
        },
      });
    }

    return new Response('Not Found', { status: 404, headers: CORS_HEADERS });
  },
} satisfies ExportedHandler<Env>;

// Sentry.withSentry wraps the handler. The wrap is unconditional: the SDK
// always installs the fetch proxy and initializes the client. When
// SENTRY_DSN is unset (local dev, pre-deploy), buildSentryConfig returns
// undefined and the SDK initializes with no DSN; captured events fail to
// transmit at the transport layer. When SENTRY_DSN is set (production),
// uncaught exceptions inside the fetch handler flow to Sentry with the
// scrubAuthorization beforeSend hook applied.
//
// The <Env> generic propagates our repo-local interface (extending
// McpEnv + ObservabilityEnv) through to the optionsCallback. Eta-reduced
// from `(env) => buildSentryConfig(env)` because the function reference
// is structurally compatible with the SDK's `(env: Env) =>
// CloudflareOptions | undefined` shape (Env extends ObservabilityEnv).
export default Sentry.withSentry<Env>(buildSentryConfig, handler);

/**
 * Loose canonical-equivalence check for the resource param on /authorize.
 * Returns true if the candidate URI parses as https on the canonical Verity
 * MCP host (case-insensitive) with no path beyond a bare slash, no query,
 * no fragment, no userinfo. Used to normalize forms a real OAuth client
 * emits (notably the trailing-slash variant Claude Desktop sends) before
 * the 302 to the consent UI's strict-equality check. NOT a security gate
 * by itself; the consent UI + tools/call audience check both re-validate
 * against CANONICAL_RESOURCE_URI downstream.
 */
function isCanonicalEquivalent(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  if (parsed.host.toLowerCase() !== 'mcp.verityskills.com') return false;
  if (parsed.username !== '' || parsed.password !== '') return false;
  if (parsed.search !== '') return false;
  if (parsed.hash !== '') return false;
  // Accept '' (no path) or '/' (bare slash). Reject any deeper path.
  if (parsed.pathname !== '' && parsed.pathname !== '/') return false;
  return true;
}

function jsonResponse(
  body: unknown,
  status: number,
  extraHeaders?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json',
      ...(extraHeaders ?? {}),
    },
  });
}
