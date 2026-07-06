# verity-mcp Dev Log

Sibling-repo session history for VRT-146a (Worker scaffold + 6 tools + manifest)
and VRT-146b (full prod-readiness bootstrap). Cross-references the main-repo
DEVLOG at cchurctrip/verity:docs/DEVLOG.md for spec-level context.

---

## 2026-06-16: POST /sse cross-request I/O crash fix (Sentry 947521a7)

**Branch:** `fix/mcp-sse-cross-request-io` off `main` `2d07ee0` (the deployed release the error fired on).

**Symptom:** unhandled production error `Cannot perform I/O on behalf of a different request (I/O type: RefcountedCanceler)` at `relaySsePostToStream`, env `verity-mcp-production`. Sentry `947521a7d6224351a45a8d504c9245ee`.

**Root cause:** the VRT-165 legacy-SSE bridge stored each `GET /sse` stream writer in a module-scope map and had `POST /sse` write the JSON-RPC response into that writer. The design assumed the only failure mode was 'GET and POST landed on different isolates' (handled by the 202 + inline fallback). But Cloudflare Workers forbid one request handler from performing I/O on a stream created by a **different** request handler. GET and POST are always different requests, so the relay write threw on **every** same-isolate relay (the supposed happy path), and the throw escaped the call-site try/catch. The in-isolate relay was never viable on Workers. Impact was scoped to legacy-SSE clients (Comet, some Gemini surfaces); Streamable-HTTP clients use POST /mcp and were unaffected.

**Fix (minimal mitigation):** removed the cross-request relay from the POST /sse handler. `POST /sse` now always returns the JSON-RPC envelope inline (MCP 2024-11-05 §6.2.2 fallback), which both strict and lenient clients accept. No cross-request I/O remains. `relaySsePostToStream` + the `openStreams` map are retained (write-only, annotated) so the follow-up has the framing + bearer-hash plumbing in place. Existing CI tests already asserted the inline-200 contract; the gated e2e probe + `multi-client-probe.sh` Probe 9 already tolerate 200-or-202, so nothing in CI or the live probes breaks.

- `src/index.ts`: removed the relay block + the `relaySsePostToStream` import; POST /sse returns inline.
- `src/transport-sse.ts`: annotated `relaySsePostToStream` as retained-not-wired.
- `tests/transport-sse.test.ts`: retitled the POST /sse describe to the always-inline contract.

**FOLLOW-UP (own story, not yet scheduled): Durable-Object SSE relay.** Restore true server-to-GET-stream delivery via a Durable Object that owns the stream (or migrate to Cloudflare's `agents` SDK `McpAgent`), so GET and POST address the same I/O context. AC: POST /sse response lands as an `event: message` on the same bearer's open GET stream end-to-end; Probe 9 asserts the relayed-on-stream path; no `RefcountedCanceler` under load. First reassess whether the legacy SSE bridge is still needed at all: if Comet/Gemini accept the inline 6.2.2 response in practice, the DO is unnecessary and `relaySsePostToStream` + `openStreams` can simply be deleted. Needs a parent-repo `prd.json` VRT record when scheduled (VRT-167 is taken; pick the next free ID).

---

## Checkpoint: 2026-05-15 (VRT-146d Sentry environment tag follow-up)

**Active task:** add `environment` tag to Worker's Sentry init so events filter cleanly when the same `SENTRY_DSN` is shared with the main verityskills.com Next.js app. Branch `feat/vrt-146d-sentry-environment-tag` off main `a049f36` (post VRT-146b merge).

**Why this is necessary:** Block A reused the existing main-repo `SENTRY_DSN` to keep deploy fast. Without an `environment` tag on Worker events, Worker errors mix visually with Next.js errors in the same Sentry project view. The release-tag filter (commit SHA) partially separates them but is awkward for on-call. Setting `environment: 'verity-mcp-production'` / `'verity-mcp-preview'` is the canonical Sentry separation pattern.

**Worker secret already deployed during Block A.** Both preview and production Workers already have `SENTRY_ENVIRONMENT` set via `wrangler secret put`. The current main code does NOT read it, so the secret is dormant. This PR adds the code that reads it; post-merge redeploy activates the tag.

**Approved scope (verbal approval 2026-05-15):**
- `src/observability.ts`: add `SENTRY_ENVIRONMENT?: string` to `ObservabilityEnv` interface; add `environment: env.SENTRY_ENVIRONMENT ?? 'verity-mcp-unknown'` to `buildSentryConfig` return.
- `tests/observability.test.ts`: 4 new test cases covering happy-path production tag, preview tag, unset fallback, empty-string fallback.

**Files modified:**
- `src/observability.ts` (8 lines added)
- `tests/observability.test.ts` (35 lines added)
- `docs/DEVLOG.md` (this entry)

**Next step if resuming:** run pre-PR 6-agent batch on the diff, push branch, open PR, iterate-until-green, request "merge 9" plain-text auth, redeploy Worker production to activate the tag.

**Context (post Block A):**
- `mcp.verityskills.com` went live during Block A on 2026-05-14T20:50Z. Synthetic-smoke cron verified healthy.
- VRT-146a / VRT-146b / VRT-146c all shipped. VRT-148 marketplace submissions held until manual real-world testing.
- User-side follow-ups outstanding: Claude Desktop config test (5 min), Cloudflare API token rotation after this PR's redeploy.

---

## Checkpoint: 2026-05-14 (VRT-146b production-readiness bootstrap start)

**Active task:** wire 4 of the 8 production-readiness gates on `cchurctrip/verity-mcp`. Branch `feat/vrt-146b-prod-readiness` off main `a3c3527` (post PR #6 merge).

**Approved spec sections covered (verbal approval 2026-05-14):**
- Gate 1 SAST: Semgrep CE + GitHub CodeQL on every PR.
- Gate 2 Deps/CVE: Renovate (general npm bumps grouped) + Dependabot (security-only) + OSV-Scanner workflow; documented secret-scope mirror for Codex CI per `feedback_dependabot_secret_scope_mirror.md`.
- Gate 6 Perf budget: cold-start p50 less than 150ms + p99 less than 500ms documented; Lighthouse stays N/A (JSON-RPC Worker).
- Gate 7 Threat model: STRIDE per the bearer-auth-proxy surface; `Last-reviewed: 2026-05-14` header; cross-refs scar-tissue memories.

**Files to be created (zero src/** changes):**
- `.github/workflows/sast.yml`
- `.github/workflows/osv-scanner.yml`
- `renovate.json`
- `.github/dependabot.yml`
- `docs/performance-budget.md`
- `THREAT_MODEL.md`

**Files to be modified:**
- `docs/DEPLOY_RUNBOOK.md` (one new section documenting the Dependabot secret-scope mirror procedure)

**Already done this session (cross-repo):**
- `cchurctrip/verity-mcp`: PR #6 merged at `a3c3527` (launch-readiness docs bundle).
- Ingestion status snapshot pulled from Vercel CLI: Reddit, News, Twitter, YouTube, Polymarket all firing on schedule, HTTP 200. Several warning-level log lines for the other agent to investigate (not in scope here).

**Next step if resuming:** start at task 1 (`.github/workflows/sast.yml`) on branch `feat/vrt-146b-prod-readiness` at HEAD `a3c3527`. Then OSV-scanner, then Renovate + Dependabot, then perf budget doc, then threat model. Run 6-agent `pr-review-toolkit` batch in a single message before opening the PR. Verify zero em-dashes (`grep -cP '\x{2014}|\x{2013}|\x{2015}|\x{2212}' <file>`) on every doc with body greater than 100 words.

**Context:**
- VRT-146a code is shipped. `mcp.verityskills.com` will go live once owner runs OWNER_CHECKLIST.md Block A (Cloudflare login, Sentry project, secrets, deploy, DNS, env flip).
- The mission for this distribution play is agent-marketing-and-discovery across ALL tiers (trial / retail / pro / fund) via MCP marketplaces, NOT just Fund-tier. The mission correction was logged this session.
- VRT-146b hardens the surface BEFORE VRT-148 marketplace submissions. Order is deliberate: don't submit to Smithery / Cursor / Claude Desktop until SAST + deps + perf budget + threat model are in CI.
- Pipeline workflow shift confirmed: run `pr-review-toolkit` 6-agent batch BEFORE opening the PR, apply convergent findings inline.

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

---

## Checkpoint: 2026-05-14 (VRT-146a Phase 2.4 start)

**Active task:** Phase 2.4 on branch `feat/phase-2-4-integration`. The integration-test + Sentry-init final phase of VRT-146a per the spec's deferred list.

**Pre-conditions verified before first file change:**
- PR #4 merged at `563c574` (Phase 2.3 dispatch + tool defs).
- Main fast-forwarded; new branch `feat/phase-2-4-integration` off `origin/main`.
- 218 tests on main; all gates green.

**Plan (in dependency order):**
1. Install `@sentry/cloudflare` as a runtime dep. Align `SentryConfig.beforeSend` signature to `(event: ErrorEvent, hint: EventHint) => ErrorEvent | null`. Update `tests/observability.test.ts` calls.
2. Refactor `LogLineFields` to a discriminated union mirroring `ProxyOutcome.kind` so each outcome carries the right typed payload.
3. Wire `Sentry.withSentry(buildSentryConfig(env))(handler)` in `src/index.ts`. Graceful no-op when `SENTRY_DSN` unset.
4. `tests/integration.test.ts`: end-to-end via `@cloudflare/vitest-pool-workers` SELF.fetch + mocked upstream. All 6 tools across happy / 401 / 402 (both shapes) / 403 / 5xx / per-tool kill switch / global kill switch / INVALID_BEARER_FORMAT.
5. Full pre-PR pipeline (6-agent + blast-radius) BEFORE opening PR #5. Apply convergent findings inline.
6. Open PR #5; iterate to green; request merge auth.

**Follow-up PR #6 (launch-readiness docs, after PR #5 merge):** README rewrite with install snippets (Claude Desktop, Cursor, direct API), DEPLOY_RUNBOOK.md, SMITHERY.md + CURSOR.md submission packages, scripts/post-deploy-smoke.sh.

**Owner-blocked items surfaced at the end of this session:** Cloudflare account auth (`wrangler login`), `wrangler secret put SENTRY_DSN`, `wrangler deploy --env preview`, CNAME `mcp.verityskills.com`, Vercel env flip `MCP_HEALTH_EXPECTED=true` on main repo.

**Next step if resuming:** Start at task #10 (install @sentry/cloudflare) on `feat/phase-2-4-integration` at `git rev-parse HEAD` (currently `563c574`, identical to origin/main).

**Explicit defer (carried forward from Phase 2.2 plan):** the `parseDisabledTools warning log on all-malformed config` item is deferred again to VRT-146b. Rationale: the parser silently returns an empty Set when every entry trims to empty (e.g., `MCP_TOOLS_DISABLED=" , , "` from a typo'd `wrangler secret put`). The operator-UX concern is real, but a warn-log is the wrong fix without an alerting surface to read it. VRT-146b's threat model + telemetry pass is the right slot. Tracked here so the chain of custody is visible.

---

## Checkpoint: 2026-05-14 (Launch-readiness docs)

**Active task:** PR #6 on branch `feat/phase-2-4-docs`. Docs-only bundle landing after PR #5 merged.

**Pre-conditions verified:**
- PR #5 merged at `242158a`. VRT-146a code complete on main (Phases 1, 2.1, 2.2, 2.3, 2.4 all shipped).
- 237 tests on main; all gates green.

**Scope:**
- `README.md` rewrite with concrete install snippets (Claude Desktop, Cursor, direct curl).
- `docs/DEPLOY_RUNBOOK.md`: owner-executable deploy steps (8 numbered steps, ~45 min owner time).
- `docs/SMITHERY.md`: Smithery.ai marketplace submission package (YAML manifest + screenshot guidance).
- `docs/CURSOR.md`: Cursor Directory submission + Cursor Desktop config.
- `docs/CLAUDE_DESKTOP.md`: Claude Desktop install snippet + troubleshooting.
- `docs/OWNER_CHECKLIST.md`: sequenced action list (Block A deploy, Block B discovery, Block C launch, Block D monitoring).
- `docs/launch-drafts/hn-show-post.md`: Show HN draft + posting plan.
- `docs/launch-drafts/linkedin-essay.md`: Angle 9 essay (600 words).
- `docs/launch-drafts/twitter-thread.md`: 8-tweet thread.
- `docs/launch-drafts/skills-page-rewrite.md`: /skills page Angle 9 rewrite (owner-approval required; do not modify the main verity repo directly per Brand Rule).
- `scripts/post-deploy-smoke.sh`: 7-check post-deploy smoke (run after `wrangler deploy`).

**Pipeline note:** docs-only PR. Skip the 6-agent + blast-radius batch (per code-review plugin rule "official /code-review plugin skips drafts" and the canonical workflow which reserves the full batch for code changes). Em-dash audit + brand-rule check applied locally before commit.

**Next step if resuming:** Commit, push, open PR #6, iterate to green.

---

### Session #17, 2026-05-14
**Status**: VRT-146a code complete on main; PR #6 (launch-readiness docs) open at iter-2 awaiting CI poll + merge auth.
**Files changed**: 22 across 4 PRs in this session.

**Accomplished**:
- **PR #3 (Phase 2.2 observability + upstream)** merged at `6a6b322`. Admin-squash on owner go-ahead. Bugbot SUCCESS verified per-SHA on 213968c.
- **PR #4 (Phase 2.3 JSON-RPC framing + 6 tool defs + Gate 4 target 3 of 3)** merged at `563c574` after iter-2. 7-agent pre-PR pipeline ran in parallel. Iter-1 Bugbot found 3 findings (medium method-name amplification, low method_not_found tool=null contradiction, low dead-code getTool); all addressed in iter-2.
- **PR #5 (Phase 2.4 Sentry SDK + integration tests + log refactor)** merged at `242158a`. Adds `@sentry/cloudflare@10.53.1` runtime dep; wraps worker entry with `Sentry.withSentry`; aligns `scrubAuthorization` signature to real SDK; adds 18-test integration suite via SELF.fetch + fetchMock; refactors `LogLineFields` with `OutcomeKind` union; per-tool `as const satisfies Tool` for compile-time TOOLS/TOOL_ROUTES parity. 7-agent pre-PR pipeline + blast-radius SHIP verdict.
- **PR #6 (launch-readiness docs)** open at `292f654` after iter-2. 1163 LOC of docs + scripts: DEPLOY_RUNBOOK, SMITHERY, CURSOR, CLAUDE_DESKTOP, OWNER_CHECKLIST, 4 launch-post drafts, README rewrite, post-deploy-smoke.sh. Iter-1 Bugbot found 1 low-severity finding (no-op Check 5 in smoke script); fixed in iter-2 by removing Check 5 and renumbering.
- **VRT-146a is code-complete.** Phases 1, 2.1, 2.2, 2.3, 2.4 all on main. 237 tests passing.

**Key changes**:
- `src/observability.ts`: aligned `beforeSend` to `(event: ErrorEvent | null, hint?: EventHint) => ErrorEvent | null`; warn-log on scrubber crash; new OutcomeKind union (12 variants); LogLineFields extended.
- `src/index.ts`: wrapped default export with `Sentry.withSentry<Env>(buildSentryConfig, handler)`; structured log emits `outcome_kind`, `tool`, `upstream_status`, `error` per request.
- `src/mcp.ts`: new `outcomeLogFields` exhaustive switch replaces 16-line nested ternary; `HandleMcpResult.outcomeKind: OutcomeKind`.
- `src/tools/*.ts` (6 files): `as const satisfies Tool` pattern; literal-narrowing on name; TOOLS/TOOL_ROUTES drift now a compile error.
- `tests/integration.test.ts` (NEW, 309 LOC): SELF.fetch + fetchMock; all 6 tools happy + 401 + 402 dual + 403 + 5xx + INVALID_BEARER + arguments validation + x-verity-key auth contract + Sentry wrap smoke.
- `docs/DEPLOY_RUNBOOK.md` (NEW): 8 numbered owner-executable steps from `wrangler login` through synthetic-smoke flip.
- `docs/OWNER_CHECKLIST.md` (NEW): Block A deploy 45 min, Block B discovery 90 min parallel, Block C launch 60 min parallel, Block D monitoring ongoing.
- `scripts/post-deploy-smoke.sh` (NEW): 6-check post-deploy smoke (was 7-check with one no-op; iter-2 fix).

**Decisions**:
- Bundle size 40 KiB to 102 KiB gzip after @sentry/cloudflare landed. Acceptable on Bundled plan ($5/mo) ceiling of 10 MiB.
- Integration-layer kill-switch tests deferred: cloudflare:test `env` mutation does not propagate to the worker isolate. Kill switches are exhaustively covered at the unit layer (parser + dispatch + handler). Adding a `wrangler.toml [env.test].vars` setup is the future fix.
- `parseDisabledTools` warning log on all-malformed config deferred to VRT-146b alongside the threat model + telemetry pass. Tracked in DEVLOG so the chain of custody is visible.
- `LogLineFields` discriminated union refactor: kept as a flat shape with `OutcomeKind`. Full discriminated-union would require per-outcome typed `tool` + `upstream_status` + `error` fields; type-design polish, not a coverage gap.
- `/skills` page rewrite in main verity repo NOT pushed directly. Brand Rule prohibits modifying `/`, `/funds`, `/skills`, `/upgrade` without explicit go-ahead. Draft lives in `docs/launch-drafts/skills-page-rewrite.md` for owner review.

**Remaining todos (next session priority)**:
1. [ ] 🚨 Owner: merge PR #6 (request via plain-text "merge 6" when ready).
2. [ ] 🚨 Owner: Block A in `docs/OWNER_CHECKLIST.md`. 45 minutes. `wrangler login` -> Sentry project -> secrets -> preview deploy -> DNS CNAME -> production deploy -> Vercel env flip. Outcome: `mcp.verityskills.com` live.
3. [ ] 🔍 Owner: Block B (Smithery + Cursor Directory + MCP registry submissions; review skills-page-rewrite draft).
4. [ ] ✨ Owner: Block C (approve launch drafts, schedule HN + LinkedIn + X).
5. [ ] VRT-146b: 8-gate prod-readiness bootstrap on sibling repo (deferred per spec until 146a deploys).
6. [ ] VRT-148: marketplace submission package activation once owner submits via paths in `docs/SMITHERY.md` and `docs/CURSOR.md`.

### Handoff for next session
**Current state**: VRT-146a code complete on main at `242158a`. PR #6 open at `292f654` (iter-2; needs CI poll + Bugbot re-verification + plain-text merge auth). Local branch `feat/phase-2-4-docs`. Untracked stash `stash@{0}: watchdog devlog additions` survives on the worktree (safe to drop manually).

**Context files**:
1. `docs/DEVLOG.md` (this file)
2. `docs/OWNER_CHECKLIST.md` (the next 4 hours of owner work)
3. `docs/DEPLOY_RUNBOOK.md` (Block A step-by-step)

**Next 3 steps on resume**:
1. `gh pr checks 6 --json name,state,bucket` and verify Bugbot SUCCESS per-SHA on `292f654` (not stale).
2. If green, request plain-text "merge 6" authorization and admin-squash-merge.
3. After PR #6 merges, the agent's work is done. Owner picks up at `docs/OWNER_CHECKLIST.md` Block A.

**Ask on resume**: PR #6 iter-2 CI state? If green, "merge 6"?

---

## Multi-project status (snapshot 2026-05-14)

| Repo | Last session | Status |
|---|---|---|
| `verity-mcp` (this) | 2026-05-14 Session #17 | VRT-146a code complete; PR #6 docs at iter-2 |
| `gatekeeper-ai` | 2026-05-09 | Play Store screenshots captured + validated |
| `workspace-verity` | 2026-05-05 Session #11 | VRT-109 wave-1 PR-A shipped + cron incident resolved |
| `mission-control` | 2026-03-13 Session #2 | Stale; needs review |
| `gatekeeper-app-testing` | 2026-04-07 | Stale |

**Top priority across all projects**: ship `mcp.verityskills.com` live (Block A owner work). Verity needs to be agent-discoverable before any other distribution lever lights up.

---

---

## Checkpoint — 2026-05-19 (VRT-149f pre-implementation)

**Active task:** Align all 6 verity-mcp Worker tool defs + manifest + manifest schema check + manifest snapshot test to the new upstream contracts merged on cchurctrip/verity origin/main, plus 6 live e2e contract tests.

**Approved spec:** docs/specs/2026-05-19_VRT-149f_worker-contract-alignment.md (owner approval pre-granted, B-full + amendments on verity main, autonomous execution authorized per parent brief).

**Files to be modified:**
- src/upstream.ts (TOOL_ROUTES: coordination-heat -> coordination-score, cross-check-alert -> cross-check-claim, disinfo-alert -> disinfo-monitor)
- src/tools/coordination-heat.ts (requiresAuth false -> true, new path)
- src/tools/cross-check-alert.ts (path -> cross-check-claim, 4-value verdict in description)
- src/tools/disinfo-alert.ts (path -> disinfo-monitor, severity_threshold required)
- src/tools/morning-brief.ts (required ["watchlist"], drop date, pin maxItems to pro tier=50)
- src/tools/verity-score.ts, verity-scan.ts (descriptions accurate; paths unchanged)
- manifest.json (coordination-heat requires_auth true, anonymous_tools [])
- scripts/check-manifest-schema.sh (relax coordination-heat-anon assertion)
- tests/manifest.snapshot.test.ts (required-array snapshot)
- tests/integration.test.ts (happy-path upstreamPath strings; coordination-heat needs auth)
- tests/e2e/live-contract.test.ts (NEW, env-gated skip on VERITY_MCP_TEST_KEY)

**Already done:** spec written, all upstream contracts verified against verity origin/main.

**Next step if resuming:** Start at step 1 (src/upstream.ts TOOL_ROUTES) per spec Plan section.

**Context:** coordination-heat flips to auth-required because the new coordination-score route is Pro/Fund/Trial-gated (verified at app/api/skills/coordination-score/route.ts on verity origin/main). Tool NAME preserved per B-full. The spec appendix "(anonymous allowed)" label is the stale pre-rename leaderboard probe; brief explicitly routes the tool to the new auth-gated subject scorer. check-manifest-schema.sh is CI-blocking and must be relaxed in the same diff for internal coherence.

---

## VRT-210e — add the notification-prefs tool, 2026-06-16

Seventh MCP tool. Forwards to the parent repo's `/api/mcp/notification-prefs` endpoint (shipped + corrected in cchurctrip/verity #431/#432: same `resolveCallerAuth` caller contract the other tools use, so the OAuth path forwards `x-verity-user-id` + `x-worker-shared-secret`). Tool input `{action:'get'|'set', prefs?}` is forwarded byte-identical as the body.

**Files**: `src/tools/notification-prefs.ts` (new) + `src/tools/index.ts` (TOOLS) + `src/upstream.ts` (TOOL_ROUTES) + `manifest.json` (7th entry) + `scripts/check-manifest-schema.sh` (6→7 + index loop) + count/snapshot updates across `tests/{manifest.snapshot,mcp,health,integration,upstream,e2e/live-contract}.test.ts`. No outputSchema (parse-defensively, like coordination-heat). requiresAuth:true (not anonymous).

**Gates**: 419 tests pass, tsc + eslint clean, manifest-schema OK (tools=7), em-dash clean, `wrangler deploy --dry-run --env preview` builds.

**Deploy**: owner runs `npm run deploy` (= `wrangler deploy --env production`, needs Cloudflare creds) AFTER merge to make the tool live at mcp.verityskills.com. WORKER_SHARED_SECRET already configured. Post-deploy smoke: `RUN_LIVE=1 ... vitest tests/e2e/live-contract.test.ts` covers the new tool's get shape.

---

## ⚠️ Context Watchdog Checkpoint — 2026-06-17 11:22 (turn 9353)

**Trigger:** Automatic — context window approaching limit
**Session:** unknown
**Working directory:** /Users/autopilotventures/workspace/verity-mcp

**Status:** HARD — start new session now
**ACTION REQUIRED:** Open a new Claude Code session. Say: "Read DEVLOG and propose plan."

**To resume in a new session:**
1. Open new Claude Code terminal in: `/Users/autopilotventures/workspace/verity-mcp`
2. Say: "Read DEVLOG and propose plan."
3. Claude will restate the last checkpoint and ask for confirmation

**Note:** Check the most recent non-watchdog checkpoint above for the active task spec.

---

## VRT-148 marketplace prep + live-contract rescue - 2026-07-06

**What**: Marketplace submission docs truthed-up; live-contract e2e restored to green after 5+ weeks of silent red.

- Root cause of the never-green nightly: `VERITY_MCP_TEST_KEY` (set once 2026-05-21) hashed to no active verity_users key. Fixed by minting a dedicated fund-tier smoke account (cchurch+mcpe2e@c2mci.com, all email opt-outs on) and rotating the repo secret. Local suite: 22/22.
- `modelcontextprotocol-registry-submission.md` REWRITTEN: the registry dropped the fork-and-PR YAML flow; it is now an instant API publish via `mcp-publisher` CLI + `server.json`. Ready-to-publish `marketplace/server.json` added (remote server, streamable-http /mcp + sse /sse, GitHub-auth namespace io.github.cchurctrip/verity).
- coordination-heat test now accepts the documented `insufficient_data` shape (quiet window, no fabricated zero) alongside the scored shape; e2e project got `testTimeout: 30_000` (LLM-backed calls breach the 5s vitest default).
- Checklist deltas: pricing parity verified, THREAT_MODEL present, /health pinned. Open: support inbox, icon, anonymous tools/list decision (Worker auth-gates it since OAuth; probe 8 of the verity-repo live probe now fails by design change), copy still says six tools (seven live).

**Gates**: 419 workers tests + 22/22 live e2e pass locally; tsc + eslint clean; marketplace files em-dash clean.
