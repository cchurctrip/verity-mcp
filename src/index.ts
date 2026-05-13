// Worker entry. Phase 1 scaffold: route dispatch + /health + CORS + kill-switch.
// Phase 2 will wire /mcp to the JSON-RPC handler in src/mcp.ts and dispatch
// tools/call through src/upstream.ts to the parent repo's skill routes.

export interface Env {
  MCP_KILL_SWITCH?: string;
  MCP_TOOLS_DISABLED?: string;
  SENTRY_DSN?: string;
  COMMIT_SHA?: string;
}

const BOOT_TIME_MS = Date.now();

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
} as const;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

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

    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      return jsonResponse(
        {
          status: 'ok',
          commit: env.COMMIT_SHA ?? 'unknown',
          uptime_s: Math.floor((Date.now() - BOOT_TIME_MS) / 1000),
        },
        200,
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
      // Phase 2 will implement initialize, tools/list, tools/call dispatch.
      return jsonResponse(
        {
          jsonrpc: '2.0',
          id: null,
          error: {
            code: -32601,
            message: 'Method dispatch not yet implemented (VRT-146a Phase 2)',
          },
        },
        501,
      );
    }

    if (req.method === 'GET' && url.pathname === '/') {
      return Response.redirect('https://verityskills.com/skills', 302);
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
