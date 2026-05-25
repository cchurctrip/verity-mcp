# VRT-166 OAuth 2.1 multi-client verification

**Status**: template; owner fills in after running each 4-client smoke.
**Live deploy**: `mcp.verityskills.com`
**Wrangler version ID**: `393bd974-62cd-42bd-b972-0a9977ece89a` (2026-05-25 Phase 1 OAuth deploy)
**Worker commit (/health)**: `4dfbf2f798c7be58b04a4dd07ed18a1b3ac3da98` (the /health endpoint returns `commit: "unknown"` because the deploy did not inject `--var COMMIT_SHA`; the version ID above is the source of truth)
**Spec**: `cchurctrip/verity` `mydocs/specs/2026-05-22_VRT-166_oauth-21-mcp-server.md`
**Impl PRs**:
- Phase 0 migrations: `cchurctrip/verity` #305 (merged 2026-05-22T15:52Z)
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

- **Install path tried**: (OAuth via Cursor Settings MCP / vtk_ config snippet / both)
- **client_id used**: `cursor`
- **Consent screen rendered correctly?** (yes / no)
- **Tool list after Connect**: (paste output of `cursor mcp list verity` or equivalent)
- **6 tools invoked successfully**:
  - [ ] verity-score on NVDA
  - [ ] morning-brief
  - [ ] coordination-heat on GME
  - [ ] verity-scan
  - [ ] cross-check-alert
  - [ ] disinfo-alert
- **Evidence**: (paste)
- **Status**: (PASS / FAIL)

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

- Wire `COMMIT_SHA` injection into the deploy script (`--var COMMIT_SHA:$(git rev-parse HEAD)` on `wrangler deploy`).
- Cleanup cron for long-revoked refresh-token rows (iter-5 of PR #17 switched rotation from hard-delete to soft-revoke; rows accumulate without bound until a cleanup cron lands).
- Lower-priority parent-review-batch findings deferred (see PR #17 iter-5 comment).
