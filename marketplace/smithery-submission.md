# Smithery submission walkthrough - DRAFT

Smithery (https://smithery.ai) is a registry-driven MCP marketplace. Listings are GitHub-repo-backed: Smithery indexes the `smithery.yaml` (or `.smithery/server.yaml`) at the repo root and auto-discovers tool schemas via `tools/list`. Updates ship by merging changes into the indexed branch.

## Workflow for the maintainer

1. **Create a Smithery account** at https://smithery.ai/account using the GitHub identity that owns `cchurctrip/verity-mcp` (this is the only login that can claim a listing for that repo).
2. **Claim the listing**: Smithery → "Submit Server" → paste `https://github.com/cchurctrip/verity-mcp` → Smithery scans the repo, looking for `smithery.yaml`.
3. **Push the `smithery.yaml`** (see exact contents below) to verity-mcp main. Smithery polls hourly OR can be force-refreshed from the dashboard.
4. **Set the public listing fields** in the Smithery dashboard (NOT in the repo):
   - Display name: `Verity`
   - Tagline: from `marketplace/copy/tagline.md` (primary or short variant depending on field limit)
   - Long description: from `marketplace/copy/long-description.md`
   - Icon: upload `verity-mark-512.png` (owner provides; not in this PR)
   - Category: pick "Finance" and "Research / Analysis"
5. **Submit for review.** Smithery editorial cycle is ~24-48h based on published timelines. They check: manifest validity, transport reachability (HTTP POST + SSE), description quality, no policy violations.
6. **Post-acceptance**: a "Connect" button appears on the listing. Clicking it generates a one-click install for Claude Desktop / Cursor / Cline. Smithery proxies the install copy + tracks usage; auth still goes direct to mcp.verityskills.com via the bearer header on every call.

## Exact smithery.yaml to push to repo root

```yaml
# Smithery server descriptor. Indexed at https://smithery.ai/server/verity-mcp.
# Source of truth for tool schemas is the live server's tools/list response.
# This file gives Smithery the discovery hints it needs before it can probe.

name: verity-mcp
version: 1.0.0
description: |
  Real-time social media and prediction market integrity layer. Six tools for AI
  workflows: integrity scoring, pre-trade scans, cross-reference checks,
  coordinated-narrative detection, daily watchlist briefs, and coordination heat.

# Auth: every tool except no-key verity-score (degraded path) requires a vtk_*
# bearer token from https://verityskills.com/account/api-keys.
authentication:
  type: bearer
  header: Authorization
  scheme: Bearer
  obtain_url: https://verityskills.com/account/api-keys
  trial:
    available: true
    duration_days: 7
    invocation_cap: 10
    requires_credit_card: false

# Transport: HTTP POST + JSON-RPC 2.0 today. SSE is a stub returning
# JSON-RPC -32601 (Method not found); will be implemented in a follow-up
# (track at https://github.com/cchurctrip/verity-mcp/issues - file pending).
transport:
  type: http
  endpoint: https://mcp.verityskills.com/mcp
  method: POST

# Health probe Smithery hits to verify the server is alive on every poll.
health:
  url: https://mcp.verityskills.com/health
  method: GET
  expected_status: 200
  expected_field:
    name: status
    value: ok

# Tools are auto-discovered via tools/list. This block is informational.
tools_url: https://mcp.verityskills.com/mcp

# Pricing summary surfaced on the listing card.
pricing:
  free:
    tier: Trial
    duration: 7 days
    invocation_cap: 10
  paid:
    - tier: Retail
      monthly_usd: 49
    - tier: Pro
      monthly_usd: 149
      includes_api_access: true
    - tier: Fund
      monthly_usd: 499
      includes_api_access: true
      includes_compliance_exports: true

links:
  homepage: https://verityskills.com
  docs: https://verityskills.com/skills
  account: https://verityskills.com/account
  support: support@verityskills.com   # TODO: configure inbox alias before publishing
```

## What the end user sees after this lands

1. User goes to https://smithery.ai/server/verity-mcp.
2. Sees the tagline + long description + the 6 tools listed with their inputSchemas.
3. Clicks "Install in Claude Desktop" (or Cursor, etc.).
4. Smithery's installer adds the config block to the user's local MCP client config (with a prompt to paste their `vtk_*` key).
5. User restarts the client. Verity's 6 tools appear in the client's tool tray.
6. User asks a natural-language question. The client picks the right Verity tool and surfaces the answer.

## Known blockers to fix BEFORE submitting

- [x] Multi-client transport implemented (VRT-165). Both POST `/mcp` Streamable HTTP (Accept-gated SSE framing) and GET/POST `/sse` legacy bridge are live. Smithery's auto-test that probes either transport will pass.
- [ ] Support email `support@verityskills.com` does not exist yet. Set up Cloudflare Email Routing → forward to your live inbox before going live.
- [ ] Verity tier pages on verityskills.com/pricing must match the pricing block above (Retail $49, Pro $149, Fund $499). Verify before publishing.

## Rollback procedure

If a published listing has an issue (bad copy, broken tool, wrong pricing):
1. Update the file in `cchurctrip/verity-mcp` and push to main.
2. Force a Smithery re-index from https://smithery.ai/dashboard.
3. For a serious issue (e.g. premium-data leak), use the kill switch: set `MCP_KILL_SWITCH=on` as a Wrangler secret on verity-mcp. The Worker will return 503 for all tool calls and 200 with `kill_switch_engaged: true` on /health. Smithery will surface the listing as "Unavailable" within one poll cycle.
