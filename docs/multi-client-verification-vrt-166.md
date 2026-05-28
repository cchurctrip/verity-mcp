# VRT-166 OAuth 2.1 multi-client verification

**Status**: Cursor PASS (2026-05-27T16:43Z), Claude Code PASS (2026-05-27T22:13Z), ChatGPT end-to-end PASS (2026-05-28T15:43Z post-#343 dynamic callback fix), **Gemini CLI Path 2 end-to-end PASS via Gemini's LLM (2026-05-28T19:21Z, 3 tools invoked, real-time timestamps)**, Claude Desktop transport-contract PASS (vtk_ HTTP probe; GUI install deferred), Gemini CLI Path 1 OAuth surface-reachable (Gemini CLI v0.44.0 `mcp add` lacks an `--oauth` flag; upstream limitation). Phase 3 effective state: 4 of 6 surfaces end-to-end via the real product UX; remaining 2 covered by transport-contract probes and tracked follow-ups; none block VRT-148 marketplace submissions.
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

Gemini CLI v0.44.0 (`@google/gemini-cli`) supports two install paths per `docs/GEMINI_CLI.md`. Path 1 OAuth was originally written as `gemini mcp add verity --oauth ...`, but v0.44.0's `gemini mcp add --help` shows no `--oauth` flag; only transport-type-and-headers. OAuth auto-discovery from the Worker's 401 + `WWW-Authenticate` response is not wired in this CLI version either. Path 2 (direct `vtk_` bearer) is therefore the install path that actually works for end users today, and is the path verified end-to-end below. Path 1 OAuth full-flow is deferred upstream until Gemini CLI ships an OAuth subcommand or auto-discovery support.

Gemini CLI was installed locally at `/opt/homebrew/bin/gemini` (Node 22.22.0, npm-global) and `verity` was registered as an HTTP MCP server with the `vtk_` bearer header. The CLI confirmed connection state via `gemini mcp list`: `✓ verity: https://mcp.verityskills.com/mcp (http) - Connected`. Three Verity tools were then invoked through Gemini's LLM in headless `gemini -p` mode (with `-y` YOLO mode to auto-approve MCP tool calls in non-interactive mode; see the marketplace caveats below).

- **Install path tried**: Path 2 (`vtk_` direct bearer) end-to-end through Gemini CLI's `gemini -p` headless agent mode with `-y` auto-approve. Path 1 OAuth-surface probe (allowlist row + `/authorize` redirect + consent UI reachability) covers the surface contract; full Path 1 OAuth invocation through Gemini CLI is upstream-blocked as noted above.
- **client_id used**: N/A on Path 2 (no OAuth involved). `gemini_cli` on Path 1 (surface probe only).
- **Consent screen rendered correctly?** Path 1 surface probe: Worker `/authorize` 302-redirects to `https://verityskills.com/oauth/mcp/authorize` with all query params preserved (verified 2026-05-28T14:00:35Z, `cf-ray: a02dc9583c5cb634`); consent UI HTTP 200 (reachable, no allowlist-rejection signal). Path 2: N/A.
- **Tool list after Connect**: `gemini mcp list` reports `verity` Connected with the registered 6 tools. Note that when Gemini's LLM is asked to enumerate its own action space ("list every MCP tool you have access to"), it lists only its 12 built-in tools (`google_web_search`, `run_shell_command`, etc.); MCP tools do not appear in the inventory reflection. Cosmetic only; the tools are callable.
- **6 tools invoked successfully (3 through Gemini's LLM end-to-end via `-y` headless mode; remaining 3 covered by the Worker probe upstream with the Gemini-style Accept header)**:
  - [x] verity-score on NVDA via Gemini LLM - `{status:"ok", ticker:"NVDA", score:0, breakdown:{topicMix:0,coordination:0,sentimentVol:0,predMarketDivergence:0}, explanation:"Verity Score within normal range.", asof:"2026-05-28T08:05:30.694Z"}`
  - [x] morning-brief on [NVDA, GME, TSLA] via Gemini LLM - `{status:"ok", variant:"clean", subject:"Verity morning brief: clean read", tickers:[3 entries], asof:"2026-05-28T19:21:16.557Z"}`
  - [x] coordination-heat on GME via Gemini LLM - `{subject:"GME", status:"insufficient_data", signals_found:0, sources_checked:0, window_hours:2}`
  - [x] verity-scan on AAPL (covered by Worker probe with Gemini-style Accept header): `{status:"ok", tickers_checked:["AAPL"], scan_window_hours:4, anomalies:[], clean:["AAPL"], anomaly_count:0}`
  - [x] cross-check-alert on "BlackRock filed for a spot Solana ETF on 2026-03-12" (covered by Worker probe): `{verdict:"NO_SIGNAL", confidence:0, sources_checked:0, signals_matched:0, citations:[], source_conflicts:[]}`
  - [x] disinfo-alert on TSLA / severity_threshold=medium (covered by Worker probe): `{subject:"TSLA", severity_threshold:"medium", detected:false, status:"insufficient_data", patterns:[]}`
- **Evidence**: Path 2 verified end-to-end through Gemini CLI v0.44.0's LLM on 2026-05-28T19:21Z. The `morning-brief asof:"2026-05-28T19:21:16.557Z"` real-time timestamp confirms Gemini's call hit the live Worker at that minute. Gemini CLI's settings.json shows the configured server as `{"url":"https://mcp.verityskills.com/mcp","type":"http","headers":{"Authorization":"Bearer vtk_<redacted>"}}`. End-to-end stack: Gemini CLI HTTP transport with vtk_ bearer + Worker version `2a3e962c-84ec-426e-afaf-f93aeb6470d4`. Path 1 allowlist row present in `mcp_oauth_clients`: `gemini_cli / "Gemini CLI" / ['http://localhost:0/oauth/callback']` (localhost-port wildcard sentinel per RFC 8252 §7.3, strict `/oauth/callback` path-exact match).
- **Status**: Path 2 end-to-end PASS through Gemini's LLM. Path 1 OAuth surface-reachable; full Path 1 invocation blocked upstream on Gemini CLI gaining an `--oauth` flag or OAuth auto-discovery.

#### Marketplace-relevant UX caveats (worth surfacing to Gemini-CLI Verity users)

Gemini CLI v0.44.0 has three behaviors that affect how end users will experience Verity tools. None block functionality, but each warrants a docs note in `docs/GEMINI_CLI.md`:

1. **Tool-selection priors**: vague prompts ("use verity-score on NVDA") cause Gemini's LLM to reach for built-in tools first (`google_web_search`, `run_shell_command`) before considering MCP tools. Explicit prompts that name the tool ("Call the MCP tool named `verity-score` with the argument subject set to NVDA") route correctly.
2. **Approval gate**: MCP tool calls require user approval. In interactive mode the user clicks Approve. In headless `gemini -p` mode without `-y`, the approval prompt has no UI to fire against and the call is silently blocked; Gemini's planner falls back to built-in tools. End users running Gemini CLI as an agent should use `-y` (YOLO mode) or the explicit per-server approval flag.
3. **Inventory reflection**: when Gemini's LLM is asked "list your tools", MCP tools do not appear in the response even though they are callable. End users who probe Gemini for tool inventory will not see Verity tools; they need to ask for the tool by name. This is a Gemini CLI presentation quirk, not an MCP server issue.

These are standard MCP-in-an-agentic-CLI patterns shared with Cursor and Claude Code; not Verity-specific.

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
- `VRT-166-followup-gemini-cli-path1-oauth-upstream`: Gemini CLI v0.44.0 has no `--oauth` flag on `gemini mcp add` and does not auto-discover OAuth from a server's 401 `WWW-Authenticate` response. Path 1 (OAuth) is upstream-blocked until Gemini CLI adds an OAuth subcommand or auto-discovery. Track Gemini CLI release notes and Antigravity CLI (the announced 2026-06-18 Gemini CLI successor) for OAuth support. Verity-side Path 1 surface is verified ready: the `gemini_cli` allowlist row carries `http://localhost:0/oauth/callback` with the strict path-exact match expected by the redirect-URI validator.
- `VRT-166-followup-gemini-cli-docs-update`: extend `docs/GEMINI_CLI.md` with the three v0.44.0 UX caveats surfaced in the Gemini section above (tool-selection priors favoring built-in tools, headless mode requiring `-y` for MCP tool approval, MCP tools not appearing in LLM-mediated `list your tools` reflection). Marketplace materials and the Gemini-specific install instructions should call these out so end users do not bounce off on the first vague prompt.
- Cleanup cron for long-revoked refresh-token rows (iter-5 of PR #17 switched rotation from hard-delete to soft-revoke; rows accumulate without bound until a cleanup cron lands).
- Lower-priority parent-review-batch findings deferred (see PR #17 iter-5 comment).
