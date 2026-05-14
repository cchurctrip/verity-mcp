# verity-mcp Performance Budget

Lighthouse is N/A for a JSON-RPC Cloudflare Worker (no HTML, no rendered route, no Core Web Vitals surface). Gate 6 is replaced by the cold-start and percentile-latency budget recorded here per Gate 2 REQUIRED #11 (the budget lives in `docs/performance-budget.md`, NOT in `THREAT_MODEL.md`).

## Targets

| Metric | Target | Rationale |
|---|---|---|
| Cold-start latency p50 | less than 150ms | Cloudflare Workers Bundled plan with always-on Sentry init. Owner-chosen 2026-05-13 over Free 10ms ceiling for Sentry headroom. Measured at the Worker edge, not at the client. |
| Cold-start latency p99 | less than 500ms | Captures the slow tail of cold V8 isolate boot + Sentry init + first upstream fetch. |
| Warm-request latency p50 | less than 50ms | Pure proxy overhead: bearer extraction, JSON-RPC framing, header translation, upstream fetch, response forwarding. No DB, no LLM, no compute. |
| Warm-request latency p99 | less than 250ms | Tail captures upstream (`verityskills.com`) latency variability, not the Worker. |
| Upstream timeout | 30s | Hard cap in `src/upstream.ts` AbortController. If upstream is slower, the Worker returns a 5xx-mapped JSON-RPC error with `error.data.upstream_status`. |
| CPU time budget (`wrangler.toml [limits].cpu_ms`) | 50ms | Bundled plan. 5x the Free-tier ceiling. Headroom for Sentry beforeSend scrubber + UUIDv7 generation + structured log builds. |
| Worker bundle size | less than 500 KB compressed | Free deploy is uncapped on Bundled but small bundles cut V8 isolate cold-start. Tracked via `wrangler deploy --dry-run --outdir=dist` size output. |

## How to measure

### 1. Cloudflare Workers analytics (primary source of truth)

Cloudflare Dashboard → Workers and Pages → `verity-mcp` (production env) → Metrics tab. The Metrics dashboard surfaces:

- Requests per second.
- Errors per second (4xx + 5xx breakdown).
- CPU time (median + p99 by default in the dashboard view).
- Duration (wall-clock) (median + p99 by default).

For the full p50 / p95 / p99 percentile breakdown, query the GraphQL Analytics API directly (or the Workers Analytics Engine if you wire dispatches from the Worker itself). Cold-start visibility is NOT a dashboard column. Read it from `wrangler tail` per-invocation log timing, or from the GraphQL Analytics API.

The CPU columns are the actual budget enforcement: if p99 CPU time crosses 50ms, the Worker is at risk of hitting the `[limits].cpu_ms = 50` ceiling and dropping requests.

### 2. `wrangler tail` (local real-time)

Run `wrangler tail` against the production env during a synthetic-traffic burst to see per-request log lines with the `latency_ms` field populated by the structured-log builder in `src/observability.ts`. CPU time is not in the structured log (the runtime does not expose it to user code); read it from Cloudflare Workers Metrics or from `wrangler tail`'s per-invocation summary line.

### 3. Synthetic-smoke cron (continuous baseline)

VRT-146c installed `/api/cron/mcp-synthetic-smoke` on `cchurctrip/verity` (Vercel cron, every 5 minutes). It pings `mcp.verityskills.com/health` and records the round-trip in Vercel logs. Use it as a 24x7 latency baseline, not as the precise edge measurement (it includes Vercel-to-Cloudflare network hop).

### 4. Bundle size

Pre-deploy: `wrangler deploy --dry-run --outdir=dist && du -sb dist/`. Tracked manually in PR descriptions when a bundle-affecting dependency is bumped.

## Review cadence

- Quarterly review by default: open a tracking issue at the start of each quarter, paste the latest 4 weeks of Cloudflare metrics, confirm the targets above are still met, update the `Last-reviewed:` line.
- Immediate review on any of these triggers:
  - Renovate or Dependabot bumps a deploy-surface package (`wrangler`, `@cloudflare/workers-types`, `@sentry/cloudflare`).
  - A PR adds a new dependency to `package.json` (production deps only; devDeps are out of scope).
  - The synthetic-smoke cron reports more than 2 minutes of consecutive 5xx (post-deploy regression signal).
  - p99 CPU time crosses 30ms (early-warning at 60% of the 50ms ceiling).

## Mitigation playbook

If the budget is breached:

1. **Cold-start regression** (p50 cold over 150ms): bisect the last 7 days of merges; the most likely culprit is a new module-scope import that pulls a heavy dependency tree into the cold path. Move imports inside the request handler if possible.
2. **CPU time regression** (p99 over 30ms warn / over 40ms block): profile via `wrangler dev --local --inspect` and a representative request body. Likely causes: synchronous loops in JSON-RPC envelope handling, beforeSend scrubber over a large body, UUIDv7 generation on every log line.
3. **Upstream-driven latency regression** (warm p99 over 250ms): the Worker is not the cause. Check `app/api/skills/*` route latency on the main `cchurctrip/verity` repo via Vercel function logs. Most likely the upstream is slow, not the proxy.
4. **Bundle-size regression** (over 500 KB compressed): check the dependency that just landed. If avoidable, revert and find a lighter alternative. If required (e.g., a Sentry version bump), accept the new baseline and update the target here in the same PR.

## Last-reviewed

2026-05-14 (initial baseline; quarterly review schedule begins 2026-08-14)
