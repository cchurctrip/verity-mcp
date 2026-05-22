# /skills page rewrite DRAFT

Owner-approval required. Brand Rule: never modify /, /funds, /skills, /upgrade on the main verity repo without explicit go-ahead. This file is the proposed edit; copy into `cchurctrip/verity:app/skills/page.tsx` (or wherever the page lives) after Corbin signs off.

The current /skills page is positioned around Verity-as-dashboard. This rewrite leads with Angle 9 (Verity-has-skills) and adds working install snippets so a developer can wire it up in under 60 seconds.

---

## Proposed copy

### Hero (above the fold)

**H1**

ApeWisdom has a dashboard. StockTwits has a feed.
Verity has skills.

**Subhead**

Six callable endpoints your AI workflow can invoke before any trade. The pre-trade check your stack was missing.

**Primary CTA buttons**

[ Add to Claude Desktop ] [ Add to Cursor ] [ View on Smithery ]

The Claude / Cursor buttons use deep links once the install flows ship (see `docs/CLAUDE_DESKTOP.md` and `docs/CURSOR.md`). Until the deep-link install routes land in Anthropic and Cursor respectively, the buttons open a modal with the JSON config snippet.

**Secondary CTA**

→ Try the anonymous skill right now: `curl mcp.verityskills.com` (link to a code panel)

### Six skills (below the fold)

A 6-card grid. Each card:

```
[icon]
verity-score
Composite integrity score for a market subject.
Returns a 0 to 100 score with contributing factor weights
so an AI analyst can decide whether a thesis is grounded.

Requires: Pro tier or above.
```

Same shape for all 6. `coordination-heat` carries an "Anonymous OK" badge.

### How it works (one paragraph)

The Verity MCP server is a Cloudflare Worker that exposes six skills over JSON-RPC 2.0. Any agent that supports the Model Context Protocol can invoke them: Claude Desktop, Cursor, Cline, Continue, custom LangChain agents, custom LlamaIndex agents. The same endpoint serves every runtime. Connect once; every skill works.

### Architecture diagram

A two-column ASCII or pretty-rendered diagram:

```
Your agent                     Verity
─────────                      ──────
Claude Desktop ──┐
Cursor ──────────┤
LangChain agent ─┼──→  mcp.verityskills.com/mcp ──→  6 skill routes
LlamaIndex ──────┤              (JSON-RPC 2.0)         on verityskills.com
custom agent ────┘
```

### Install (full-width code panels)

Three tabs:

**Claude Desktop**

```json
{
  "mcpServers": {
    "verity": {
      "type": "http",
      "url": "https://mcp.verityskills.com/mcp",
      "headers": { "Authorization": "Bearer vtk_<your-token>" }
    }
  }
}
```

**Cursor**

```json
{
  "mcpServers": {
    "verity": {
      "url": "https://mcp.verityskills.com/mcp",
      "headers": { "Authorization": "Bearer vtk_<your-token>" }
    }
  }
}
```

**curl (anonymous skill)**

```bash
curl -sS -X POST https://mcp.verityskills.com/mcp \
  -H 'content-type: application/json' \
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

### Pricing strip (compact, three-tier)

| Tier | Price | What you get |
|---|---|---|
| Free | $0 | coordination-heat (anonymous, no token required) |
| Pro | $149 / mo | All 6 skills, 1,000 calls/day per skill |
| Fund | $499 / mo | All 6 skills, unlimited calls, compliance audit trail |

CTA: [ Start a free trial ] (links to /upgrade)

### Footer signals

- License badge: MIT
- Source: github.com/cchurctrip/verity-mcp
- Status: status.verityskills.com (link to `mcp.verityskills.com/health`)
- Discord / X handles
- Pricing transparent in the strip above (no "Contact sales" friction for Pro)

---

## What to remove from the current page

Anything that frames Verity primarily as a dashboard or as a Verity-website product. The page should read like a developer-tools product page (Stripe Docs, Twilio Docs, Vercel) rather than a B2C trading dashboard.

## What stays

- The fund-tier compliance-audit section (it's the buyer pitch for the $499 tier; Angle 4 lead).
- Any case study or testimonial. but framed in terms of "this fund's AI workflow uses Verity" rather than "this fund logs into Verity daily".

## SEO considerations

H1 should still contain "Verity" and "skills" for branded search. The Angle 9 hook lands the headline AND the keyword. Add an FAQ schema with structured-data markup for "What is Verity? How do I install Verity?" so we capture SGE / AI-search traffic.

## Owner question

The current /skills page may already have brand-approved copy that we shouldn't blow away. Confirm:
1. Is the dashboard-positioning the active live copy, or has Angle 9 already landed in production?
2. Are the install snippets accurate against the verityskills.com auth flow (specifically the bearer-token issuance at /account/api-keys)?
3. Should the buttons be `[Add to Claude]` / `[Add to Cursor]` deep links (preferred), or `[Copy config]` modal triggers (safer until deep links ship)?

If answers are 1=dashboard / 2=accurate / 3=modal-triggers, this rewrite drops straight in. If anything diverges, I update first.
