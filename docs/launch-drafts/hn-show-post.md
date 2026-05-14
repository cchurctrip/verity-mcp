# Show HN draft

**Title:** Show HN: Verity, manipulation-detection skills for AI trading agents

**Body:**

I built an MCP server that gives AI agents six callable skills for checking market integrity: detect coordinated activity around a topic, score a ticker's narrative integrity, cross-reference a claim, flag disinformation patterns. The trade doesn't fire until Verity clears it.

Why I built it: Bloomberg costs $24k/year and doesn't watch Reddit or X. Graphika and Cyabra detect coordinated narratives for governments at $100k+/year. Retail and small-fund traders had nothing. Meanwhile every AI workflow I see is checking price and volume but missing the manipulation layer entirely.

The six skills are:

- `coordination-heat` (anonymous, public). Intensity of coordinated activity around a topic or ticker.
- `verity-score` (paid). Composite integrity score for a market subject.
- `morning-brief` (paid). Overnight signals across a watchlist.
- `verity-scan` (paid). Real-time scan of a topic or claim.
- `cross-check-alert` (paid). Cross-references a claim against authoritative sources.
- `disinfo-alert` (paid). Flags disinformation patterns.

Install in Claude Desktop or Cursor by pointing your MCP client at `mcp.verityskills.com/mcp` with a bearer token. The first tool (`coordination-heat`) is anonymous so you can try the wire without an account.

Architecture: Cloudflare Worker as a thin bearer-token proxy. JSON-RPC 2.0 over HTTP. Zero state, zero DB credentials. The proxy translates `Authorization: Bearer vtk_*` into the upstream skill-route auth header. ~1,000 LOC TypeScript, three property tests for the load-bearing predicates (bearer regex, upgrade_url rewrite, JSON-RPC envelope validator), 237 unit/integration tests. Source: github.com/cchurctrip/verity-mcp.

Pricing: anonymous for `coordination-heat`. Pro tier ($149/mo) for unlimited calls on the other five. Fund tier ($499/mo) adds compliance audit trail.

What I'd love feedback on:

1. Tool descriptions in the `tools/list` response. They're sourced from positioning angles. Are they actionable to an AI agent that has never seen Verity before?
2. The 402 `TRIAL_CAP_REACHED` flow: do MCP clients you've worked with surface upgrade prompts well, or is the response shape too thin?
3. What's the right way to expose "compliance audit trail" as a skill? Right now it's an API surface on the main site. Should it be its own MCP tool?

The bigger thesis: ApeWisdom has a dashboard. StockTwits has a feed. Verity has skills. Dashboards are commodities; skills become infrastructure. The next $100M software companies won't look like SaaS companies.

Comments-section landmines I'd prepare for:

- "You can't detect coordination from public APIs." Verity uses cross-source aggregation, not single-platform sampling. The signal isn't "X said this 1000 times"; it's "X said this AND Reddit AND YouTube AND the timing aligns".
- "What about Bloomberg Terminal?" Bloomberg charges $24k/year and doesn't watch social. Different product.
- "AI manipulation detection is impossible." I'd point at Graphika and Cyabra's enterprise contracts. The methodology works; we're just making it affordable.
- "Why MCP?" Because every model needs to read the same skill. MCP is the format every modern agent runtime parses. The same endpoint serves Claude Desktop, Cursor, and any agent that supports it.

URL: mcp.verityskills.com/skills

---

## HN posting plan

- Post at 8am ET on a Tuesday or Wednesday (highest front-page conversion windows per Indiehackers analysis).
- Do NOT pre-arrange upvotes; HN detects.
- First comment within 5 minutes of posting, from the OP: "Quick context: ..." that adds info not in the post.
- Respond to every comment within 2 hours of posting for the first 6 hours. Engagement signal is load-bearing.
- Have a roadmap link ready (verityskills.com/roadmap) for the "what's next" questions.
- Have one engineer (you) available all day for technical questions.

## Pre-post checklist

- [ ] `mcp.verityskills.com` is live and serving 200s on `/health` for 24+ hours
- [ ] At least 3 external developers have installed via Claude Desktop snippet and called a skill (smoke tests against real traffic)
- [ ] Smithery listing approved
- [ ] Cursor Directory PR merged
- [ ] `verityskills.com/skills` page reflects Angle 9 lead with install buttons
- [ ] OP account is verityskills@hn or similar (not personal. avoids attribution awkwardness)

## Variants if Tuesday HN doesn't perform

- Repost 4 days later with a different title angle (e.g., "Show HN: AI agents now have a pre-trade manipulation check").
- Cross-post to r/LocalLLaMA (the MCP / agent-tooling audience there is dense), r/AIAgents, r/algotrading.
