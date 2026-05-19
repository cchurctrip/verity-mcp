# Spec: VRT-149f Worker contract alignment (verity-mcp side)

**Date**: 2026-05-19
**Depth**: standard
**Branch**: feat/vrt-149f-worker-contract
**Repo**: cchurctrip/verity-mcp (sibling of cchurctrip/verity)

## Goal

Align all 6 verity-mcp Worker tool definitions, the manifest, the manifest
schema check, and the manifest snapshot test to the new upstream skill-route
contracts now merged on cchurctrip/verity origin/main, so authenticated
MCP-client tool calls stop returning 400. Add 6 live end-to-end contract
tests that skip cleanly without a secret.

## Boundary

In scope (all under ~/workspace/verity-mcp-149f):
- src/tools/coordination-heat.ts, cross-check-alert.ts, disinfo-alert.ts,
  morning-brief.ts, verity-scan.ts, verity-score.ts
- src/upstream.ts TOOL_ROUTES (dispatch table mirrored by tool upstreamPath)
- manifest.json (tool entries, auth.anonymous_tools)
- scripts/check-manifest-schema.sh (CI-blocking; coordination-heat anon
  assertion now invalid)
- tests/manifest.snapshot.test.ts (required-array snapshot)
- tests/integration.test.ts (keep green; happy-path upstreamPath strings)
- tests/e2e/live-contract.test.ts (NEW; 6 live tests, env-gated skip)
- docs/DEVLOG.md (recovery checkpoint)

NOT in scope: any cchurctrip/verity changes; prd.json (none in this repo);
workspace-verity VRT-149f status flip; Brand-Rule-4 page edits (flag only);
VRT-149h marketplace submissions.

## Facts (verified against verity origin/main)

- TIER_LIMITS.pro.watchlist = 50 (lib/tierLimits.ts).
- New routes exist and are merged: cross-check-claim, disinfo-monitor,
  coordination-score. Renamed shims exist: cross-check-ticker,
  disinfo-analyze, coordination-leaderboard (transparent in-process
  delegating aliases, no 3xx, per amended C7). Worker points at the NEW
  marketed ops, not the renamed legacy shims.
- coordination-score is auth-required: 401 no key, 403 invalid/non-entitled.
  This flips the Worker coordination-heat tool from requiresAuth:false to
  requiresAuth:true. The tool NAME stays (B-full preserves the marketed
  surface). Cascades: manifest requires_auth true + anonymous_tools [],
  relax check-manifest-schema.sh coordination-heat-anonymous assertion.
- verity-score: subject alias live; 401 invalid key (anon = free shape).
- verity-scan: subject alias live; 401 no key, 403 non-entitled.
- morning-brief: watchlist REQUIRED non-empty, no date read, max =
  TIER_LIMITS.pro.watchlist (50); 401 invalid key.
- cross-check-claim verdict enum is 4-value:
  CORROBORATED | CONFLICTED | UNVERIFIED | NO_SIGNAL.
- disinfo-monitor: subject + severity_threshold BOTH required.

Response shapes (for live e2e assertions):
- coordination-score: { subject, score, band, summary, signals_found,
  sources_checked, window_hours }
- verity-score auth: { ticker, score, explanation, breakdown, asof }
- morning-brief auth: { variant, subject, tickers, asof }
- verity-scan auth: { tickers_checked, scan_window_hours, anomalies, clean,
  anomaly_count, scanned_at }
- cross-check-claim: { verdict, confidence, sources_checked,
  signals_matched, citations, source_conflicts, summary }
- disinfo-monitor: { subject, severity_threshold, detected, status,
  patterns, summary, signals_found, sources_checked, analyzed_at }

## Plan

1. src/upstream.ts: TOOL_ROUTES coordination-heat ->
   /api/skills/coordination-score; cross-check-alert ->
   /api/skills/cross-check-claim; disinfo-alert ->
   /api/skills/disinfo-monitor. Other 3 unchanged.
2. src/tools/coordination-heat.ts: requiresAuth true, upstreamPath
   coordination-score, schema unchanged (subject required), description
   stays marketing-accurate (no anon claim).
3. src/tools/cross-check-alert.ts: upstreamPath cross-check-claim,
   description advertises the 4-value verdict, schema { claim, sources? }
   already correct.
4. src/tools/disinfo-alert.ts: upstreamPath disinfo-monitor,
   severity_threshold becomes required (subject + severity_threshold).
5. src/tools/verity-score.ts + verity-scan.ts: keep subject schema (alias
   live upstream); description accurate; paths unchanged.
6. src/tools/morning-brief.ts: required ["watchlist"], remove date prop,
   maxItems pinned with explicit comment tying it to pro watchlist tier.
7. manifest.json: coordination-heat requires_auth true; anonymous_tools [].
8. scripts/check-manifest-schema.sh: relax the coordination-heat-anon
   assertion; allow empty anonymous_tools.
9. tests/manifest.snapshot.test.ts: update required-array snapshot
   (disinfo-alert now ["subject","severity_threshold"]).
10. tests/integration.test.ts: update happy-path upstreamPath strings;
    coordination-heat now needs an auth header in the happy-path case.
11. tests/e2e/live-contract.test.ts: 6 live tests vs mcp.verityskills.com,
    env-gated on VERITY_MCP_TEST_KEY, skip cleanly when absent. C3 per-tool
    auth status pinned (verity-score 401 invalid key; verity-scan /
    cross-check / disinfo 403 non-entitled). coordination-heat
    empty-vs-nonempty note shape difference asserted per spec appendix.
12. Local green: npm ci, lint, typecheck, test, wrangler dry-run.

## Risks

- coordination-heat auth flip is the highest-blast-radius change. Mitigation:
  it is the only contract-correct option (coordination-score rejects
  anonymous); name preserved; manifest + script + snapshot kept consistent
  in the same diff so CI is internally coherent.
- check-manifest-schema.sh is CI-blocking; an inconsistent edit fails `ci`.
- Live e2e must skip without secret so CI stays green; never hardcode vtk_.
- No 3xx may be introduced (open-redirect class, amended C7). Worker only
  forwards; we add no redirect.
- Brand Rule 2: descriptions stay marketing-accurate, no impl detail.
- Brand Rule 4: x-verity-key no Bearer prefix (not touched here; auth path
  unchanged).

## Validation

npm ci && npm run lint && npm run typecheck && npm test && npx wrangler
deploy --dry-run --env preview. Live e2e skips cleanly with no
VERITY_MCP_TEST_KEY. Em-dash grep returns 0 on every modified/added file.

## Change Log

- 2026-05-19: spec created (standard mode). Owner approval pre-granted
  (B-full + amendments approved on verity main, autonomous execution
  authorized per parent brief).
