# Cursor Directory + Cursor Desktop install

[Cursor](https://cursor.com) ships native MCP support. Two listings to pursue: their public Directory (discovery) and a one-paste config snippet (install). Cursor also supports OAuth 2.1 install for end users who prefer a sign-in flow over pasting an API key.

## OAuth via Cursor MCP settings (recommended for end users)

Cursor's MCP install flow accepts OAuth 2.1 servers. In Cursor: Settings -> Cursor Settings -> MCP -> Add new MCP server. Pick the OAuth option and paste:

| Field | Value |
|---|---|
| Server URL | `https://mcp.verityskills.com/mcp` |
| Discovery URL | `https://mcp.verityskills.com/.well-known/oauth-authorization-server` |
| Client ID | `cursor` |
| Client Secret | leave empty |

Cursor opens the consent screen at `https://verityskills.com/oauth/mcp/authorize` in your default browser. Sign in via the magic link delivered to your inbox. Approve the consent. Cursor receives the OAuth token and lists the six Verity tools.

Cursor uses a loopback callback (`http://localhost:<port>/oauth/callback`) per RFC 8252 §7.3. The Worker accepts any localhost port at validation time (the `client_id=cursor` row in the pre-registered allowlist carries the sentinel `http://localhost:0/oauth/callback`).

Notes:
- The `client_id` value (`cursor`) is a fixed string from v1's pre-registered allowlist.
- Tokens are short-lived (1 hour access, 30 day refresh, automatic rotation per RFC 6749).
- Tools that gate on Pro or Fund tier still gate; OAuth grants the existing entitlement, it does not upgrade you.

## Cursor Directory submission

Cursor maintains a public listing at https://cursor.directory/mcp. Their submission flow:

1. Open a PR to https://github.com/cursor-community/awesome-mcp (or whichever upstream they currently use; check `cursor.directory` for the active list).
2. Add an entry under the appropriate category (suggested: `finance` or `research`).

Entry format (current as of 2026-05):

```markdown
### Verity

Coordination, market integrity, and disinformation signals for AI trading
agents. Six callable skills detect coordinated activity, score market subjects,
and flag manipulation patterns. Pre-trade integrity check for AI workflows.

- **URL:** https://mcp.verityskills.com/mcp
- **Repo:** https://github.com/cchurctrip/verity-mcp
- **Auth:** Bearer token at https://verityskills.com/account/api-keys (every skill)
- **Anonymous tools:** none
- **Categories:** finance, research, data
```

## Cursor Desktop install snippet

Cursor reads `mcp.json` for tool definitions. Two ways to share:

### Option A: One-click install URL (best UX)

Cursor supports `cursor://` deep links. Build the install URL:

```
cursor://mcp/install?name=verity&url=https://mcp.verityskills.com/mcp
```

Embed this as a button on `verityskills.com/skills`:

```html
<a href="cursor://mcp/install?name=verity&url=https://mcp.verityskills.com/mcp">
  <img src="https://verityskills.com/badges/add-to-cursor.png" alt="Add to Cursor">
</a>
```

The user clicks the badge, Cursor prompts for confirmation, the server is added.

### Option B: Manual config with OAuth (recommended)

Add to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "verity": {
      "url": "https://mcp.verityskills.com/mcp"
    }
  }
}
```

Restart Cursor. The first time Cursor opens a session that touches `verity`, the Worker responds to the unauthenticated `POST /mcp` with `401 + WWW-Authenticate: Bearer realm="mcp.verityskills.com", resource_metadata="..."`. Cursor reads the `resource_metadata` pointer, fetches the OAuth Authorization Server metadata, and opens the consent screen at `https://verityskills.com/oauth/mcp/authorize` in the default browser. After magic-link sign-in and approval, Cursor stores the `vto_*` access token and retries `tools/list`. The six Verity tools appear in `Settings -> Tools & MCP -> verity`. Test by typing `Use coordination heat on GME` in chat.

### Option C: Manual config with static `vtk_` token (no browser flow)

For headless installs (CI, scripts, environments where the consent UI is inaccessible), paste the pre-issued user API key directly:

```json
{
  "mcpServers": {
    "verity": {
      "url": "https://mcp.verityskills.com/mcp",
      "headers": {
        "Authorization": "Bearer vtk_<your-token>"
      }
    }
  }
}
```

Restart Cursor. Open settings -> MCP. Verity should appear with 6 tools listed (no OAuth round-trip; the worker validates the `vtk_` token on every request). Use `https://verityskills.com/account/api-keys` to mint the token.

## Transports available

Cursor connects via Streamable HTTP at `POST /mcp` (MCP 2025-03-26). The Worker also serves a legacy SSE bridge at `GET /sse` + `POST /sse` for clients that need EventSource handshake (Perplexity Comet today). Cursor does not need the legacy SSE path; the snippets above hit Streamable HTTP automatically.

Content-Type negotiation on `POST /mcp`: the Worker emits `application/json` by default and `text/event-stream` (as a single `event: message` frame, then stream close) when the `Accept` header contains `text/event-stream`. Cursor 1.x sends `Accept: application/json, text/event-stream` on the streamable-HTTP path and accepts either content type; both representations carry the same JSON-RPC envelope.

## Eager-OAuth contract (issue #25)

`POST /mcp` returns `401 + WWW-Authenticate` for any request without an `Authorization` header, including `initialize` and `tools/list`. This is required for Cursor's `mcp.json` HTTP install path: Cursor's MCP client FSM drives OAuth from the connection-open exchange (a 200 on `initialize` strands the FSM in `auth=unknown` and no tools surface to the agent, even after a successful out-of-band OAuth round-trip). The 401-challenge contract is the same one PostHog, Supabase, and other RFC 9728 MCP servers honor.

The challenge subsumes the prior lazy-OAuth model (anonymous `tools/list` → 401 on `tools/call`). Clients that previously authenticated lazily (Claude Desktop today) also handle the eager challenge cleanly because the OAuth response to a `401 + WWW-Authenticate` is identical in both cases.

## Dynamic Client Registration bridge (issue #25)

`POST /oauth/register` accepts an RFC 7591 client registration request and answers with a `201` carrying one of the pre-registered allowlist `client_id` values (`cursor`, `claude_desktop`, `chatgpt_desktop`, `gemini_cli`). The mapping uses a case-insensitive substring match on the inbound `client_name`; unknown clients fall through to `cursor`. The endpoint is advertised in the AS metadata via `registration_endpoint`.

Why this exists: Cursor 1.x's `mcp.json` install path runs DCR before completing OAuth. Spec-correct behavior when `registration_endpoint` is absent (RFC 8414 §2) is to fall back to a configured `client_id`, but Cursor 1.x instead POSTs to a guessed default path. Without a 2xx response the MCP client FSM tombstones the connection after 5 consecutive 404s and the UI surfaces `The MCP server errored`. The bridge endpoint is safe because every v1 client is public (`token_endpoint_auth_method: none`) and the downstream `/authorize` endpoint re-validates the `client_id` against the consent UI allowlist regardless of what registration handed out. See `src/oauth-register.ts` for the full rationale.

## Cursor team awareness

Cursor's Bugbot has already reviewed PRs in this repo (it found the iter-1 issues on PR #4). The Cursor team will recognize the project. After listing, ping `@anysphere` on X with the Angle 9 hook and tag `@cursor_ai`.

## What about Anthropic's MCP directory?

Anthropic does not yet publish a curated MCP directory of their own. The Claude Desktop install path is via `claude_desktop_config.json` (see `docs/CLAUDE_DESKTOP.md` in this repo for the canonical snippet). The closest official surface is the `@modelcontextprotocol/registry` registry: a JSON file in the modelcontextprotocol/registry GitHub repo. PR to that repo with the same payload as the Smithery submission.

## Validation before submitting

Test the install path end-to-end before any public listing:

1. Fresh Cursor install on a clean machine.
2. Paste the `mcp.json` snippet.
3. Restart Cursor.
4. Invoke `verity-score` from chat.
5. Verify the response is the structured upstream payload.

If the install fails for any reason (auth header not propagated, JSON-RPC framing rejected, tool not appearing in palette), file an issue against the verity-mcp repo before pushing the Cursor Directory PR. A broken listing is worse than no listing.
