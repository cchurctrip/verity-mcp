# Claude Desktop install

Two install paths:

1. **Direct bearer via config file** (recommended for everyone today; pinned `vtk_` API key; works reliably in every Claude Desktop build).
2. **OAuth via UI Connector** (preview; one-click sign-in; consent flow works end-to-end on the Verity side but the post-consent token exchange depends on Anthropic's Claude Desktop OAuth picker which is incomplete for third-party MCP servers as of 2026-05; documented below for when Anthropic ships the fix).

Both paths reach the same six tools at `https://mcp.verityskills.com`. Pick one or the other for a given install; mixing them just doubles the connectors.

## Path 1 (recommended): direct config snippet

This is the install path every Verity user should follow today. ~60 seconds end-to-end.

**Step 1**: Issue your Verity API key at https://verityskills.com/account/api-keys (click **Reveal** if you already have one, or **Generate** for a fresh one). The key looks like `vtk_<64 hex chars>`. Copy it.

**Step 2**: Open `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows) in any text editor. If the file does not exist, create it with this content. If it already has an `mcpServers` block with other servers, add the `"verity"` entry inside that block:

```json
{
  "mcpServers": {
    "verity": {
      "type": "http",
      "url": "https://mcp.verityskills.com/mcp",
      "headers": {
        "Authorization": "Bearer vtk_REPLACE_WITH_YOUR_TOKEN"
      }
    }
  }
}
```

Replace `vtk_REPLACE_WITH_YOUR_TOKEN` with the value from step 1. Save.

**Step 3**: Fully quit Claude Desktop (Cmd-Q on macOS, right-click tray icon then Quit on Windows). Do not just close the window; you have to actually quit. Reopen.

**Step 4**: Open a new conversation. Type `/verity` to confirm the six tools loaded, or just ask conversationally: "Use verity-score on NVDA". Claude invokes the tool and returns the result.

`type: "http"` is supported on Claude Desktop 2026 builds (native Streamable HTTP transport, no proxy). If your build rejects it, use the fallback below.

### Fallback for older Claude Desktop builds (mcp-remote stdio bridge)

If `type: "http"` is rejected (older Claude Desktop, or a "no tools available" response after restart), use the `mcp-remote` stdio bridge:

```json
{
  "mcpServers": {
    "verity": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://mcp.verityskills.com/mcp",
        "--header",
        "Authorization:Bearer vtk_<your-token>"
      ]
    }
  }
}
```

`mcp-remote` (npm package `mcp-remote`) is the standard stdio-to-HTTP MCP bridge. The `--header` flag uses `Header:value` with no space after the colon to dodge yargs parsing.

Do NOT use `@modelcontextprotocol/server-fetch` here. That package provides a `fetch` tool (callable from inside any MCP client); it is not a bridge to a remote MCP server.

## Path 2 (preview): OAuth via the UI Connector

Claude Desktop 1.8500+ ships an OAuth 2.1 UI Connector flow (MCP 2025-06-18). The Verity OAuth surface implements that spec end-to-end: discovery endpoints, PKCE S256, RFC 8707 resource indicator, audience binding, refresh-token rotation with family revocation per RFC 6819. Verified live with the multi-client probe harness (`scripts/multi-client-probe.sh`, 12 of 12 pass against `mcp.verityskills.com`).

In practice the flow stalls between consent approval and token redemption: Claude Desktop receives the OAuth code at `https://claude.ai/api/mcp/auth_callback?code=...&state=...` but does not call POST `/oauth/token` to redeem it. This is a known Anthropic-side gap as of 2026-05; the bug appears to affect third-party MCP server OAuth completion specifically. Once Anthropic ships the fix, this path becomes the recommended install for non-technical users (no JSON file editing).

Configuration (for when the picker works):

| Field | Value |
|---|---|
| Server URL | `https://mcp.verityskills.com/mcp` |
| Client ID | `claude_desktop` |
| Client Secret | leave empty |

The consent screen lives on `https://verityskills.com/oauth/mcp/authorize`. Sign in via the magic link delivered to your inbox (cross-tab safe; the magic-link URL carries a signed return_to so any tab can complete the flow). Approve the consent. Claude Desktop receives the OAuth code via `claude.ai/api/mcp/auth_callback`.

Notes:
- The `client_id` value (`claude_desktop`) is a fixed string from v1's pre-registered allowlist (4 clients: Claude Desktop, ChatGPT Desktop, Cursor, Gemini CLI). RFC 7591 dynamic client registration is deferred to v2.
- Tokens are short-lived (1 hour access, 30 day refresh, automatic rotation per RFC 6749).
- Tools that need Pro or Fund tier still gate on tier; OAuth grants existing entitlement, does not upgrade you.
- The same OAuth surface is the install path for any other MCP client (ChatGPT Desktop, Cursor, Gemini CLI) whose client-side OAuth completion works; those are not blocked on the Anthropic-side gap.

## Transports available

Two transports advertised at `https://mcp.verityskills.com`:

- **Streamable HTTP** at `POST /mcp`. When the request sends `Accept: text/event-stream`, the response is framed as one Server-Sent Events `event: message` followed by stream close (per MCP 2025-03-26). When the request omits `text/event-stream` from Accept, the response stays `Content-Type: application/json`. Use this transport for direct connections from Claude Desktop (2026+ native HTTP transport), ChatGPT Desktop, Gemini, and Cursor.
- **Legacy SSE** at `GET /sse` (open EventSource) + `POST /sse` (send JSON-RPC). Use this transport for clients that connect via EventSource handshake (Perplexity Comet today).

Either transport reaches the same six tools. Native HTTP transport in Claude Desktop uses Streamable HTTP automatically. The `mcp-remote` bridge falls back to whatever the upstream advertises; it typically picks Streamable HTTP.

## One-click install (when available)

Anthropic does not yet support `claude://mcp/install` deep links. When they do, embed this on `/skills`:

```html
<a href="claude://mcp/install?name=verity&url=https://mcp.verityskills.com/mcp">
  <img src="https://verityskills.com/badges/add-to-claude.png" alt="Add to Claude Desktop">
</a>
```

Track Anthropic's MCP install-flow announcements at https://www.anthropic.com/news.

## Tier gates apply to every tool call

Every Verity skill requires an authenticated identity. A request with no bearer (or a malformed one) returns 401. A request with a valid bearer on a tier the account does not hold returns 402 with an `upgrade_url`.

## Troubleshooting

- **Claude says "no tools available":** check the JSON is valid (no trailing commas) and Claude Desktop has been fully restarted, not just reloaded.
- **All authenticated tools return 401:** verify the token starts with `vtk_` and contains no whitespace. The bearer regex is strict: `^Bearer vtk_[A-Za-z0-9]+$`.
- **A tool returns 402:** trial cap reached or tier insufficient. The response includes an `upgrade_url`; visit it to upgrade to Pro or Fund tier.
- **The first call after a long idle returns slowly:** Cloudflare Worker cold start. First request on a new isolate takes 200-400ms; subsequent calls are sub-100ms.
- **OAuth UI Connector adds Verity but tools never authenticate:** known Anthropic-side gap (see Path 2 above). Switch to Path 1 (direct config); same end result.
