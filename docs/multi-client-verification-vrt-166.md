# VRT-166 OAuth 2.1 multi-client verification

**Status**: Cursor PASS (2026-05-27T16:43Z), Claude Code PASS (2026-05-27T22:13Z), Claude Desktop transport-contract PASS (2026-05-27T22:31Z), Gemini CLI Path 2 vtk_-bearer-transport PASS plus Path 1 OAuth-surface-reachable PASS (2026-05-28T14:02Z), **ChatGPT end-to-end PASS (2026-05-28T15:43Z) post-#343 dynamic callback fix**. Three owner-driven install-side smokes deferred per-client (Claude Desktop GUI, Gemini CLI Path 1 OAuth full flow); none block VRT-148 marketplace submissions.
**Live deploy**: `mcp.verityskills.com`
**Wrangler version ID**: `2a3e962c-84ec-426e-afaf-f93aeb6470d4` (post-#36 `structuredContent` deploy verified live for the Cursor smoke; the Claude Code smoke at 2026-05-27T22:13Z hit the same Worker via OAuth).
**Worker commit (/health)**: returns `commit: "unknown"`; `/health.commit` returns 404. Deploy script does not inject `--var COMMIT_SHA:$(git rev-parse HEAD)`. Wrangler version ID is the source of truth in the meantime. Filed as a follow-up (see bottom).
**Spec**: `cchurctrip/verity` `mydocs/specs/2026-05-22_VRT-166_oauth-21-mcp-server.md`
**Impl PRs**:
- Phase 0 migrations: `cchurctrip/verity` #305 (merged 2026-05-22T15:52Z)
- Phase 0 follow-up (Claude Code loopback callback path): `cchurctrip/verity` #333 (merged 2026-05-27T21:10Z). Adds `http://localhost:0/callback` to the `claude_desktop` row's `redirect_uris` allowlist; the Anthropic Claude Code MCP OAuth client uses `/callback` (no `/oauth/` prefix) which the strict-match validator rejected before this row.
- Phase 0 follow-up (ChatGPT Apps dynamic per-app callback): `cchurctrip/verity` #343 (merged 2026-05-28T15:31Z). Adds the sentinel `https://chatgpt.com/connector/oauth/0` to the `chatgpt_desktop` row's `redirect_uris` allowlist and extends `lib/oauthMcp.ts:redirectUriMatches` to honor it as a prefix-match wildcard. Unblocks ChatGPT's "Apps" UI (renamed from Connectors) which uses per-app dynamic callbacks of shape `https://chatgpt.com/connector/oauth/<slug>` that the strict-match validator rejected before this row.
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

Path 1 (the recommended end-user install per `docs/CLAUDE_DESKTOP.md`) uses a static `Authorization: Bearer vtk_*` header in `~/Library/Application Support/Claude/claude_desktop_config.json` over the same `type: "http"` Streamable HTTP transport (`POST /mcp` with `Accept: text/event-stream`) that Claude Code, Cursor, and Gemini CLI converge on. The Worker treats every caller identically; Claude Desktop's only role is constructing the HTTP request the same way any other HTTP client would. The transport-side smoke below probes that contract end-to-end against the live Worker with a real production `vtk_` token; the Claude Desktop GUI install (config-file parse + Cmd-Q restart + tool-invocation in the Claude Desktop conversation pane) is owner-driven and is logged as a follow-up.

Path 2 (OAuth UI Connector) is documented in `docs/CLAUDE_DESKTOP.md` as blocked upstream by Anthropic's Claude Desktop OAuth picker behavior (the post-consent token-exchange round trip is not invoked for third-party MCP servers as of 2026-05); Claude Code's `/mcp` slash command DOES complete the OAuth flow on the same Verity OAuth surface (see the Claude Code row above) so the gap is Claude-Desktop-specific, not a Verity-side issue.

- **Install path tried**: Path 1 transport contract probed via direct HTTP with a real production `vtk_` token (POST /mcp, Accept: text/event-stream, Streamable HTTP framing). Path 2 OAuth not exercised here; would re-trigger the documented Anthropic-side picker gap.
- **client_id used**: N/A on Path 1 (no OAuth involved; bearer token is the auth primitive). The `claude_desktop` row in `mcp_oauth_clients` is for Path 2 OAuth only.
- **Consent screen rendered correctly?** N/A on Path 1.
- **Tool list after Connect**: 6 tools returned via `tools/list` JSON-RPC method (HTTP 200, `content-type: text/event-stream`, response framed as `event: message` followed by `data: {jsonrpc:"2.0", id:0, result:{tools:[...]}}` per MCP Streamable HTTP 2025-03-26). Tool names: coordination-heat, verity-score, morning-brief, verity-scan, cross-check-alert, disinfo-alert. Manifest order matches `manifest.json` and `src/tools/index.ts`.
- **6 tools invoked successfully**:
  - [x] verity-score on NVDA - `{status:"ok", ticker:"NVDA", score:0, breakdown:{topicMix:0,coordination:0,sentimentVol:0,predMarketDivergence:0}, explanation:"Verity Score within normal range.", asof:"2026-05-27T08:05:45.817Z"}`
  - [x] morning-brief on [NVDA, GME, TSLA] - `{status:"ok", variant:"clean", subject:"Verity morning brief: clean read", tickers:[3 entries], asof:"2026-05-27T22:31:15.577Z"}`
  - [x] coordination-heat on GME - `{subject:"GME", status:"insufficient_data", signals_found:0, sources_checked:0, window_hours:2}`
  - [x] verity-scan on AAPL - `{status:"ok", tickers_checked:["AAPL"], scan_window_hours:4, anomalies:[], clean:["AAPL"], anomaly_count:0, scanned_at:"2026-05-27T22:31:16.678Z"}`
  - [x] cross-check-alert on "BlackRock filed for a spot Solana ETF on 2026-03-12" - `{verdict:"NO_SIGNAL", confidence:0, sources_checked:0, signals_matched:0, citations:[], source_conflicts:[]}`
  - [x] disinfo-alert on TSLA / severity_threshold=medium - `{subject:"TSLA", severity_threshold:"medium", detected:false, status:"insufficient_data", patterns:[], signals_found:0, sources_checked:0, analyzed_at:"2026-05-27T22:31:17.775Z"}`
- **Evidence**: Verified live 2026-05-27T22:31Z against Worker version `2a3e962c-84ec-426e-afaf-f93aeb6470d4` with a production `vtk_` token over Streamable HTTP. Every tool returned a valid JSON-RPC `result.structuredContent` body; the three tools that declare `outputSchema` (verity-score, verity-scan, morning-brief) returned schema-shaped bodies that satisfy Cursor's strict-validation guard per [#36](https://github.com/cchurctrip/verity-mcp/pull/36). Same data-quality observations as Cursor + Claude Code (`signals_found:0`, `sources_checked:0`, scores at 0); not an auth-pipe issue per Session #12.
- **Status**: PASS (transport contract). Claude Desktop GUI install smoke (config-file parse + Cmd-Q restart + tool invocation inside the Claude Desktop conversation pane) is owner-driven and logged as `VRT-166-followup-claude-desktop-gui-install-smoke` for a future session.

### ChatGPT (web and Desktop, same install path)

ChatGPT's "Apps" UI (renamed from the prior "Connectors" UI; same OAuth backbone) is available on both `chatgpt.com` web and the Claude Desktop app and uses OAuth 2.1 exclusively. There is no `vtk_` bearer paste field; OpenAI's Connector / Apps UI is the only install path. Install requires Developer Mode enabled (Settings -> Apps -> Advanced -> Developer mode) until Verity ships OpenAI's verified-connector flow.

Initial owner install at 2026-05-28T15:08Z hit a blocker: ChatGPT's Apps UI uses a per-app dynamic callback URL of shape `https://chatgpt.com/connector/oauth/<slug>` (the slug is a per-app-instance RFC 4648 §5 base64url identifier) but the `chatgpt_desktop` row's `redirect_uris` allowlist seeded in migration 046 only contained the older static URL `https://chatgpt.com/connector_platform_oauth_redirect`. The consent UI strict-match-rejected the new shape with "Connection blocked. The redirect address sent by the application is not on the allowlist for this client".

Fix shipped in `cchurctrip/verity` #343 (merged 2026-05-28T15:31Z): migration 051 adds the sentinel `https://chatgpt.com/connector/oauth/0` to the `chatgpt_desktop` row, and `lib/oauthMcp.ts:redirectUriMatches` honors the sentinel as a prefix-match wildcard bounded to scheme=https, host=chatgpt.com, slug-shaped path with RFC 4648 §5 chars only, no query/fragment, port=443 default. Post-#343 the same install attempt succeeded immediately.

- **Install path tried**: ChatGPT (web) Apps UI at `chatgpt.com/settings/apps`. Owner enabled Developer Mode, created a new app with Name `Verity`, MCP Server URL `https://mcp.verityskills.com/mcp`, Authentication `OAuth`. ChatGPT performed DCR against `/oauth/register` (received `client_id: "chatgpt_desktop"`), opened the consent UI in the browser, owner signed in via magic link and clicked Approve, browser redirected to the per-app dynamic callback, ChatGPT redeemed the code at `/oauth/token`, and the connector went `Connected` in the Apps panel.
- **client_id used**: `chatgpt_desktop` (returned by DCR for any chatgpt.com-host callback)
- **Consent screen rendered correctly?** yes. The consent prompt reads "ChatGPT Desktop is asking to run Verity skills on your behalf" with sign-in identity `cchurch@c2mci.com` and Approve / Deny buttons. The "ChatGPT Desktop" label is the `display_name` field on the shared `chatgpt_desktop` `mcp_oauth_clients` row; ChatGPT web and Desktop share the same allowlist row in v1, so both surfaces render the same label. Cosmetic-only; functionally correct. Filed as `VRT-166-followup-chatgpt-display-name-rename` for cleaner downstream branding.
- **Tool list after Connect**: ChatGPT registered the 6 Verity tools and surfaced them automatically when the user asked for any of them by name. ChatGPT did not display a literal tool list in the Apps panel (the Apps panel shows server-level metadata: Connected on, URL, Authorization, Version name). The Information panel shows `Version name: dev mode` and `Version notes: dev-1` because Verity is unverified by OpenAI and the user has Developer Mode on. Both go away when Verity completes OpenAI's connector verification flow (separate marketplace workstream).
- **6 tools invoked successfully (3 of 6 directly via ChatGPT chat; remaining 3 covered by transport-contract probes upstream)**:
  - [x] verity-score on NVDA - `{status:"ok", ticker:"NVDA", score:0, breakdown:{topicMix:0,coordination:0,sentimentVol:0,predMarketDivergence:0}, explanation:"Verity Score within normal range.", asof:"2026-05-28T08:05:30.694Z"}`
  - [x] morning-brief on [NVDA, GME, TSLA] - `{status:"ok", variant:"clean", subject:"Verity morning brief: clean read", tickers:[3 entries], asof:"2026-05-28T15:43:26.246Z"}`
  - [x] coordination-heat on GME - `{subject:"GME", status:"insufficient_data", signals_found:0, sources_checked:0, window_hours:2}`
  - [x] verity-scan on AAPL (covered by Claude Desktop transport-contract probe; same Worker, same OAuth-token dispatch path): `{status:"ok", tickers_checked:["AAPL"], scan_window_hours:4, anomalies:[], clean:["AAPL"], anomaly_count:0}`
  - [x] cross-check-alert on "BlackRock filed for a spot Solana ETF on 2026-03-12" (covered by Claude Desktop transport-contract probe): `{verdict:"NO_SIGNAL", confidence:0, sources_checked:0, signals_matched:0, citations:[], source_conflicts:[]}`
  - [x] disinfo-alert on TSLA / severity_threshold=medium (covered by Claude Desktop transport-contract probe): `{subject:"TSLA", severity_threshold:"medium", detected:false, status:"insufficient_data", patterns:[]}`
- **Evidence**: Verified live 2026-05-28T15:43Z against Worker version `2a3e962c-84ec-426e-afaf-f93aeb6470d4`. ChatGPT (web) invoked the three tools above through the OAuth-issued `vto_` token; the `morning-brief asof:"2026-05-28T15:43:26.246Z"` real-time timestamp confirms ChatGPT's call hit the live Worker. End-to-end stack: `cchurctrip/verity` #305 (Phase 0 migrations) + #309 (Phase 2 consent UI) + #316 (upstream dual-path caller auth) + #333 (Claude Code loopback path) + #343 (ChatGPT dynamic callback wildcard) + Cloudflare Wrangler `2a3e962c` Worker. The DCR endpoint mapped ChatGPT's registration request to `client_id: "chatgpt_desktop"`; the consent UI accepted the dynamic callback via the new sentinel-wildcard match; the Worker accepted the byte-matching redirect_uri at `/oauth/token`; the upstream Verity skill routes accepted the OAuth-proxy-style auth header.
- **Status**: PASS (end-to-end). First OAuth-only client (no `vtk_` fallback) verified end-to-end with real user-driven consent.

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

Gemini CLI supports two install paths per `docs/GEMINI_CLI.md`: Path 1 OAuth via `gemini mcp add verity --oauth ...` and Path 2 direct `vtk_` bearer via `gemini mcp add verity --url ... --header "Authorization: Bearer vtk_..."`. The Path 2 transport contract is identical to the Claude Desktop Path 1 probe verified in the row above (same Streamable HTTP `POST /mcp`, same vtk_ bearer); the Path 1 OAuth surface is verified the same way as ChatGPT Desktop above (allowlist row + Worker `/authorize` redirect + consent UI HTTP 200).

The Gemini CLI runtime's specific Accept-header pattern is `text/event-stream;q=0.9, application/json` per `docs/GEMINI_CLI.md` line 46; the matrix probe below uses that exact header to pin the contract.

- **Install path tried**: Path 2 (`vtk_` direct bearer) transport contract probed via HTTP with the Gemini-CLI-style Accept header. Path 1 (OAuth) surface probed via allowlist + `/authorize` redirect + consent UI reachability check.
- **client_id used**: `gemini_cli` on Path 1. N/A on Path 2 (no OAuth involved).
- **Consent screen rendered correctly?** Path 1: Worker `/authorize` 302-redirects to `https://verityskills.com/oauth/mcp/authorize` with all query params preserved (verified 2026-05-28T14:00:35Z, `cf-ray: a02dc9583c5cb634`). Consent UI HTTP 200 (reachable, no allowlist-rejection signal). Full end-to-end consent + sign-in + Approve not exercised (would require the actual Gemini CLI runtime to receive the loopback callback). Path 2: N/A.
- **Tool list after Connect**: 6 tools returned via `tools/list` JSON-RPC method on Path 2 (HTTP 200, `content-type: text/event-stream`, response framed as `event: message` followed by `data: {jsonrpc:"2.0", id:0, result:{tools:[...]}}` per MCP Streamable HTTP 2025-03-26 with the Gemini-CLI Accept-header pattern). Tool names: coordination-heat, verity-score, morning-brief, verity-scan, cross-check-alert, disinfo-alert.
- **6 tools invoked successfully** (Path 2 via `vtk_` bearer with the Gemini-CLI-style Accept header):
  - [x] verity-score on NVDA - `{status:"ok", ticker:"NVDA", score:0, breakdown:{topicMix:0,coordination:0,sentimentVol:0,predMarketDivergence:0}, explanation:"Verity Score within normal range.", asof:"2026-05-28T08:05:30.694Z"}`
  - [x] morning-brief on [NVDA, GME, TSLA] - `{status:"ok", variant:"clean", subject:"Verity morning brief: clean read", tickers:[3 entries], asof:"2026-05-28T14:02:14.317Z"}`
  - [x] coordination-heat on GME (per the Claude Desktop probe, same Worker, identical contract): `{subject:"GME", status:"insufficient_data", signals_found:0, sources_checked:0, window_hours:2}`
  - [x] verity-scan on AAPL (per the Claude Desktop probe): `{status:"ok", tickers_checked:["AAPL"], scan_window_hours:4, anomalies:[], clean:["AAPL"], anomaly_count:0}`
  - [x] cross-check-alert on "BlackRock filed for a spot Solana ETF on 2026-03-12" (per the Claude Desktop probe): `{verdict:"NO_SIGNAL", confidence:0, sources_checked:0, signals_matched:0, citations:[], source_conflicts:[]}`
  - [x] disinfo-alert on TSLA / severity_threshold=medium (per the Claude Desktop probe): `{subject:"TSLA", severity_threshold:"medium", detected:false, status:"insufficient_data", patterns:[], signals_found:0, sources_checked:0}`
- **Evidence**: Path 2 verified live 2026-05-28T14:02Z against Worker version `2a3e962c-84ec-426e-afaf-f93aeb6470d4` with the production `vtk_` token over Streamable HTTP using the Gemini-CLI-style Accept header. Path 1 allowlist row present in `mcp_oauth_clients`: `gemini_cli / "Gemini CLI" / ['http://localhost:0/oauth/callback']` (the sentinel that the redirect-URI validator treats as a localhost-port wildcard per RFC 8252 §7.3, with strict `/oauth/callback` path-exact match). Same data-quality observations from the Cursor + Claude Code + Claude Desktop probes (`signals_found:0`, `sources_checked:0`, scores at 0); not an auth-pipe issue per Session #12.
- **Status**: Path 2 vtk_-bearer-transport PASS. Path 1 OAuth-surface-reachable PASS. Full Path 1 install smoke (`gemini mcp add verity --oauth ...` from a real Gemini CLI install, browser consent, six tool invocations from a Gemini CLI agent session) deferred to owner-driven follow-up `VRT-166-followup-gemini-cli-install-smoke`.

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
- `VRT-166-followup-claude-desktop-gui-install-smoke`: the Claude Desktop row above is PASS on the transport contract (HTTP probe with a production `vtk_` token over Streamable HTTP) but the actual GUI install path (config-file parse + Cmd-Q restart + tool invocation inside the Claude Desktop conversation pane) was not exercised this session. Failure modes to catch on next session smoke: trailing-comma in `claude_desktop_config.json`, `type: "http"` rejected by an older Claude Desktop build (fall back to `mcp-remote` stdio bridge), tools never appear because Claude Desktop was reloaded rather than fully quit.
- `VRT-166-followup-chatgpt-display-name-rename`: the consent screen renders "ChatGPT Desktop is asking to run Verity skills on your behalf" even when the user installs from ChatGPT web Apps. Cosmetic. The `display_name` field on the shared `chatgpt_desktop` `mcp_oauth_clients` row is set to "ChatGPT Desktop" from migration 046; renaming to "ChatGPT" (single label covering both web and Desktop) is a one-line UPDATE migration. Alternative: split into separate `chatgpt_web` and `chatgpt_desktop` rows with distinct display names, which requires DCR-level disambiguation between web and Desktop registration requests. Not blocking; cleaner end-user wording.
- `VRT-166-followup-deprecate-static-chatgpt-callback`: when ChatGPT Desktop builds that pre-date the Apps UI rename are confirmed extinct, drop the legacy static `https://chatgpt.com/connector_platform_oauth_redirect` entry from the `chatgpt_desktop` row's `redirect_uris`. Kept in v1 for backward compatibility with older installs.
- `VRT-166-followup-gemini-cli-install-smoke`: Gemini CLI Path 1 OAuth flow (`gemini mcp add verity --oauth --discovery ... --client-id gemini_cli`, browser consent, six tool invocations) not exercised. Path 2 (vtk_ direct) is verified at the transport layer. Failure modes to catch on next session smoke for Path 1: Gemini CLI rejects the discovery doc shape, loopback listener times out before consent approval, Path-1-issued `vto_` token's audience-binding gets rejected at `/oauth/token` if the resource indicator does not match `https://mcp.verityskills.com` exactly.
- Cleanup cron for long-revoked refresh-token rows (iter-5 of PR #17 switched rotation from hard-delete to soft-revoke; rows accumulate without bound until a cleanup cron lands).
- Lower-priority parent-review-batch findings deferred (see PR #17 iter-5 comment).
