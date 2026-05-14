# Smithery.ai submission

Smithery is the leading public registry of MCP servers (https://smithery.ai). Listing verity-mcp here is the single highest-impact discovery move for agents looking for finance + market-integrity tools.

## Pre-submission checklist

- [ ] Production deploy verified (`mcp.verityskills.com/health` returns 200; smoke cron green).
- [ ] At least one external developer has installed verity-mcp via the Claude Desktop snippet and successfully called a tool (validates the install path).
- [ ] Verity team support address `support@verityskills.com` (or whatever inbox is monitored) is staffed for MCP integration questions.

## Submission payload

Smithery accepts a YAML manifest. Save the following as a draft for submission via https://smithery.ai/new (or via their API once we have it):

```yaml
name: verity-mcp
display_name: Verity
description: >
  Coordination, market integrity, and disinformation signals for AI trading
  agents. Six callable skills detect coordinated activity, flag manipulation
  patterns, and cross-check claims against authoritative sources. Built for
  pre-trade decision workflows.
publisher: Verity
publisher_url: https://verityskills.com
homepage_url: https://verityskills.com/skills
repository_url: https://github.com/cchurctrip/verity-mcp
license: MIT

transport: http+sse
endpoint: https://mcp.verityskills.com/mcp
mcp_spec_version: "2025-03-26"

categories:
  - finance
  - research
  - data

auth:
  type: bearer
  obtain_url: https://verityskills.com/account/api-keys
  anonymous_tools:
    - coordination-heat

tools:
  - name: coordination-heat
    description: Detect coordinated activity around a topic, ticker, or narrative.
    requires_auth: false
  - name: verity-score
    description: Composite integrity score for a market subject.
    requires_auth: true
  - name: morning-brief
    description: Daily briefing of overnight signals across a watchlist.
    requires_auth: true
  - name: verity-scan
    description: Real-time scan of a topic, ticker, or claim. Pre-trade check.
    requires_auth: true
  - name: cross-check-alert
    description: Cross-reference a claim against authoritative sources.
    requires_auth: true
  - name: disinfo-alert
    description: Flag potential disinformation patterns and coordinated narratives.
    requires_auth: true

icon: https://verityskills.com/icon-256.png
screenshot: https://verityskills.com/skills-screenshot.png

support:
  email: support@verityskills.com
  docs: https://verityskills.com/docs/mcp
  status: https://mcp.verityskills.com/health
```

## Marketing copy variants for the listing description (pick one)

**Angle 9 lead (recommended):**

> ApeWisdom has a dashboard. StockTwits has a feed. Verity has skills. Six callable endpoints invoke from your AI workflow: scan a ticker, check coordination heat, flag disinformation, cross-reference a claim. The pre-trade check your AI agent should be running. Trade doesn't fire until Verity clears it.

**Angle 7 lead (alternate, fund-tier audience):**

> Your AI analyst's pre-trade integrity check. Six skills that detect coordinated activity, score market subjects, and flag disinformation across social platforms. Pull a structured verdict before any significant position. Fund-tier subscribers get unlimited calls.

## Screenshot guidance

Submit a screenshot showing one of:
- A Claude Desktop conversation invoking `verity-score` with the structured response visible
- A Cursor sidebar showing the 6 tools in the MCP tool palette
- The verityskills.com/skills page (Angle 9 hero) with the install instructions visible

Avoid screenshots of:
- The Verity dashboard (contradicts Angle 9: "Verity has skills, not a dashboard")
- The fund subscription page (off-message for the developer audience that browses Smithery)

## Post-submission

Smithery reviews submissions manually (typical turnaround: 1-3 business days). When approved:

1. Add the Smithery badge to README.md: `[![Smithery](https://smithery.ai/badge/verity-mcp)](https://smithery.ai/server/verity-mcp)`.
2. Tweet the listing URL with the Angle 9 hook. See `docs/launch-drafts/twitter-thread.md`.
3. Cross-post the listing URL to r/AIAgents, r/LLMDevs, r/SecurityCareerAdvice (the disinfo angle plays in that subreddit too).

## If rejected

Smithery typically rejects for: missing screenshot, vague description, no working endpoint, or auth flow that doesn't match the manifest claim. The most common feedback is "your endpoint requires auth for tools/list but the manifest says it's anonymous." Verify: `curl -sS -X POST https://mcp.verityskills.com/mcp -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'` should work without an Authorization header. (It does today; `tools/list` does not require auth in our spec.)
