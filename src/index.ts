// Worker entry. Routes /health, /mcp, /sse, and / and applies the global
// kill switch + CORS to every response. The JSON-RPC dispatch logic lives in
// src/mcp.ts; this module is the IO boundary that wraps the handler return
// in a Response with permissive CORS headers and emits the structured log
// line.
//
// Sentry initialization is deferred until the @sentry/cloudflare dependency
// lands in a future PR. The Sentry config is still built here (pure, no side
// effects) so the beforeSend hook is exercised by tests; once the dependency
// is present, the module entry will be wrapped with Sentry.withSentry().

import { handleMcpRequest, type McpEnv } from './mcp';
import { buildLogLine, logRequest, type ObservabilityEnv } from './observability';

// Env is the union of every binding the Worker entry needs. Extending the
// two sub-module env shapes makes the coupling load-bearing in the type
// system: adding a required key to McpEnv or ObservabilityEnv becomes a
// compile error here rather than silently working until the first request
// in production.
export interface Env extends McpEnv, ObservabilityEnv {
  MCP_KILL_SWITCH?: string;
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

export default {
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
      // SSE stub. Full SSE transport deferred to Sprint 4.
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
      // Sentry init is deferred until @sentry/cloudflare lands as a
      // dependency. When it does, this is the line that becomes
      // `Sentry.withSentry(buildSentryConfig(env))(handler)`. Until then
      // no runtime Sentry call is wired; structured logs above are the
      // observability surface.

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
      logRequest({
        ...buildLogLine({
          request_id: result.requestId,
          tool: result.tool ?? '-',
          upstream_status: result.upstreamStatus,
          latency_ms: Date.now() - startedAt,
          auth_present: req.headers.get('authorization') !== null,
          ...(result.errorDetail !== null ? { error: result.errorDetail } : {}),
        }),
        outcome_kind: result.outcomeKind,
      });

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
};

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}
