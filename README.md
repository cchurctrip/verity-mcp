# Verity MCP Server

Public MCP (Model Context Protocol) server for [Verity](https://verityskills.com) skills. Six callable endpoints your AI agent can invoke before any trade: detect coordinated activity, score market subjects, cross-check claims, flag disinformation patterns.

**Production endpoint:** `https://mcp.verityskills.com/mcp`

## Why Verity skills

ApeWisdom has a dashboard. StockTwits has a feed. Verity has skills. The pre-trade integrity check most AI workflows are missing. Connect once; every Verity capability becomes a function call from inside your Claude, Cursor, LangChain, or LlamaIndex workflow.

Every skill needs a Verity API key. Issue one in seconds at https://verityskills.com/account/api-keys.

## Install

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows). Native HTTP transport (Claude Desktop 2026 builds):

```json
{
  "mcpServers": {
    "verity": {
      "type": "http",
      "url": "https://mcp.verityskills.com/mcp",
      "headers": {
        "Authorization": "Bearer vtk_<your-token>"
      }
    }
  }
}
```

If your Claude Desktop is older and rejects `type: "http"`, use the `mcp-remote` stdio bridge. See `docs/CLAUDE_DESKTOP.md` for the full guide. Fully quit Claude Desktop (Cmd-Q on macOS) before relaunch.

### Cursor

Add to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "verity": {
      "url": "https://mcp.verityskills.com/mcp",
      "headers": {
        "Authorization": "Bearer vtk_<your-token>"
      }
    }
  }
}
```

Restart Cursor. See `docs/CURSOR.md` for the full guide.

### Direct API (curl, no MCP client required)

```bash
curl -sS -X POST https://mcp.verityskills.com/mcp \
  -H 'content-type: application/json' \
  -H 'Authorization: Bearer vtk_your_key_here' \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "coordination-heat",
      "arguments": { "subject": "GME" }
    }
  }'
```

All six skills require an API key issued at https://verityskills.com/account/api-keys.

### Other agent runtimes

Any MCP-compliant agent runtime works. The endpoint is `https://mcp.verityskills.com/mcp` over HTTP+SSE (the SSE channel is a future addition; HTTP POST works today). Add `Authorization: Bearer vtk_<token>` for every skill.

## Available skills

| Skill | Auth | Capability |
|---|---|---|
| `coordination-heat` | Required | Score a topic, ticker, or narrative for coordinated activity. |
| `verity-score` | Required | Composite integrity score for a market subject. |
| `morning-brief` | Required | Daily briefing of overnight signals across a watchlist. |
| `verity-scan` | Required | Real-time scan of a topic, ticker, or claim. |
| `cross-check-alert` | Required | Cross-reference a claim against monitored sources. |
| `disinfo-alert` | Required | Monitor a topic or ticker for disinformation patterns. |

## Marketplace listings

- [Smithery.ai](https://smithery.ai) (pending review)
- [Cursor Directory](https://cursor.directory) (pending review)
- PulseMCP, Glama, MCP.so (pending review)

## Architecture

Thin bearer-token proxy on Cloudflare Workers. Zero state, zero DB credentials.

- Translates `Authorization: Bearer vtk_*` from MCP clients into the upstream `x-verity-key` header for [verityskills.com](https://verityskills.com) skill routes.
- JSON-RPC 2.0 framing per the MCP spec (`2025-03-26`).
- 402 `TRIAL_CAP_REACHED` responses are rewritten to inject an absolute `upgrade_url` so MCP clients can route trial-cap users to the right upgrade page.
- 5xx upstream responses are wrapped as JSON-RPC -32603 envelopes with HTTP 200 to keep transport-layer retry semantics correct.
- Per-tool kill switch via the `MCP_TOOLS_DISABLED` Wrangler secret. Global kill switch via `MCP_KILL_SWITCH=on`.
- Sentry instrumentation via [@sentry/cloudflare](https://www.npmjs.com/package/@sentry/cloudflare). Bearer tokens are scrubbed from any captured event via a `beforeSend` hook.

## Operations

| Concern | Source |
|---|---|
| Deploy + secrets + DNS | [`docs/DEPLOY_RUNBOOK.md`](./docs/DEPLOY_RUNBOOK.md) |
| Post-deploy smoke | `scripts/post-deploy-smoke.sh <base-url>` |
| Synthetic monitoring | 5-minute cron at `cchurctrip/verity:app/api/cron/mcp-synthetic-smoke/route.ts` |
| Health endpoint | `GET https://mcp.verityskills.com/health` |
| Marketplace submission | [`docs/SMITHERY.md`](./docs/SMITHERY.md), [`docs/CURSOR.md`](./docs/CURSOR.md) |

## Development

```bash
git clone https://github.com/cchurctrip/verity-mcp
cd verity-mcp
npm install
npm test            # 237 unit + property + integration tests
npm run lint
npm run typecheck
npm run check-manifest
npx wrangler dev    # local worker on http://localhost:8787
```

## License

MIT. See [LICENSE](./LICENSE).
