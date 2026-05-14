# verity-mcp Dev Log

Sibling-repo session history for VRT-146a (Worker scaffold + 6 tools + manifest)
and VRT-146b (full prod-readiness bootstrap). Cross-references the main-repo
DEVLOG at cchurctrip/verity:docs/DEVLOG.md for spec-level context.

---

## Checkpoint: 2026-05-13 (VRT-146a Phase 2.2 start)

**Active task:** Implement src/observability.ts + src/upstream.ts + their tests on feat/phase-2-upstream branch. Second chunk of Phase 2 per approved spec at cchurctrip/verity:mydocs/specs/2026-05-13_VRT-146a_mcp_worker.md.

**Approved spec sections covered:**
- §Plan/Phase 2 src/observability.ts: structured logs with auth_present boolean (never token value); Sentry SDK init per owner Bundled-plan choice; beforeSend redacts authorization header values.
- §Plan/Phase 2 src/upstream.ts: build x-verity-key (no Bearer prefix); x-request-id propagation; 30s fetch timeout; both 402 body shape rewrite (typical at app/api/skills/verity-score/route.ts:162-171 + secondary at :187-190); 5xx returns HTTP 200 + JSON-RPC error with error.data.upstream_status; per-tool kill switch MCP_TOOLS_DISABLED + global MCP_KILL_SWITCH.
- §Plan/Phase 4 tests/upstream.property.test.ts: Gate 4 property target 2 of 3 (upgrade_url rewrite predicate).

**Files to be created:**
- src/observability.ts (UUIDv7 request_id, structured log builder, Sentry init)
- src/upstream.ts (header translation, kill switches, dual 402 rewrite, 5xx handling)
- tests/observability.test.ts (unit)
- tests/upstream.test.ts (unit; all 6 tools paths + kill switch parser negative-space)
- tests/upstream.property.test.ts (property target 2 of 3)

**Files to be modified:** none. src/index.ts wiring happens in Phase 2.3 with mcp.ts.

**Already done this session (cross-repo):**
- cchurctrip/verity: PR #258 merged at 6229bc7 (VRT-147 /llms.txt). PR #260 merged at 87b7567 (VRT-146c smoke cron). PR #264 merged at 13d9147 (VRT-146a Phase 0 spec).
- cchurctrip/verity-mcp: created. PR #1 merged at 196ee81 (Phase 1 scaffold). PR #2 merged at d9f77d1 (Phase 2.1 src/auth.ts; refactored to discriminated-union readBearer per convergent multi-agent finding).
- Branch protection on verity-mcp main: 1 PR review + 2 required checks (ci, code-review); strict mode; force-push + deletion blocked.

**Next step if resuming:**
Start at task #18 (src/observability.ts). Then task #19 (src/upstream.ts + tests). Then task #20 (full pre-PR pipeline run on the diff). Then task #21 (commit + push + open PR #3).

**Context:**
Phase 2.2 is the upstream proxy logic. Highest-risk module in the Worker since it handles auth-bearer translation, paid-tier-gating, and the production-blocking 402 dual-shape rewrite. Per the cleaner pipeline workflow agreed this session, the 6-agent pr-review-toolkit batch + blast-radius-review run BEFORE the PR opens (not retroactively as on PR #2). Convergent findings get applied inline before owner sees the PR.

readBearer from src/auth.ts (merged at d9f77d1) returns the BearerResult discriminated union. Phase 2.2 upstream.ts consumes it via exhaustive switch on .kind to satisfy hidden coupling #1 at the type level.
