# VRT-166 OAuth 2.1 multi-client verification

**Status**: Cursor PASS (2026-05-27T16:43Z), Claude Code PASS (2026-05-27T22:13Z); Claude Desktop, ChatGPT Desktop, Gemini CLI pending owner smoke.
**Live deploy**: `mcp.verityskills.com`
**Wrangler version ID**: `2a3e962c-84ec-426e-afaf-f93aeb6470d4` (post-#36 `structuredContent` deploy verified live for the Cursor smoke; the Claude Code smoke at 2026-05-27T22:13Z hit the same Worker via OAuth).
**Worker commit (/health)**: returns `commit: "unknown"`; `/health.commit` returns 404. Deploy script does not inject `--var COMMIT_SHA:$(git rev-parse HEAD)`. Wrangler version ID is the source of truth in the meantime. Filed as a follow-up (see bottom).
**Spec**: `cchurctrip/verity` `mydocs/specs/2026-05-22_VRT-166_oauth-21-mcp-server.md`
**Impl PRs**:
- Phase 0 migrations: `cchurctrip/verity` #305 (merged 2026-05-22T15:52Z)
- Phase 0 follow-up (Claude Code loopback callback path): `cchurctrip/verity` #333 (merged 2026-05-27T21:10Z). Adds `http://localhost:0/callback` to the `claude_desktop` row's `redirect_uris` allowlist; the Anthropic Claude Code MCP OAuth client uses `/callback` (no `/oauth/` prefix) which the strict-match validator rejected before this row.
- Phase 1 Worker: `cchurctrip/verity-mcp` #17 (merged 2026-05-25T14:55Z)
- Phase 2 consent UI: `cchurctrip/verity` #309 (merged 2026-05-24T19:37Z)

## Probe matrix (12 / 12 expected pass)

`scripts/multi-client-probe.sh https://mcp.verityskills.com` runs 9 transport probes + 3 OAuth probes. With `VERITY_MCP_TEST_KEY` exported the full 12 run; without it the 9 transport probes skip cleanly and only the 3 OAuth probes assert.

| # | Probe | Surface | Expected | Result |
|---|---|---|---|---|
| 1 | Cursor no Accept header | POST /mcp | application/json | (filled by smoke) |
| 2 | Cursor Accept: */* | POST /mcp | application/json | (filled by smoke) |
| 3 | Cursor Accept: application/json | POST /mcp | application/json | (filled by smoke) |
| 4 | Claude Desktop default Accept | POST /mcp | application/json | (filled by smoke) |
| 5 | ChatGPT Desktop Streamable HTTP | POST /mcp Accept: text/event-stream | text/event-stream + one event: message + close | (filled by smoke) |
| 6 | ChatGPT spec-canonical Accept | POST /mcp | text/event-stream | (filled by smoke) |
| 7 | Gemini Streamable HTTP | POST /mcp | text/event-stream + event: message | (filled by smoke) |
| 8 | Comet GET /sse handshake | GET /sse | text/event-stream + event: endpoint absolute URL | (filled by smoke) |
| 9 | Comet POST /sse fallback | POST /sse | 200 + application/json fallback | (filled by smoke) |
| 10 | OAuth discovery | GET /.well-known/oauth-authorization-server + /.well-known/oauth-protected-resource | RFC 8414 + RFC 9728 JSON; registration_endpoint OMITTED; S256-only; mcp:invoke present | PASS (live as of 2026-05-25T15:33Z) |
| 11 | /oauth/token unknown code | POST /oauth/token | 400 + invalid_grant | PASS (live as of 2026-05-25T15:33Z) |
| 12 | /mcp fake vto_ Bearer | POST /mcp tools/call | 401 + WWW-Authenticate per RFC 6750 | PASS (live as of 2026-05-25T15:33Z) |

## /health snapshot

```json
{
  "status": "ok",
  "commit": "unknown",
  "uptime_s": 0,
  "kill_switch_engaged": false
}
```

The `commit: "unknown"` is a pre-existing minor issue: the deploy command did not inject `--var COMMIT_SHA:$(git rev-parse HEAD)`. The Wrangler version ID (`393bd974`) is the source of truth for which build is live. Follow-up to wire `COMMIT_SHA` into the deploy script.

## OAuth discovery snapshots

`GET /.well-known/oauth-authorization-server`:

```json
{
  "issuer": "https://mcp.verityskills.com",
  "response_types_supported": ["code"],
  "grant_types_supported": ["authorization_code", "refresh_token"],
  "code_challenge_methods_supported": ["S256"],
  "scopes_supported": ["mcp:invoke"],
  "token_endpoint_auth_methods_supported": ["none"],
  "authorization_endpoint": "https://verityskills.com/oauth/mcp/authorize",
  "token_endpoint": "https://mcp.verityskills.com/oauth/token"
}
```

`GET /.well-known/oauth-protected-resource`:

```json
{
  "resource": "https://mcp.verityskills.com",
  "authorization_servers": ["https://mcp.verityskills.com/.well-known/oauth-authorization-server"],
  "bearer_methods_supported": ["header"],
  "resource_documentation": "https://verityskills.com/skills"
}
```

R4 verified: `registration_endpoint` is absent (DCR deferred to v2; clients fall through to manual `client_id` paste).

## Per-client manual smoke (owner fills after running)

For each of the four target clients, run the install per the corresponding `docs/<CLIENT>.md`, then invoke all 6 tools and record the result. Suggested order: Claude Desktop, ChatGPT Desktop, Cursor, Gemini CLI.

### Claude Desktop (1.8500+)

- **Install path tried**: (OAuth UI Connector / vtk_ config snippet / both)
- **client_id used**: `claude_desktop`
- **Consent screen rendered correctly?** (yes / no, with screenshot path if no)
- **Tool list after Connect**: (paste output of `/verity` or list-tools probe)
- **6 tools invoked successfully**:
  - [ ] verity-score on NVDA
  - [ ] morning-brief
  - [ ] coordination-heat on GME
  - [ ] verity-scan
  - [ ] cross-check-alert
  - [ ] disinfo-alert
- **Evidence**: (paste tool response excerpts; screenshot paths)
- **Status**: (PASS / FAIL with description)

### ChatGPT Desktop

- **Install path tried**: OAuth UI Connector (no bearer alternative exists for ChatGPT Desktop)
- **client_id used**: `chatgpt_desktop`
- **Consent screen rendered correctly?** (yes / no)
- **Tool list after Connect**: (paste)
- **6 tools invoked successfully**:
  - [ ] verity-score on NVDA
  - [ ] morning-brief
  - [ ] coordination-heat on GME
  - [ ] verity-scan
  - [ ] cross-check-alert
  - [ ] disinfo-alert
- **Evidence**: (paste)
- **Status**: (PASS / FAIL)

### Cursor

- **Install path tried**: OAuth via `mcp-remote` stdio bridge (`command: npx -y mcp-remote https://mcp.verityskills.com/mcp`). Direct-HTTP mcp.json path remains blocked on the Cursor 1.x V2 FSM URL-normalization + DCR-replay bugs (issue #25 parts 1-7); mcp-remote is the supported install path for Cursor end-users until those FSM bugs ship-fix upstream.
- **client_id used**: `cursor` (dynamically registered via `mcp-remote`)
- **Consent screen rendered correctly?** yes (`https://verityskills.com/oauth/consent`, scope `mcp:invoke`)
- **Tool list after Connect**: 6 tools (coordination-heat, verity-score, morning-brief, verity-scan, cross-check-alert, disinfo-alert) — manifest order matches `manifest.json` and `src/tools/index.ts`.
- **6 tools invoked successfully**:
  - [x] verity-score on NVDA — `{status:"ok", ticker:"NVDA", score:0, breakdown:{...}, asof:"2026-05-27T08:05:45.817Z"}`
  - [x] morning-brief on [NVDA, GME, TSLA] — `{status:"ok", variant:"clean", subject:"Verity morning brief: clean read", tickers:[3 entries], asof:"2026-05-27T16:43:43Z"}`
  - [x] coordination-heat on GME — `{subject:"GME", status:"insufficient_data", signals_found:0, sources_checked:0, window_hours:2}`
  - [x] verity-scan on AAPL — `{status:"ok", tickers_checked:["AAPL"], anomalies:[], clean:["AAPL"], anomaly_count:0, scanned_at:"2026-05-27T16:43:51Z"}`
  - [x] cross-check-alert on "BlackRock filed for a spot Solana ETF on 2026-03-12" — `{verdict:"NO_SIGNAL", confidence:0, sources_checked:0, signals_matched:0}`
  - [x] disinfo-alert on TSLA / severity_threshold=medium — `{subject:"TSLA", severity_threshold:"medium", detected:false, status:"insufficient_data", patterns:[]}`
- **Evidence**: Verified live 2026-05-27T16:43Z against Worker version `2a3e962c-84ec-426e-afaf-f93aeb6470d4` (the [#36](https://github.com/cchurctrip/verity-mcp/pull/36) `structuredContent` deploy). All six tools returned with `result.structuredContent` populated; the three tools that declare `outputSchema` (verity-score, verity-scan, morning-brief per VRT-160) no longer hit the strict-validation `-32600` rejection that was live at 2026-05-27T16:00Z pre-[#36](https://github.com/cchurctrip/verity-mcp/pull/36). End-to-end stack: `[verity#316](https://github.com/cchurctrip/verity/pull/316)` (upstream dual-path caller auth) → [#35](https://github.com/cchurctrip/verity-mcp/pull/35) (Worker forwards `x-worker-shared-secret`) → `verity#329` (`WORKER_SHARED_SECRET` set on Vercel + redeploy) → [#36](https://github.com/cchurctrip/verity-mcp/pull/36) (`structuredContent` on 2xx forwards).
- **Status**: PASS

### Claude Code (CLI, distinct from the Claude Desktop app)

The Anthropic Claude Code CLI registers MCP servers via `~/.claude.json` (or via `claude mcp add`) and uses Claude Code's native `/mcp` slash command for the OAuth lifecycle. Claude Code reuses the `claude_desktop` allowlist row in v1 (no separate `claude_code` `client_id` row; see VRT-166-followup below).

- **Install path tried**: Claude Code native MCP server registration with OAuth flow driven by the `/mcp` slash command (the Claude Code runtime holds its own loopback listener and manages the PKCE + token exchange internally; the in-tool `mcp__verity__authenticate` + `mcp__verity__complete_authentication` tool pair clears state across tool-call turns and is not the supported end-user path for Claude Code).
- **client_id used**: `claude_desktop` (shared row from migration 046; the Claude Code MCP OAuth runtime defaults to this string).
- **Consent screen rendered correctly?** yes (`https://verityskills.com/oauth/mcp/authorize`, scope `mcp:invoke`). Pre-#333 the consent UI returned "Connection blocked. The redirect address sent by the application is not on the allowlist for this client" because the `claude_desktop` row's `redirect_uris` did not yet permit `http://localhost:0/callback`. Post-#333 the consent UI accepted the request, redirected to `localhost:49866/callback?code=...&state=...`, Claude Code's loopback listener caught the code, redeemed the token, and the six tools became invocable inside the same conversation.
- **Tool list after Connect**: 6 tools (verity-score, verity-scan, morning-brief, coordination-heat, cross-check-alert, disinfo-alert) registered via `mcp__verity__*` ToolSearch-loadable handles.
- **6 tools invoked successfully**:
  - [x] verity-score on NVDA - `{status:"ok", ticker:"NVDA", score:0, breakdown:{topicMix:0,coordination:0,sentimentVol:0,predMarketDivergence:0}, explanation:"Verity Score within normal range.", asof:"2026-05-27T08:05:45.817Z"}`
  - [x] morning-brief on [NVDA, GME, TSLA] - `{status:"ok", variant:"clean", subject:"Verity morning brief: clean read", tickers:[3 entries], asof:"2026-05-27T22:13:29.864Z"}`
  - [x] coordination-heat on GME - `{subject:"GME", status:"insufficient_data", signals_found:0, sources_checked:0, window_hours:2}`
  - [x] verity-scan on AAPL - `{status:"ok", tickers_checked:["AAPL"], scan_window_hours:4, anomalies:[], clean:["AAPL"], anomaly_count:0, scanned_at:"2026-05-27T22:13:35.723Z"}`
  - [x] cross-check-alert on "BlackRock filed for a spot Solana ETF on 2026-03-12" - `{verdict:"NO_SIGNAL", confidence:0, sources_checked:0, signals_matched:0, citations:[], source_conflicts:[]}`
  - [x] disinfo-alert on TSLA / severity_threshold=medium - `{subject:"TSLA", severity_threshold:"medium", detected:false, status:"insufficient_data", patterns:[], signals_found:0, sources_checked:0, analyzed_at:"2026-05-27T22:13:40.805Z"}`
- **Evidence**: Verified live 2026-05-27T22:13Z against Worker version `2a3e962c-84ec-426e-afaf-f93aeb6470d4`. End-to-end stack matches Cursor (above) with one delta: Phase 0 follow-up `cchurctrip/verity` #333 (merged 21:10Z) added `http://localhost:0/callback` to the `claude_desktop` row's `redirect_uris` allowlist before the Claude Code OAuth flow could pass the consent UI's strict-match check. The same data-quality observations from the Cursor smoke (`signals_found:0`, `sources_checked:0`, scores at 0) appear here for the same reason (downstream buildouts in progress; not an auth-pipe issue).
- **Status**: PASS

### Gemini CLI

- **Install path tried**: (OAuth via `gemini mcp add --oauth` / vtk_ direct bearer / both)
- **client_id used**: `gemini_cli`
- **Consent screen rendered correctly?** (yes / no)
- **Tool list after Connect**: (paste output of `gemini mcp list`)
- **6 tools invoked successfully**:
  - [ ] verity-score on NVDA
  - [ ] morning-brief
  - [ ] coordination-heat on GME
  - [ ] verity-scan
  - [ ] cross-check-alert
  - [ ] disinfo-alert
- **Evidence**: (paste)
- **Status**: (PASS / FAIL)

## OAuth flow end-to-end pin

A successful smoke against any one client closes the implicit end-to-end invariant:

1. Client opens consent URL with PKCE challenge + resource indicator.
2. Consent UI mints code (10 minute TTL), stores in `mcp_oauth_codes`, redirects with code + state.
3. Client redeems code at `/oauth/token` with PKCE verifier + resource.
4. Worker verifies PKCE, audience binding (`https://mcp.verityskills.com`), single-use; mints access (1 hour) + refresh (30 day) tokens; stores hashed in `mcp_oauth_tokens` + `mcp_oauth_refresh_tokens` with `aud_uri = CANONICAL_RESOURCE_URI` and shared `installation_id`.
5. Client calls `POST /mcp tools/call` with `Authorization: Bearer vto_<...>`. Worker resolves the token, validates `aud_uri == CANONICAL_RESOURCE_URI`, forwards `x-verity-user-id: <user>` (NOT `x-verity-key: vto_*`) to the upstream skill route.
6. Upstream verifies the user has the requested entitlement, runs the skill, returns the response.
7. Worker returns the response to the client.

Token-passthrough ban (parent spec line 387) is verified structurally in `tests/oauth-integration.test.ts:119` via a `disableNetConnect` interceptor that asserts no `vto_*` value appears in any upstream-fetch URL or header.

## Follow-up items (filed if needed)

- Wire `COMMIT_SHA` injection into the deploy script (`--var COMMIT_SHA:$(git rev-parse HEAD)` on `wrangler deploy`). Also wire a `/health.commit` route that returns the same SHA (currently 404). Both are blocking the matrix's "Worker commit" field from being authoritative; falls back to the Wrangler version ID.
- `VRT-166-followup-claude-code-client-id-row`: split `claude_code` out of the shared `claude_desktop` allowlist row into its own `mcp_oauth_clients` row with display name "Claude Code". Cosmetic; the consent screen currently reads "Claude Desktop wants to connect" when the user is in Claude Code. Splitting requires no client-side change (Claude Code's MCP OAuth runtime defaults to `claude_desktop` as the client_id, and overriding it requires a Claude Code config change we do not control end-to-end); blocks only on cleaner audit-log readability, not on functionality.
- `VRT-166-followup-other-clients-callback-path-audit`: confirm the actual loopback paths used by ChatGPT Desktop (no loopback at all per `docs/CHATGPT_DESKTOP.md`; uses `https://chatgpt.com/connector_platform_oauth_redirect`), Cursor (DCR-registered via `mcp-remote`), Gemini CLI (`http://localhost:<port>/oauth/callback` per `docs/GEMINI_CLI.md`). If any client's actual loopback path differs from its allowlist row, the same one-row UPDATE pattern applies. Do not pre-emptively widen the allowlists; verify against the actual client first.
- `VRT-166-followup-schema-migrations-backfill`: parent repo's `supabase_migrations.schema_migrations` table is stale as of 2026-05-14 (top entry `042_persona_inbox_marcus`). Migrations 043 through 050 were applied to prod (verified by reading `mcp_oauth_clients`, `mcp_oauth_codes`, `mcp_oauth_tokens` table state) without being recorded in `schema_migrations`. The Management API curl path used for migration 050 matches the existing pattern; backfill the registration rows so future replay tooling knows what is applied.
- Cleanup cron for long-revoked refresh-token rows (iter-5 of PR #17 switched rotation from hard-delete to soft-revoke; rows accumulate without bound until a cleanup cron lands).
- Lower-priority parent-review-batch findings deferred (see PR #17 iter-5 comment).
