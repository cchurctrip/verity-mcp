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

---

### Session #16 (sibling-repo): 2026-05-13 / 2026-05-14
**Status**: Phase 2.2 PR in flight (iter-2, expecting clean Bugbot terminal). Main at d9f77d1 (post Phase 2.1).
**Files changed across session**: ~25 (5 commits across 3 PRs).

**Accomplished**:
- **PR #1 (Phase 1 scaffold)** merged at 196ee81. Iter-cap convergent: Node 22 fix, kill-switch route order, Brand Rule #2 VRT-ID removal, ESLint --ext fix, wrangler custom_domain wildcard fix, BOOT_TIME_MS Spectre mitigation (Cloudflare Workers prod returns 0 from Date.now at module scope), CORS on / redirect. Branch protection set: 1 PR review + 2 required checks, strict mode.
- **PR #2 (Phase 2.1 src/auth.ts)** merged at d9f77d1. Pre-PR pipeline ran retroactively. 6-agent + blast-radius surfaced convergent P1 (silent-failure + type-design): extractBearer + hasAuthHeader collapsed two states into null. Refactored to readBearer returning BearerResult discriminated union (absent / invalid / valid). Property test oracle changed from production-regex tautology to hand-written char predicate. Empty-string Authorization pinned as kind: 'invalid'.
- **PR #3 (Phase 2.2 observability + upstream)** open at 213968c. Pre-PR pipeline ran BEFORE opening. 6-agent + blast-radius DEEP. Convergent P0/P1 applied inline: scrubAuthorization WeakSet cycle-tracking; property-test no-extraneous-keys; upstream_error split into upstream_5xx + upstream_network_error (3-lens convergent); 5xx body preserved; stale cross-repo path fix; AbortError + non-Error throw coverage; TOOL_ROUTES type guard with ToolName. 125 tests pass; Gate 4 property targets 1 of 3 (auth) and 2 of 3 (upgrade_url rewrite) complete.

**Key changes**:
- `src/auth.ts` (PR #2): readBearer BearerResult union + parseBearer pure function. Strict regex with (?![\s\S]) end anchor.
- `src/observability.ts` (PR #3): UUIDv7 fail-loud, structured logs never carry tokens, logRequest fail-safe, scrubAuthorization with WeakSet cycle-tracking, pure SentryConfig builder.
- `src/upstream.ts` (PR #3): TOOL_ROUTES with ToolName type guard, parseDisabledTools, buildUpstreamHeaders (x-verity-key raw token NO Bearer prefix per coupling #8 + x-request-id propagation per #9), rewriteUpgradeUrl (both 402 shapes, no extras, idempotent, nested isolation), proxyToolCall with ProxyOutcome split kinds.
- `tests/*` (PR #3): 92 new tests; parametrized 5xx boundary (499/500/502/503/504/520/599), per-tool URL coverage, DOMException timeout, non-Error throw, circular-ref scrubbing, concurrent UUIDv7, idempotency property, no-extraneous-keys property, nested upgrade_url isolation.
- `.gitignore`: excludes `DIFFERENTIAL_REVIEW_REPORT*.md` (session-local audit artifacts).

**Decisions**:
- Owner picked Cloudflare Workers Bundled plan ($5/mo) + cpu_ms: 50 over Free 10ms ceiling. Sentry init has headroom.
- /sse minimal stub returns JSON-RPC -32601 (preserves manifest transport claim, defers full SSE to Sprint 4).
- 5xx upstream returns HTTP 200 + JSON-RPC error envelope with error.data.upstream_status (cleaner JSON-RPC over HTTP).
- code-review.yml Codex CI placeholder from day 1; full port pending gatekeeper-ai PR #280.
- Pipeline workflow shift: PR #2 ran pipeline retroactively (3 inline fix iterations after open). PR #3 ran pipeline BEFORE opening (1 inline fix iteration after open). Pre-PR pipeline is canonical going forward.

**Remaining todos (next session priority)**:
1. [ ] Merge PR #3 once iter-2 Bugbot converges
2. [ ] Phase 2.3: src/mcp.ts + src/tools/*.ts (6 files) + tests/mcp.test.ts + tests/mcp.property.test.ts (Gate 4 target 3 of 3 JSON-RPC envelope) + tests/manifest.snapshot.test.ts (Brand Rule #2 forbidden-string) + src/index.ts wiring
3. [ ] Phase 2.4: tests/integration.test.ts end-to-end with mocked upstream
4. [ ] Phase 2 deferred from 2.2: Sentry beforeSend signature alignment with @sentry/cloudflare; LogLineFields discriminated union; parseDisabledTools warning log
5. [ ] VRT-146b: 8-gate prod-readiness bootstrap on sibling repo (defer until 146a deploys)
6. [ ] VRT-148: marketplace submissions (owner-blocked on DNS CNAME + production deploy)

### Handoff for next session
**Current state**: cchurctrip/verity-mcp main at d9f77d1 (Phase 2.1 auth merged). PR #3 open at 213968c (Phase 2.2 observability + upstream); iter-2 CI converging post-Bugbot-FP-fix; expected to merge cleanly. cchurctrip/verity main at 13d9147 (Phase 0 spec + Gate 2 review + prd.json status flip; VRT-146a in-progress).

**Context files**:
1. `/Users/autopilotventures/workspace/verity-mcp/docs/DEVLOG.md` (this file)
2. `/Users/autopilotventures/workspace/verity-vrt-146a/mydocs/specs/2026-05-13_VRT-146a_mcp_worker.md` (canonical spec)
3. `/Users/autopilotventures/workspace/verity-vrt-146a/docs/arch-review-vrt-146a-worker.md` (Gate 2 review)

**Next 3 steps**:
1. Confirm PR #3 iter-2 Bugbot terminal state on `213968c`. If clean (SUCCESS or stales-only), request `merge 3` plain-text auth and admin-squash-merge.
2. Switch to main, pull post-merge, create branch `feat/phase-2-mcp-tools` off origin/main. Write /auto-handoff checkpoint to docs/DEVLOG.md before first file change.
3. Begin Phase 2.3 implementation: src/mcp.ts (JSON-RPC framing + initialize w/ protocolVersion 2025-03-26 + tools/list + tools/call dispatch), then 6 src/tools/*.ts (descriptions sourced from cchurctrip/verity:marketing-skills/verity-positioning-angles-feb2026.md; default Angle 7 + 9 per VRT-147 precedent unless owner redirects), wire upstream + mcp into src/index.ts (replace /mcp 501 stub). Run full pre-PR pipeline (6-agent + blast-radius) BEFORE opening the PR.

**Ask on resume**: Confirm Phase 2.3 plan + which positioning angles for which tool descriptions (default Angle 7 + 9, or redirect)?

---

## Checkpoint: 2026-05-14 (VRT-146a Phase 2.3 start)

**Active task:** Phase 2.3 implementation on branch `feat/phase-2-mcp-tools`. Spec: cchurctrip/verity:mydocs/specs/2026-05-13_VRT-146a_mcp_worker.md §Plan/Phase 2 src/mcp.ts and src/tools/*.

**Pre-conditions verified before first file change:**
- PR #3 merged at `6a6b322` (admin-squash, REVIEW_REQUIRED override; all 3 gates green; Bugbot SUCCESS on 213968c per check-runs API).
- Local main fast-forwarded to `6a6b322`; new branch `feat/phase-2-mcp-tools` created off `origin/main`.
- DEVLOG cleaned of watchdog noise blocks; Session #16 narrative preserved.

**Plan (in dependency order):**
1. `src/mcp.ts`: JSON-RPC 2.0 framing. parse body, validate envelope (-32700 / -32600 / -32601). Methods: `initialize` returns byte-identical `{ protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'verity-mcp', version: '1.0.0' } }` (Gate 2 BLOCKING #3); `tools/list` returns the 6 tool defs; `tools/call` dispatches via `proxyToolCall` in src/upstream.ts and maps `ProxyOutcome` to JSON-RPC envelopes per the comment block already in upstream.ts.
2. `src/tools/{coordination-heat,verity-score,morning-brief,verity-scan,cross-check-alert,disinfo-alert}.ts`: each exports `{ name, description, inputSchema, requiresAuth, upstreamPath }`. Descriptions default to Angle 7 + 9 per VRT-147 precedent (owner did not redirect this session).
3. `src/tools/index.ts`: tools array + name dispatch table.
4. `tests/mcp.test.ts`: initialize byte-identical, tools/list returns 6, tools/call dispatches to upstream, malformed envelopes, all JSON-RPC error codes.
5. `tests/mcp.property.test.ts`: Gate 4 property target 3 of 3 (JSON-RPC envelope validator).
6. `tests/manifest.snapshot.test.ts`: Brand Rule #2 forbidden-string snapshot.
7. `src/index.ts`: replace `/mcp` 501 stub with real dispatch; wire `scrubAuthorization` beforeSend through `buildSentryConfig`.
8. `tests/health.test.ts`: `/mcp` now returns 200 with JSON-RPC initialize/tools/list responses instead of 501.

**Deferred to Phase 2.4** (not in this PR): `tests/integration.test.ts` with @cloudflare/vitest-pool-workers SELF.fetch + mocked upstream covering all 6 tools across happy / 401 / 402 dual-shape / 403 / 5xx / per-tool kill switch / global kill switch / INVALID_BEARER_FORMAT. Also `@sentry/cloudflare` SDK dep landing + `SentryConfig.beforeSend` signature alignment + `LogLineFields` discriminated union refactor + `parseDisabledTools` warning log on all-malformed config.

**Next step if resuming:** Start at task #1 (src/mcp.ts) on branch `feat/phase-2-mcp-tools` at `git rev-parse HEAD` (currently `6a6b322`, identical to origin/main).
