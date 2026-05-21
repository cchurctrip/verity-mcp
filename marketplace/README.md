# Verity MCP marketplace submission drafts

This directory holds the per-registry submission packages for Verity's MCP server. **Nothing here is published yet.** Each subdoc captures the exact copy + assets + workflow steps the maintainer follows to publish to that registry. Edit + review before publishing.

## Registries in scope (VRT-149h)

1. **Smithery** - https://smithery.ai - registry-driven MCP marketplace, integrates with Claude Desktop / Cursor / Cline via auto-discovery.
2. **Cursor Directory** - https://cursor.com/directory - curated discovery surface inside Cursor.
3. **modelcontextprotocol/registry** - https://github.com/modelcontextprotocol/registry - the canonical Anthropic-maintained registry. PR-based submission.

## Pre-publish checklist (run once, applies to all 3)

1. [ ] `mcp.verityskills.com/health` returns 200 with a real (non-`"unknown"`) commit SHA after deploy.
2. [ ] `tools/list` returns 6 tools, all `requiresAuth: true`, with the 3 VRT-160 tools surfacing `outputSchema`.
3. [ ] Live 6-tool probe with a real `vtk_*` key returns 9/9 pass (`scripts/verity-mcp-live-probe.sh` in the verity repo).
4. [ ] Scheduled `live-contract-e2e` workflow has run at least one successful nightly pass since the latest deploy. Secret `VERITY_MCP_TEST_KEY` is set on `cchurctrip/verity-mcp`.
5. [ ] `THREAT_MODEL.md` exists and lists the bearer-auth-proxy STRIDE entries (deferred to VRT-146b; required before public listing).
6. [ ] Pricing page on `verityskills.com/pricing` is current (registries may auto-pull this).
7. [ ] Docs page on `verityskills.com/skills` lists each tool with a one-paragraph natural-language usage example.
8. [x] Multi-client transport implemented (VRT-165). POST `/mcp` content-negotiates: Streamable HTTP (SSE-framed) when `Accept: text/event-stream`, otherwise application/json (preserves the Cursor + synthetic-smoke contract). Legacy SSE bridge at GET `/sse` + POST `/sse` for clients that need EventSource handshake (Perplexity Comet today). `manifest.json` advertises both via a `transports` array root field; the legacy `transport: "http+sse"` single-string remains for marketplace consumers that read the older shape.

## Assets that go in every submission

- Tagline: pulled from `marketplace/copy/tagline.md` (see below).
- Long description: pulled from `marketplace/copy/long-description.md`.
- Hero image / icon: a `verity-mark-512.png` (NOT in this PR; owner provides).
- Per-tool 1-paragraph descriptions: pulled from the live `tools/list` `description` fields.
- Pricing summary: $0 trial (7 days, 10 calls), $49/$149/$499 paid tiers.
- Contact: support email (TBD - set up `support@verityskills.com` aliases first).

## File map

```
marketplace/
├── README.md                                      (this file)
├── copy/
│   ├── tagline.md                                 (one-line marketing copy)
│   └── long-description.md                        (3-5 paragraph product description)
├── smithery-submission.md                         (Smithery walkthrough + listing JSON)
├── cursor-directory-submission.md                 (Cursor Directory walkthrough)
└── modelcontextprotocol-registry-submission.md    (MCP registry PR draft)
```

## Order of publishing (recommended)

1. **modelcontextprotocol/registry first.** It is the canonical source-of-truth and the lowest-traffic surface for early-warning bug surfacing. If something breaks (manifest schema rejection, transport mismatch, bad description), it surfaces in PR review on a public GitHub thread, not in customer-facing surface area.
2. **Smithery second.** Smithery auto-pulls from a manifest; if your registry entry is solid, Smithery onboarding is near-zero-effort.
3. **Cursor Directory third.** Highest-leverage end-user surface (Cursor power users are the closest match to Verity's target audience), but slowest editorial cycle. Saving for last gives the longest field-test window.

## Brand rules (verbatim from project CLAUDE.md)

- Never write original marketing copy. Pull from `marketing-skills/verity-positioning-angles-feb2026.md` in the verity repo.
- Never reveal data sources, ingestion methods, API names, or implementation paths in customer-facing surface area.
- Tool descriptions in `manifest.json` and `src/tools/*.ts` are the source-of-truth user-facing copy. The submission docs MUST quote those verbatim, not paraphrase.
- Em-dashes (U+2014), en-dashes (U+2013), horizontal-bar (U+2015), minus-sign (U+2212): zero. Verify with `grep -cP '\x{2014}|\x{2013}|\x{2015}|\x{2212}' <file>`.
