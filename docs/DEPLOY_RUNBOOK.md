# verity-mcp deploy runbook

Owner-executable steps to ship the MCP server to `mcp.verityskills.com` and start serving agents. Each step lists the exact command, the time it should take, and the verification you should see.

The Worker is built on the Cloudflare Workers **Bundled plan** ($5/mo per account). `wrangler.toml` already pins `[limits].cpu_ms = 50` so Sentry init has headroom on cold start.

## Step 1: Cloudflare account auth (5 min)

```bash
cd ~/workspace/verity-mcp
npx wrangler login
```

A browser tab opens; sign in with the Cloudflare account that owns `verityskills.com`. Confirm the auth scopes Cloudflare requests, then close the tab.

Verify:

```bash
npx wrangler whoami
```

You should see the email and Cloudflare account ID. Note the account ID; you'll need it for the secrets in Step 3 (Wrangler picks it up automatically, but having it handy is useful for the Sentry project setup in Step 2).

## Step 2: Sentry project for verity-mcp (5 min)

Create a new Sentry project at https://sentry.io for the Worker. Settings:

- **Platform:** JavaScript -> Cloudflare Workers
- **Project name:** `verity-mcp`
- **Team:** the team that owns Verity

Copy the DSN from the project's "Client Keys" page. It looks like `https://<key>@<org>.ingest.sentry.io/<project-id>`. Keep it open for Step 3.

If you'd rather defer Sentry to a follow-up PR: skip this step. The Worker handles a missing `SENTRY_DSN` gracefully (returns `undefined` from `buildSentryConfig`; the `Sentry.withSentry` wrap runs the handler unwrapped). Structured logs via `wrangler tail` are the fallback observability surface.

## Step 3: Set Wrangler secrets (5 min)

```bash
# Required: the bearer-auth proxy needs Sentry to surface uncaught exceptions
echo "https://<your-sentry-dsn>" | npx wrangler secret put SENTRY_DSN --env preview
echo "https://<your-sentry-dsn>" | npx wrangler secret put SENTRY_DSN --env production

# Optional: per-tool kill switch (comma-separated). Empty means all tools live.
# Set this only if you need to temporarily disable a tool without redeploying.
# echo "" | npx wrangler secret put MCP_TOOLS_DISABLED --env production

# Optional: global kill switch. Set to "on" to take the whole worker offline.
# Health endpoint stays reachable so the smoke cron records a status=skipped
# instead of paging.
# echo "off" | npx wrangler secret put MCP_KILL_SWITCH --env production
```

Verify each secret was stored:

```bash
npx wrangler secret list --env production
```

You should see `SENTRY_DSN` in the list (the value itself is not displayed).

## Step 4: Preview deploy + manual smoke (10 min)

```bash
npx wrangler deploy --env preview
```

This deploys to `verity-mcp-preview.<account>.workers.dev`. Wrangler prints the worker URL on the last line; copy it. Time: about 20-40 seconds for upload + propagation.

Smoke test from a terminal:

```bash
PREVIEW_URL="https://verity-mcp-preview.<account>.workers.dev"

# 1. Health endpoint (no auth required)
curl -sS "$PREVIEW_URL/health" | python3 -m json.tool
# Expect: { "status": "ok", "uptime_s": N, "kill_switch_engaged": false, ... }

# 2. JSON-RPC initialize
curl -sS -X POST "$PREVIEW_URL/mcp" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  | python3 -m json.tool
# Expect: result with protocolVersion "2025-03-26" + serverInfo verity-mcp 1.0.0

# 3. tools/list
curl -sS -X POST "$PREVIEW_URL/mcp" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | python3 -m json.tool
# Expect: result.tools array with the 6 advertised tools

# 4. Anonymous coordination-heat
curl -sS -X POST "$PREVIEW_URL/mcp" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"coordination-heat","arguments":{"subject":"GME"}}}' \
  | python3 -m json.tool
# Expect: forward of the upstream verityskills.com coordination-heat response

# 5. Authenticated verity-score (replace vtk_ token with a real one)
curl -sS -X POST "$PREVIEW_URL/mcp" \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer vtk_<your-token>' \
  -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"verity-score","arguments":{"subject":"NVDA"}}}' \
  | python3 -m json.tool
# Expect: forward of the upstream verity-score response
```

If any smoke fails, check the worker logs:

```bash
npx wrangler tail --env preview
```

Then trigger the failing request again and watch the structured log line. Every line carries `request_id`, `outcome_kind`, `tool`, `upstream_status`, `error`. Most failures are obvious from these fields.

If Sentry is wired, check the Sentry dashboard for any errors that captured.

## Step 5: DNS CNAME (15 min including propagation)

In Cloudflare DNS for `verityskills.com`, add:

| Type | Name | Target | Proxy |
|---|---|---|---|
| CNAME | `mcp` | `<your-account>.workers.dev` | Proxied (orange cloud) |

The exact CNAME target depends on your Workers domain. Easiest way to find it: run `wrangler whoami` and use `<subdomain>.workers.dev` where subdomain is your account workers subdomain.

Wait for DNS propagation. Verify:

```bash
dig +short mcp.verityskills.com
# Expect: at least one Cloudflare anycast IP
```

## Step 6: Production deploy (5 min)

```bash
npx wrangler deploy --env production
```

This deploys to the custom domain `mcp.verityskills.com` per the `wrangler.toml [env.production.routes]` config. The route + custom_domain entries are already pinned in the repo.

Re-run the smoke commands from Step 4 against `https://mcp.verityskills.com` instead of the preview URL.

## Step 7: Enable synthetic-smoke monitoring (5 min)

Flip the parent-repo Vercel environment variable so the cron stops skipping its checks:

```bash
cd ~/workspace/workspace-verity
# Or use the Vercel dashboard. The CLI:
echo "true" | vercel env add MCP_HEALTH_EXPECTED production
vercel env pull .env.production.local
```

The cron at `cchurctrip/verity:app/api/cron/mcp-synthetic-smoke/route.ts` pings `mcp.verityskills.com/health` every 5 minutes. When `MCP_HEALTH_EXPECTED=true` and the ping fails (or returns `kill_switch_engaged: false` with a non-200), it fires a Sentry alert.

Wait 5-10 minutes after flipping the flag and check Vercel cron logs or Sentry for the first successful smoke.

## Step 8: Smoke check from a real MCP client (10 min)

The Worker is live. Now confirm a real agent can use it.

**Claude Desktop:** edit `~/Library/Application Support/Claude/claude_desktop_config.json` (or paste from `docs/CURSOR.md` / `docs/CLAUDE_DESKTOP.md`):

```json
{
  "mcpServers": {
    "verity": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-fetch", "https://mcp.verityskills.com/mcp"],
      "env": {
        "AUTHORIZATION": "Bearer vtk_<your-token>"
      }
    }
  }
}
```

Restart Claude Desktop. Open a new conversation, ask: "Use the verity-score tool to check NVDA." Claude should invoke `tools/call` against the Worker.

**Cursor:** Settings -> MCP -> Add Server. URL: `https://mcp.verityskills.com/mcp`. Auth: bearer.

## Operational notes

- **Rotate `SENTRY_DSN`:** repeat Step 3.
- **Roll back a bad deploy:** `npx wrangler rollback --env production` reverts to the previous version.
- **Watch live traffic:** `npx wrangler tail --env production` streams the structured log lines.
- **Disable a single tool:** `echo "<tool-name>" | npx wrangler secret put MCP_TOOLS_DISABLED --env production`. Effects are global immediately.
- **Take the whole worker offline:** `echo "on" | npx wrangler secret put MCP_KILL_SWITCH --env production`. `/health` stays reachable; the smoke cron records `status=skipped`.

## Costs

- Cloudflare Workers Bundled plan: $5/mo per account.
- Sentry: free tier covers up to 5k errors/mo per project. Above that, $26/mo per 50k errors.
- DNS: included with Cloudflare.

Total expected: $5-31/mo depending on Sentry tier.

## Time budget

Soup to nuts, deploying for the first time: 45-60 minutes including DNS propagation. Subsequent deploys: 5 minutes.

## Common failures

1. **`wrangler deploy` fails with "Authentication error":** re-run `wrangler login`.
2. **`/mcp` returns 503 KILL_SWITCH_ENGAGED:** unset `MCP_KILL_SWITCH` via `wrangler secret delete MCP_KILL_SWITCH --env production`.
3. **`/mcp` returns INVALID_BEARER_FORMAT:** the bearer regex is strict: `^Bearer vtk_[A-Za-z0-9]+$`. No whitespace, no trailing characters, no quotes. Use the raw token as issued.
4. **DNS not resolving 10 minutes after CNAME add:** Cloudflare proxied records can take up to 24h to fully propagate in rare cases. The Worker is reachable at `<worker>.<account>.workers.dev` immediately; use that as a fallback while DNS propagates.
5. **Bundle size error on deploy:** the worker bundle is 102 KiB gzip on the Bundled plan ceiling of 10 MiB. If you ever hit it, check `node_modules/@sentry` for accidental large transitive deps.
