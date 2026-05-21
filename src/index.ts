// Worker entry. Routes /health, /mcp, /sse, and / and applies the global
// kill switch + CORS to every response. The JSON-RPC dispatch logic lives in
// src/mcp.ts; this module is the IO boundary that wraps the handler return
// in a Response with permissive CORS headers and emits the structured log
// line.
//
// The default export is wrapped with Sentry.withSentry so any uncaught
// exception inside the fetch handler flows to Sentry with the
// scrubAuthorization beforeSend hook applied. When SENTRY_DSN is unset
// (local dev, pre-deploy), buildSentryConfig returns undefined and
// withSentry gracefully no-ops; the handler runs unwrapped.

import * as Sentry from '@sentry/cloudflare';

import { handleMcpRequest, type McpEnv } from './mcp';
import {
  buildLogLine,
  buildSentryConfig,
  logRequest,
  type ObservabilityEnv,
} from './observability';

// Env is the union of every binding the Worker entry needs. Extending the
// two sub-module env shapes makes the coupling load-bearing in the type
// system: adding a required key to McpEnv or ObservabilityEnv becomes a
// compile error here rather than silently working until the first request
// in production.
export interface Env extends McpEnv, ObservabilityEnv {
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
  async fetch(req: Request, env: Env): Promise<Response> {
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

    if (req.method === 'GET' && url.pathname === '/sse') {
      // SSE stub. Full SSE transport deferred to a future PR.
      // Preserves the manifest.json transport claim ('http+sse') for marketplace
      // consumers; returns a structured JSON-RPC error so probing clients see a
      // parseable response rather than a generic 404.
      return jsonResponse(
        {
          jsonrpc: '2.0',
          id: null,
          error: {
            code: -32601,
            message: 'SSE transport not yet implemented; use POST /mcp',
          },
        },
        405,
      );
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

      return jsonResponse(result.body, result.status);
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

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}
