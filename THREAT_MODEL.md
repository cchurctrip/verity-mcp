# verity-mcp Threat Model

**Surface:** Cloudflare Worker bearer-auth proxy at `mcp.verityskills.com`. Translates inbound `Authorization: Bearer vtk_*` (MCP client) into upstream `x-verity-key: vtk_*` (Verity skill routes on `verityskills.com`). Zero database credentials. Zero application state. JSON-RPC 2.0 over HTTPS.

**Methodology:** STRIDE (Spoofing, Tampering, Repudiation, Information disclosure, Denial of service, Elevation of privilege). One row per attack surface. Mitigations point to specific source files or operational controls.

**Last-reviewed:** 2026-05-14

**Review cadence:** quarterly + on any of: bearer-auth code change (`src/auth.ts`, `src/upstream.ts`), upstream rewrite logic change (`rewriteUpgradeUrl`), Sentry scrubber change (`src/observability.ts`), CORS posture change, kill-switch parser change.

---

## Scope

| In scope | Out of scope |
|---|---|
| Bearer extraction + header translation (`src/auth.ts`) | Upstream skill-route logic (lives on `cchurctrip/verity` repo) |
| JSON-RPC envelope handling (`src/mcp.ts`) | API-key issuance / rotation (lives on main repo dashboard) |
| Upstream proxy + dual 402 rewrite (`src/upstream.ts`) | Stripe / billing (lives on main repo) |
| Structured logs + Sentry scrubber (`src/observability.ts`) | Database access (Worker has none) |
| Per-tool + global kill switches (`MCP_TOOLS_DISABLED`, `MCP_KILL_SWITCH`) | Marketplace-side auth (Smithery, Cursor, Claude Desktop manage their own) |
| Cloudflare DNS for `mcp.verityskills.com` | Cloudflare account security (Cloudflare's responsibility) |

---

## STRIDE matrix

### S. Spoofing

| Threat | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Attacker presents a forged `vtk_*` bearer to impersonate a legitimate user. | Low | High | Worker does NOT validate the bearer. It forwards verbatim to `app/api/skills/*` which calls `hashApiKey()` then JOINs `verity_users.api_key_hash`. A forged token fails the hash JOIN upstream, returns 401. Worker preserves the upstream 401 envelope unchanged. |
| Attacker presents a `Bearer ` prefix on a non-`vtk_` token to bypass the Worker's regex. | Low | Medium | `src/auth.ts` `readBearer` returns `{ kind: 'invalid' }` for any value that does not match the strict `/^Bearer (vtk_[A-Za-z0-9]+)(?![\s\S])/` regex (Gate 2 BLOCKING #3). The literal `Bearer ` prefix is required; the token body is `vtk_` followed by one-or-more alphanumerics only (no underscore, no hyphen in the body); the `(?![\s\S])` end-anchor rejects any trailing character including newline / CR / LF. Worker returns 401 with `code: 'INVALID_BEARER_FORMAT'`. No silent downgrade. |
| Attacker calls `coordination-heat` with a forged-looking bearer to claim a higher tier. | Low | Low | `coordination-heat` is anonymous-allowed: when no `Authorization` header is present, the Worker forwards WITHOUT `x-verity-key`. When a header IS present, it gets validated upstream. Forging the bearer just routes the request through the auth'd path which fails upstream. No tier escalation possible at the Worker layer. |

### T. Tampering

| Threat | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Attacker injects a malicious `upgrade_url` into a 402 response body to phish trial-cap users. | Low (requires upstream compromise) | High | Worker rewrites `upgrade_url` to absolute `https://verityskills.com/upgrade...` on every 402 of both shapes. The original upstream `upgrade_url` is never echoed back to the client. Property test `tests/upstream.property.test.ts` verifies idempotency and no-extraneous-keys (Gate 4 target 2 of 3). |
| Attacker crafts a JSON-RPC body with extra fields to smuggle data into upstream. | Low | Medium | `src/mcp.ts` validates JSON-RPC envelope: three method names only (`initialize`, `tools/list`, `tools/call`); strict parameter shape check per method; malformed envelopes return `-32700` parse error or `-32600` invalid request without forwarding upstream; notification-shaped requests (missing `id`) are rejected with `-32600` (notifications are not supported). |
| Attacker mutates `x-verity-key` header in-flight (TLS-strip MITM). | Negligible | High | Cloudflare manages TLS termination. `mcp.verityskills.com` is HTTPS-only (HSTS via custom-domain default). Upstream fetch from Worker to `verityskills.com` also TLS. No plain-text path. |
| Attacker injects `Authorization` value containing newline / CRLF to break header parsing. | Negligible | Medium | `src/auth.ts` regex strictness with `(?![\s\S])` end anchor rejects any input with trailing newline / CR / LF. Codex caught this on PR #404 of `cchurctrip/verity` (see `feedback_js_regex_dollar_end_anchor_newline.md`). Same anchor pattern used here from day 1. |

### R. Repudiation

| Threat | Likelihood | Impact | Mitigation |
|---|---|---|---|
| User claims they never made a request (audit gap). | Low | Low | Structured logs per request with UUIDv7 `request_id` propagated to upstream as `x-request-id`. Cloudflare retains logs 7+ days; Sentry retains exceptions 90 days. Cross-correlation by `request_id` ties Worker logs to upstream logs to upstream Sentry events. |
| Insider attempts to modify Worker logs to hide a bypass. | Negligible | Medium | Cloudflare Worker logs are append-only from the application's perspective (no log-mutation API). Sentry events likewise. Both surfaces require Cloudflare / Sentry account access to alter, not Worker-deployable changes. |

### I. Information disclosure

| Threat | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Bearer token leaks into Sentry breadcrumb / event body. | Medium (without mitigation) | Critical | `src/observability.ts` `scrubAuthorization` recursively walks the event object and replaces any `authorization` / `x-verity-key` field with the literal string `'[redacted]'` (lowercase; case is load-bearing for log grep). WeakSet-based cycle tracking for nested objects. Used as Sentry `beforeSend`. Pure function; unit + property tests in `tests/observability.test.ts`. |
| Bearer token leaks into Cloudflare logs via structured log fields. | Low | Critical | Structured-log builder in `src/observability.ts` accepts a typed `LogLineFields` shape that has NO `authorization` field. The builder emits only `auth_present: boolean`, never the token value. Codified by review on PR #2 (`readBearer` discriminated union refactor). |
| Bearer token leaks into JSON-RPC error body (`error.data`) on internal exception. | Low | Critical | JSON-RPC error envelopes built by `src/mcp.ts` carry only one of three field sets: `{ upstream_status, upstream_body }` (upstream 5xx path), `{ error_name, cause }` (network-error / AbortSignal-timeout path), `{ tool }` (unknown-tool path with `truncateEchoedIdent` applied). None of these fields are sourced from the bearer or `Authorization` header. The bearer never traverses the error-envelope construction path. |
| Verbose error message reveals upstream URL structure to attacker. | Low | Low | Upstream URLs are documented public knowledge (`app/api/skills/<name>`). `mcp.verityskills.com` resolution leaks no additional information. |
| CORS posture leaks Worker presence to attacker probing for MCP servers. | Negligible | Negligible | CORS is permissive by design (`Access-Control-Allow-Origin: *`) per Gate 2 REQUIRED #6. MCP clients across the open web need this. The Worker is intended to be publicly discoverable. |

### D. Denial of service

| Threat | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Single malicious client floods the Worker to exhaust upstream capacity. | Medium | High | Cloudflare Workers free-tier rate limit (100k req/day on Bundled plan baseline). Upstream `app/api/skills/*` enforces per-key rate limit via `lib/apiKeyAuth.ts` + `lib/rateLimitMcp.ts`. Worker is a pass-through; rate limit decisions land upstream and propagate as 429 envelopes. |
| Slowloris-style request keeping the Worker busy on one isolate. | Low | Medium | `wrangler.toml [limits].cpu_ms = 50` caps per-request CPU. `fetch` to upstream uses `AbortSignal.timeout(30_000)` (`src/upstream.ts`) for a 30s wall-clock cap. Cloudflare automatically scales isolates horizontally. |
| Per-tool kill-switch attacker abuse: legitimate tool disabled, others available. | Negligible | Low | `MCP_TOOLS_DISABLED` is operator-controlled via Wrangler secret. Not user-controllable. Kill switches are mitigation, not attack surface. |
| Global kill switch flipped by compromised Cloudflare account. | Negligible | High | Cloudflare account is owner-controlled with 2FA mandatory. Mitigated by Cloudflare's own access controls, not the Worker. |
| Upstream goes down; Worker returns garbled responses. | Medium | Medium | `src/upstream.ts` handles upstream 5xx + network errors + AbortError (timeout) + non-Error throws. All map to JSON-RPC error envelopes with `error.data.upstream_status`. No partial / garbled responses. |

### E. Elevation of privilege

| Threat | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Anonymous user escalates to authenticated tier via coordination-heat path. | Negligible | Low | Coordination-heat is anonymous-allowed by design (preserves VRT-098 policy). It is the ONLY tool that does not require a bearer. Other tools route through the auth'd path. No cross-tool privilege bleed. |
| Trial-tier user escalates to Fund-tier via paid-tier-gating bypass. | Low | High | Tier gating happens upstream on `app/api/skills/*` via `lib/apiKeyAuth.ts` → `getEffectiveLimits()` → upstream 402 with `TRIAL_CAP_REACHED`. Worker forwards the 402 verbatim with `upgrade_url` injected. No tier authority at the Worker layer. Worker cannot be tricked into granting paid access. |
| Worker-level role-gate bypass (the `feedback_role_gate_required_after_bearer_to_validate.md` scar). | N/A | N/A | The Worker has zero role concept. There is no `validateAdminAuth` analog in `src/`. The scar tissue from PR audit on `cchurctrip/verity` does not apply here because the Worker does not differentiate roles. If a future change introduces role differentiation, re-review this row. |

---

## Operational controls

- **Kill switches** (Gate 8): `MCP_KILL_SWITCH=on` returns 503 for all tools (any value other than the literal string `on` is treated as off, so a misfire with `true` / `1` / `yes` is a no-op); `MCP_TOOLS_DISABLED=verity-score,morning-brief` returns 503 for listed tools only. Both are Wrangler secrets, hot-toggleable without redeploy.
- **Synthetic smoke** (Gate 5): `cchurctrip/verity:app/api/cron/mcp-synthetic-smoke/route.ts` pings `/health` every 5 minutes. Behind `MCP_HEALTH_EXPECTED` env flag (default false; flipped true post DNS propagation).
- **Property-based tests** (Gate 4): 3 targets in `tests/*.property.test.ts`: bearer regex (auth), upgrade_url rewrite (upstream), JSON-RPC envelope validator (mcp).
- **CI** (Gate 1 + 2): SAST (Semgrep + CodeQL), OSV-Scanner on dep PRs, Renovate weekly bumps, Dependabot security-only.
- **Sentry scrubber** (information disclosure mitigation): `scrubAuthorization` `beforeSend` hook with WeakSet cycle tracking + recursive structural walk.

## Out-of-band incident response

1. Suspected bearer leak: rotate the user's API key via main-repo dashboard (`app/dashboard/api-keys`). Worker has no in-memory state; the next request from the leaked key fails upstream hash JOIN.
2. Suspected Worker compromise: flip the kill switch via `echo "on" | wrangler secret put MCP_KILL_SWITCH --env production`. The value must be the literal string `on`. All tool calls return 503 immediately.
3. Suspected upstream skill-route compromise: out of scope here; see `cchurctrip/verity:THREAT_MODEL.md` (separate doc).
4. Suspected Cloudflare account compromise: owner action per Cloudflare's account recovery process. Worker can be redeployed from `cchurctrip/verity-mcp` source.

## References

- `~/.claude/PIPELINE.md` Gate 7 STRIDE requirement
- Gate 2 cold-context review: `cchurctrip/verity:docs/arch-review-vrt-146-mcp-worker.md` BLOCKING #2, BLOCKING #3, REQUIRED #6, REQUIRED #7, REQUIRED #8, REQUIRED #11
- Scar-tissue memories: `feedback_role_gate_required_after_bearer_to_validate.md`, `feedback_js_regex_dollar_end_anchor_newline.md`, `feedback_rate_limiter_retry_after_unix_timestamp_class.md`
