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
export interface Env extends McpEnv, ObservabilityEnv, OauthDiscoveryEnv, OauthTokenEnv {
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

    // VRT-166 OAuth 2.1 surface. Three new routes.
    //
    // Discovery endpoints (RFC 8414 + RFC 9728) are public, unauthenticated,
    // and gated only by the global MCP_KILL_SWITCH (already returned above)
    // and the OAuth-specific MCP_OAUTH_KILL_SWITCH (handled inside the
    // builders, which omit OAuth-specific fields so DCR-attempting clients
    // fail-fast and fall through to the bearer path).
    if (req.method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server') {
      return jsonResponse(buildAuthorizationServerMetadata(env), 200);
    }
    if (req.method === 'GET' && url.pathname === '/.well-known/oauth-protected-resource') {
      return jsonResponse(buildProtectedResourceMetadata(env), 200);
    }

    // GET /authorize: 302 redirect to the consent UI on the Verity Next.js
    // origin, preserving every query param. The discovery doc
    // (/.well-known/oauth-authorization-server) correctly advertises
    // `authorization_endpoint: https://verityskills.com/oauth/mcp/authorize`,
    // but real MCP clients (Claude Desktop confirmed 2026-05-25; Cursor +
    // ChatGPT Desktop + Gemini CLI suspected on same pattern) construct
    // the authorize URL as `<server_url_host>/authorize` instead of
    // honoring the metadata. This same-host redirect closes the gap
    // without restructuring the consent UI cross-host split. State,
    // code_challenge, code_challenge_method, redirect_uri, response_type,
    // scope, resource, and client_id all pass through untouched; the
    // user's browser then lands on the canonical consent URL on
    // verityskills.com where the magic-link sign-in flow + consent
    // approval happens per Phase 2.
    if (req.method === 'GET' && url.pathname === '/authorize') {
      const consentUrl = new URL('https://verityskills.com/oauth/mcp/authorize');
      url.searchParams.forEach((value, key) => {
        consentUrl.searchParams.set(key, value);
      });
      return Response.redirect(consentUrl.toString(), 302);
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
    if (req.method === 'GET' && url.pathname === '/sse') {
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

    if (req.method === 'POST' && url.pathname === '/sse') {
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

    if (req.method === 'POST' && url.pathname === '/mcp') {
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
