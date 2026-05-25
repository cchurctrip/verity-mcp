# Spec: VRT-166 Phase 1 OAuth 2.1 on the verity-mcp Worker

**Date**: 2026-05-22
**Depth**: fast (Phase 1 is one slice of the parent VRT-166 epic)
**Parent spec**: cchurctrip/verity:mydocs/specs/2026-05-22_VRT-166_oauth-21-mcp-server.md (Gate-2 approved)
**Arch review**: cchurctrip/verity:docs/arch-review-vrt-166-oauth.md (APPROVE-WITH-REDIRECTS, R1 to R8)
**Phase 0 (already shipped to prod)**: migrations 046 / 047 / 048 in cchurctrip/verity. Tables `mcp_oauth_clients`, `mcp_oauth_codes`, `mcp_oauth_tokens`, `mcp_oauth_refresh_tokens` are live; four pre-registered clients are seeded.
**Branch**: feat/vrt-166-phase1-oauth-worker (off origin/main 8d95f19)
**Approval**: covered by parent Gate-2; this sub-spec exists to keep the implementation honest.

## Goal

Add OAuth 2.1 + PKCE resource-server and authorization-server-token surface to the verity-mcp Worker. Existing `vtk_*` user-API-key path is unchanged. Worker becomes RFC-9728 spec-compliant so MCP clients (Claude Desktop, ChatGPT Desktop, Cursor, Gemini CLI) can discover OAuth metadata and obtain audience-bound access tokens for `mcp.verityskills.com`.

## In scope

1. **Discovery endpoints** (Worker, public, no auth).
   - `GET /.well-known/oauth-authorization-server` per RFC 8414. Lists `authorization_endpoint` at `https://verityskills.com/oauth/mcp/authorize` (Phase 2 page), `token_endpoint` at `https://mcp.verityskills.com/oauth/token`, `code_challenge_methods_supported: ["S256"]`, `response_types_supported: ["code"]`, `grant_types_supported: ["authorization_code", "refresh_token"]`, `scopes_supported: ["mcp:invoke"]`. `registration_endpoint` is OMITTED per arch review R4 (no DCR in v1).
   - `GET /.well-known/oauth-protected-resource` per RFC 9728. `resource: "https://mcp.verityskills.com"`, `authorization_servers: ["https://mcp.verityskills.com/.well-known/oauth-authorization-server"]`, `bearer_methods_supported: ["header"]`.
   - When `MCP_OAUTH_KILL_SWITCH` is set, both endpoints omit OAuth-specific fields (`authorization_endpoint`, `token_endpoint`) so clients fail-fast and fall back to the bearer path.

2. **`POST /oauth/token`** endpoint on the Worker.
   - Accepts form-urlencoded body per RFC 6749 §3.2 (also tolerates `application/json` for resilience).
   - `grant_type=authorization_code`: validates `code` (SHA-256 lookup in `mcp_oauth_codes`), single-use, not expired, PKCE S256(`code_verifier`) equals stored `code_challenge`, `redirect_uri` matches stored value exactly, `resource` equals stored `resource_uri`, `client_id` matches. Mints `vto_<random>` access token (1h) + opaque refresh token (30d), both stored hashed. Stamps `used_at` on the code. Carries `aud_uri` from the stored `resource_uri`, plus `installation_id`, `scope`, `user_id`, `client_id` onto the issued rows.
   - `grant_type=refresh_token`: validates refresh hash row, not revoked, not expired, audience matches canonical. Rotates: mints new pair sharing `installation_id`; hard-deletes the redeemed refresh row. If a previously-redeemed refresh is presented (hash present nowhere, but a token from the same family is live), the family-revocation path runs (RFC 6819 §5.2.2.3): all rows sharing `installation_id` are revoked.
   - Code-replay defense in depth: if `used_at` is already set on a `mcp_oauth_codes` row that the request matches, revoke every token whose `installation_id` equals the code's `installation_id`, then return `invalid_grant`.
   - Rejects non-empty `client_secret` with `invalid_client` (we are not a confidential-client server; spec arch review Q4).
   - Per-IP + per-code rate limit: 11 rapid requests on a single `code` trigger 429 on request 11 (the first 10 cover authorization-code single-use plus 9 PKCE-mismatch retries which is already pathological). Implemented via a fixed-window counter in a Cloudflare KV namespace or, when KV is absent, an in-isolate map (sufficient for the per-code test surface and acceptable single-isolate hot-path defense).
   - When `MCP_OAUTH_KILL_SWITCH` is set: returns 503 with `Retry-After: 60`.
   - Response shape per RFC 6749 §5.1: `{ access_token, token_type: "Bearer", expires_in, refresh_token, scope }`.

3. **`src/auth.ts` `vto_` discriminator branch** (arch review R7).
   - Add a second regex `^Bearer (vto_[A-Za-z0-9]+)(?![\s\S])`. Two regexes, two distinct prefixes, no substring overlap. Property test asserts no string matches both regexes (1000 random alphanumeric inputs).
   - New `BearerResult` variant `valid_oauth_token` carrying the raw token; existing `valid` renamed to `valid_user_key` per arch review R7 (for callers that already switch on `kind`). To preserve backward compatibility with existing code paths and tests, KEEP `valid` as the variant name for the `vtk_*` branch and ADD `valid_oauth_token` for the `vto_*` branch. The aliasing approach minimizes diff churn and is acceptable per arch review R7 which only mandates discriminator distinctness, not the variant label.
   - Decided: keep `valid` as the user-key variant label (minimal diff, no caller churn). Add `valid_oauth_token` for the new path.

4. **`vto_*` resource-server validation path** (on `tools/call` proxy, R1 audience-binding).
   - SHA-256 the raw token, look up `mcp_oauth_tokens` via Supabase service role (HTTP PostgREST), confirm `expires_at > now()`, confirm `aud_uri == "https://mcp.verityskills.com"` (canonical: no path, no trailing slash, lowercase, no fragment). Mismatch returns 401 with `code: "INVALID_TOKEN_AUDIENCE"` and a `WWW-Authenticate` header pointing at the resource-metadata URL.
   - Token-passthrough ban (parent spec line 387, MCP 2025-06-18 MUST): forward to upstream with `x-verity-user-id: <uuid>` header. NEVER `x-verity-key: vto_*`. Property test: a captured fetch interceptor sees no `vto_*` value in any upstream URL or header.
   - Existing `vtk_*` user-key path stays unchanged (passes the raw token as `x-verity-key`; upstream `hashApiKey()` resolves to user).

5. **`WWW-Authenticate` on every 401** path emitted by the Worker. Value: `Bearer realm="mcp.verityskills.com", resource_metadata="https://mcp.verityskills.com/.well-known/oauth-protected-resource"`. Adds to: `/sse` GET bearer-invalid 401, `proxyToolCall` bearer-invalid 401, OAuth-token audience-mismatch 401, `oauth_token_invalid` 401 (unknown/expired token).

6. **`src/observability.ts` Sentry scrub extension** (parent spec line 425 STRIDE Info-disclosure row 2). Extend `scrubAuthorization` to:
   - Recognize the `vto_*` token-value pattern in any string field and replace with `[redacted]`.
   - Add body-key names `code`, `refresh_token`, `access_token`, `code_verifier`, `client_secret` to the redacted-name set.

7. **`MCP_OAUTH_KILL_SWITCH` Wrangler secret**. Documented in `wrangler.toml` `[vars]` placeholder. When set to the literal `on`, discovery doc omits OAuth endpoints and `/oauth/token` returns 503. `vtk_*` path keeps working. Parent `MCP_KILL_SWITCH` still takes precedence (when global kill is on, everything returns 503 except `/health`).

8. **`THREAT_MODEL.md`** gets a new top-level section "OAuth 2.1 Authorization Surface" with the STRIDE rows from `arch-review-vrt-166-oauth.md` (6+ rows minimum). Highlights: token-passthrough is E (Elevation of privilege) and MUST be tested with a fetch interceptor; redirect-URI exact-match special-cases `http://localhost:*` for installed-app clients per RFC 8252 §7.3 (Phase 2 owns the validator; Phase 1 documents the boundary); Sentry scrub extension.

9. **Supabase service-role HTTP client** (new tiny helper, no SDK dependency).
   - PostgREST HTTP calls with `apikey` + `Authorization: Bearer <service-role-JWT>` headers, hitting `https://${SUPABASE_PROJECT_REF}.supabase.co/rest/v1/...`.
   - Env: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (both Wrangler secrets). Both required for OAuth paths. Absence at request time on an OAuth endpoint returns `oauth_misconfigured` 503 (operational signal, never silent).
   - `vtk_*` path is unaffected (no Supabase access needed; existing forward-without-validation contract preserved).

10. **Tests** (per parent spec + R8).
    - Unit: PKCE S256 verifier rejects mismatches (property test, fast-check).
    - Unit: `vtk_*` and `vto_*` regex mutually exclusive on 1000 random alphanumeric inputs.
    - Unit: canonical-audience matcher (in this Worker; lib/oauthMcp.ts comparator lives in Phase 2).
    - Unit: `vto_*` token-format rejected at parse layer (length, charset).
    - Integration: discovery endpoints return RFC-conformant JSON; with kill switch on, omit OAuth endpoints.
    - Integration: `/oauth/token` happy path mints access + refresh tokens with right `aud_uri` and `installation_id`.
    - Integration: authorization-code single-use (redeem twice -> second `invalid_grant` + first-issued tokens revoked).
    - Integration: refresh-token rotation (redeem A -> mints B + hard-deletes A; redeem A again -> revokes family).
    - Integration: audience-claim mismatch returns 401 with `INVALID_TOKEN_AUDIENCE` (property test on 100 random non-canonical aud_uri values).
    - Integration: `/oauth/token` rate limit (11 rapid requests on a single code -> 11th gets 429).
    - Integration: token passthrough regression (capture fetch headers, assert no `vto_*` value appears in any upstream URL or header).
    - Integration: `MCP_OAUTH_KILL_SWITCH` set -> `/oauth/token` returns 503; discovery omits OAuth endpoints; `vtk_*` path still works.

## Explicitly NOT in scope

- Phase 2 consent UI on Next.js (separate worktree).
- Phase 0 migrations (already shipped).
- Dynamic client registration (deferred to v2 follow-up).
- WebSocket transport, token introspection, federated sign-in.
- Code-row TTL sweep cron (deferred Phase 1+ follow-up).

## Risks

1. **Supabase secret bootstrapping** . Wrangler secrets `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` must be set by the owner via `wrangler secret put` AFTER merge but BEFORE the OAuth surface is announced. The discovery endpoint returns spec-compliant JSON even without the secrets; only `/oauth/token` and `vto_*` validation fail with `oauth_misconfigured` 503. Documented in DEPLOY_RUNBOOK.md tweak.

2. **PostgREST RLS posture** . tables are RLS-on with NO permissive policy. Service-role bypasses RLS (Supabase default). Confirmed in Phase 0 migration comments.

3. **Audience canonical form** . case + path + trailing-slash + fragment normalization. Spec defines canonical as `https://mcp.verityskills.com` (lowercase, no path, no trailing slash, no fragment). The comparator strips these before equality test.

4. **`vto_*` regex** . must not be a substring of `vtk_*`. Different third character (`o` vs `k`) gives clean prefix separation. Property test asserts mutual exclusivity.

5. **Rate-limit storage** . in-isolate map gives per-isolate scoping which is weaker than a global counter. Acceptable for v1 since the attack model is rapid retries on a single code; Cloudflare's isolate-affinity for a single client IP is high enough to make this a real defense. Follow-up: move to KV when traffic justifies the latency cost.

## Validation

- `npm run lint` + `npm run typecheck` + `npm test` all green.
- `npm run check-manifest` green (manifest gains no new fields in this phase; advertising auth via discovery doc only).
- Em-dash scan: `grep -cP '\x{2014}|\x{2013}|\x{2015}|\x{2212}'` returns 0 on every authored file.
- 6-agent pr-review-toolkit batch on the PR (parent orchestrates after I return).
- Bugbot per-SHA verification.
- Iterate-until-green CI loop per global rule (cap 3).

## Implementation order

1. Spec (this file).
2. Helpers: `src/crypto.ts` (PKCE S256 verifier, token hash, random token), `src/oauth-canonical.ts` (audience canonical form), `src/oauth-rate-limit.ts` (per-code fixed-window).
3. `src/supabase.ts` (tiny PostgREST HTTP helper, service-role only).
4. `src/oauth-store.ts` (typed accessors for the four tables).
5. `src/oauth-discovery.ts` (two discovery endpoint builders).
6. `src/oauth-token.ts` (the `/oauth/token` handler).
7. `src/auth.ts` extension (vto_ branch).
8. `src/observability.ts` extension (scrub extension).
9. Wire all into `src/index.ts` (routes + WWW-Authenticate helper).
10. `src/upstream.ts` extension (resolved user_id forwarding via `x-verity-user-id`).
11. `THREAT_MODEL.md` STRIDE rows.
12. `wrangler.toml` env doc.
13. Tests last (unit + property + integration).
14. Lint/typecheck/test; iterate locally until green.
15. Commit in logical chunks; push; open PR; iterate CI.

## Change log

- 2026-05-22 (initial draft): sub-spec drafted from parent spec + arch review redirects R1-R8.
