# modelcontextprotocol/registry submission walkthrough - DRAFT

The canonical Anthropic-maintained MCP server registry lives at https://github.com/modelcontextprotocol/registry. Submissions are PR-based: you add an entry to a YAML or JSON file under `servers/`, the repo CI validates the schema + reachability, and a maintainer approves.

## Workflow for the maintainer

1. **Fork** https://github.com/modelcontextprotocol/registry to `cchurctrip/registry`.
2. **Clone the fork** locally.
3. **Add a new file** under `servers/community/verity.yaml` (or whatever path matches the current repo convention; check `README.md` and existing entries before submitting; the path/format can change without notice).
4. **Open a PR** with the entry contents (exact YAML below).
5. **Repo CI** runs:
   - Schema validation against the registry's JSON schema (`schemas/server.schema.json` or similar).
   - Reachability check: hits `https://mcp.verityskills.com/health` and the `tools/list` endpoint.
   - Manifest sanity check: the advertised tool count + names match the live server.
6. **Maintainer review** (~5-10 days based on prior PR history). Topics they typically raise:
   - Description tone (no hype, accurate).
   - Tool descriptions match `tools/list` shape and quality.
   - Auth flow documented for users without an account.
   - Pricing transparency (registry favours servers with a public pricing page).
7. **Merge** → entry appears in the canonical registry. Downstream tools (Smithery, Cursor Directory, individual MCP clients) may also auto-pull from this source.

## Exact YAML entry (servers/community/verity.yaml)

```yaml
# Verity MCP server. Real-time social media and prediction market integrity
# layer for traders, funds, and quant desks. Six callable tools cover
# scoring, scanning, cross-checks, coordinated-narrative detection, daily
# watchlist briefs, and coordination heat.

name: verity
display_name: Verity
description: |
  Real-time social media and prediction market integrity layer. Six tools
  for AI workflows: integrity scoring, pre-trade scans, cross-reference
  checks, coordinated-narrative detection, daily watchlist briefs, and
  coordination heat. Bearer-token auth, seven-day trial without credit card.

# The source repository.
repository: https://github.com/cchurctrip/verity-mcp

# Where the live server is hosted. Anonymous /health probe + auth-required
# /mcp endpoint for JSON-RPC tool calls.
server:
  url: https://mcp.verityskills.com/mcp
  health_url: https://mcp.verityskills.com/health
  transport: http

# Auth model.
authentication:
  type: bearer
  scheme: Bearer
  obtain_url: https://verityskills.com/account/api-keys
  trial:
    available: true
    duration_days: 7
    invocation_cap: 10
    requires_credit_card: false

# Tools list. The registry CI verifies this matches the live tools/list
# response shape. Source-of-truth is the live server; this block is the
# documentation surface for browsers of the registry.
tools:
  - name: coordination-heat
    description: Heat score for a topic, ticker, or narrative across public social platforms.
    requires_auth: true
  - name: verity-score
    description: Composite integrity score for a market subject, with a contributing-factor breakdown for paid users.
    requires_auth: true
    notes: Anonymous callers get a degraded free-shape (score, ticker, explanation, asof) without the breakdown.
  - name: morning-brief
    description: Daily briefing of overnight signals across a watchlist.
    requires_auth: true
  - name: verity-scan
    description: Real-time scan returning a structured pre-trade verdict.
    requires_auth: true
  - name: cross-check-alert
    description: Cross-reference a claim against authoritative sources; returns matched citations, conflicts, and confidence verdict.
    requires_auth: true
  - name: disinfo-alert
    description: Flag coordinated narrative patterns around a topic or ticker.
    requires_auth: true

# Pricing.
pricing:
  free:
    tier: Trial
    duration_days: 7
    invocation_cap: 10
  paid:
    - tier: Retail
      monthly_usd: 49
    - tier: Pro
      monthly_usd: 149
    - tier: Fund
      monthly_usd: 499

# Categories. Pick what matches current registry taxonomy.
categories:
  - finance
  - research
  - news

# Maintainer contact for registry CI failure alerts.
maintainer:
  name: Verity
  email: support@verityskills.com   # TODO: configure inbox before publishing
  github: cchurctrip

# Links surfaced on the registry browser.
links:
  homepage: https://verityskills.com
  docs: https://verityskills.com/skills
  pricing: https://verityskills.com/pricing
```

## Draft PR body

```markdown
## Adds: Verity MCP server

Verity (https://verityskills.com) is a real-time social media and prediction
market integrity layer for traders, funds, and quant desks. The MCP server
exposes six callable tools that an AI workflow can use as a pre-trade
manipulation check.

### Tools

- coordination-heat
- verity-score (anonymous degraded path + paid full path)
- morning-brief
- verity-scan
- cross-check-alert
- disinfo-alert

### Server posture

- Live at https://mcp.verityskills.com (Cloudflare Workers, Bundled plan).
- /health endpoint: returns 200 + commit SHA + kill-switch state. Suitable for synthetic-smoke polling.
- /mcp endpoint: POST + JSON-RPC 2.0 with Streamable HTTP content negotiation (Accept: text/event-stream returns one SSE-framed envelope per MCP 2025-03-26). /sse endpoint: GET opens EventSource stream with absolute-URL endpoint event + POST forwards JSON-RPC + relays response on same-isolate open stream (HTTP 202) or falls back to 200 + envelope inline (MCP 2024-11-05 6.2.2). Both transports live post VRT-165.
- Auth: Authorization Bearer vtk_<token>. Bearer is translated to x-verity-key for the upstream skills routes (the parent verityskills.com API).
- Kill switch: MCP_KILL_SWITCH Wrangler secret. When `on`, /mcp returns 503 with `KILL_SWITCH_ENGAGED`; /health stays reachable so operators can distinguish disabled-vs-crashed.

### Operational evidence

- Live 6-tool probe with a real key returned 9/9 pass on 2026-05-21 against mcp.verityskills.com. Probe script + transcript at https://github.com/cchurctrip/verity/blob/main/scripts/verity-mcp-live-probe.sh.
- Scheduled live-contract e2e workflow at https://github.com/cchurctrip/verity-mcp/actions/workflows/live-contract-e2e.yml runs daily.
- Synthetic-smoke cron pings /health every 5 minutes from the parent repo (https://github.com/cchurctrip/verity).

### Pricing

- Trial: 7 days, 10 invocations, no credit card.
- Retail: $49/mo
- Pro: $149/mo (API access)
- Fund: $499/mo (unlimited, compliance exports)

### Compliance posture

Verity is not financial advice. It surfaces social-media coordination signals, narrative inconsistencies, and source conflicts for human decision-making. FINRA's 2025 Regulatory Oversight Report flagged social media disinformation as a top compliance risk for investment advisers; Verity Fund is positioned as the audit trail + early-warning system for that risk.

### Checklist

- [x] Live server reachable at the URL declared.
- [x] /health returns 200.
- [x] tools/list returns the declared tool count.
- [x] Auth flow documented for new users.
- [x] Pricing page public.
- [x] Multi-client transport (Streamable HTTP + legacy SSE bridge) live post VRT-165.
- [ ] support@verityskills.com inbox configured (TODO before publishing).
```

## Known blockers to fix BEFORE submitting

- [ ] `support@verityskills.com` inbox configured (registry maintainers email here on CI failures).
- [ ] Pricing-page parity (`verityskills.com/pricing` must list Retail $49 / Pro $149 / Fund $499 with the same trial terms).
- [ ] SSE follow-up issue filed (link from the PR body so reviewers can see the gap is tracked).
- [ ] Verify the registry's current schema/path conventions match this YAML; the repo's `README.md` should be the final reference. If the registry has moved to JSON or a different file layout, update accordingly.

## Post-merge behaviour

- The entry appears at https://github.com/modelcontextprotocol/registry/tree/main/servers/community/verity.yaml.
- Downstream tools polling the registry pick up Verity on their next sync.
- Updates ship by opening another PR against the registry. There is no out-of-band update channel.

## Rollback procedure

- For a small fix: PR an update to the YAML entry.
- For a serious issue: kill switch (`MCP_KILL_SWITCH=on`) returns 503 to all tool calls; downstream tools surface "Server unavailable" but the registry entry persists.
- For total removal: PR a deletion of the YAML file. Registry maintainers accept this on request from the listed maintainer.
