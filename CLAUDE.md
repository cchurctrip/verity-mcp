# verity-mcp project context

## What this repo is

Sibling repo to [cchurctrip/verity](https://github.com/cchurctrip/verity). Hosts a Cloudflare Worker that exposes Verity's skill routes as MCP (Model Context Protocol) tools at `mcp.verityskills.com`.

Worker is a thin bearer-token proxy. Zero state. Zero DB credentials. No upfront auth validation. Translates `Authorization: Bearer vtk_*` (MCP client side) into `x-verity-key: vtk_*` (parent repo skill route side). Forwards request bodies byte-identical. Forwards responses verbatim except for injecting an absolute `upgrade_url` on 402 `TRIAL_CAP_REACHED` bodies.

## Story tracking

- **VRT-146a** (in-progress): this repo's scaffold + Worker + 6 tools + manifest.json. Spec at [verity/mydocs/specs/2026-05-13_VRT-146a_mcp_worker.md](https://github.com/cchurctrip/verity/blob/main/mydocs/specs/2026-05-13_VRT-146a_mcp_worker.md).
- **VRT-146b** (pending): full 8-gate production-readiness bootstrap on this repo (SAST, Renovate, OSV-Scanner, threat model, perf budget).
- **VRT-146c** (done): main-repo synthetic-smoke cron + runbook (lives in cchurctrip/verity).
- **VRT-148** (pending): marketplace submissions consuming the locked `manifest.json` schema.

## Production-readiness gate posture

Per the parent spec's gate-applicability matrix (VRT-146a Phase 1 vs VRT-146b Phase 1):

- **Gate 1 (SAST: Semgrep + CodeQL):** deferred to VRT-146b.
- **Gate 2 (Dep/CVE scan):** deferred to VRT-146b. Renovate + Dependabot + OSV not yet wired.
- **Gate 3 (Migrations):** N/A. Zero DB access in this Worker.
- **Gate 4 (Property-based tests):** in scope. Three targets: bearer regex, upgrade_url rewrite predicate, JSON-RPC envelope validator.
- **Gate 5 (Synthetic smoke):** wired in main repo VRT-146c at `app/api/cron/mcp-synthetic-smoke/route.ts`. Pings `mcp.verityskills.com/health` every 5 minutes behind `MCP_HEALTH_EXPECTED` env flag in the parent repo. Owner flips the flag after DNS propagation.
- **Gate 6 (Performance budget):** replaced. Lighthouse doesn't apply to a JSON-RPC Worker. Replaced with cold-start <150ms p50 + p99 <500ms in `docs/performance-budget.md` (deferred to VRT-146b).
- **Gate 7 (Threat model):** deferred to VRT-146b. `THREAT_MODEL.md` with STRIDE for the bearer-auth-proxy surface.
- **Gate 8 (Feature flags / kill switch):** in scope. `MCP_KILL_SWITCH` (global) + `MCP_TOOLS_DISABLED` (per-tool, comma-separated) as Wrangler secrets.

## Brand rules (non-negotiable)

1. **Tool descriptions** in `manifest.json` and `src/tools/*.ts` are user-facing copy. NEVER write original marketing copy. Pull from the parent repo's `marketing-skills/verity-positioning-angles-feb2026.md`.
2. **No implementation detail in user-facing surfaces** (`manifest.json` descriptions, `README.md`, tool description fields, `/sse` stub error messages). Forbidden tokens: file paths (`lib/`, `app/`, `supabase/`), TypeScript identifiers, VRT story IDs, vendor names beyond Cloudflare/Wrangler. Enforced by `tests/manifest.snapshot.test.ts` (Phase 4).
3. **Em-dashes (U+2014), en-dashes (U+2013), horizontal-bar (U+2015), minus-sign (U+2212):** zero. On every doc, spec, runbook, PR-comment >= 100 words. Verify before commit with `grep -cP '\x{2014}\|\x{2013}\|\x{2015}\|\x{2212}' <file>`.
4. **Auth contract:** `x-verity-key` upstream header MUST NOT carry the `Bearer ` prefix. Parent repo's `hashApiKey()` at `lib/apiKeyAuth.ts:15-17` hashes the raw `vtk_` token; forwarding `Bearer vtk_*` breaks hash equality.

## Cloudflare Workers plan

Bundled plan ($5/mo) from day 1. `wrangler.toml [limits].cpu_ms = 50`. Owner-decided 2026-05-13 to give always-on Sentry init headroom (cold-start around 30-40ms p50 on Bundled vs blowing the 10ms Free-tier limit).

## Key files

- `src/index.ts` Worker entry, route dispatch
- `src/auth.ts` bearer extraction + header translation (Phase 2)
- `src/mcp.ts` JSON-RPC 2.0 framing (Phase 2)
- `src/upstream.ts` upstream proxy + 402 rewrite (Phase 2)
- `src/observability.ts` structured logs + Sentry (Phase 2)
- `src/tools/` six tool definitions (Phase 2)
- `manifest.json` locked canonical schema for marketplace consumers
- `wrangler.toml` Worker config + custom domain routes
- `.github/workflows/ci.yml` lint + typecheck + test + wrangler dry-run
- `.github/workflows/code-review.yml` Codex CI gate
- `tests/` unit + property + integration tests (Phase 4)

## CI gates

Required-to-pass checks: `ci` (lint, typecheck, test, wrangler dry-run, manifest schema), `code-review`.
