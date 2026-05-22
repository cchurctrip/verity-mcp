# Claude Desktop install

Claude Desktop reads MCP server configs from `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows).

## Direct config snippet (native HTTP, Claude Desktop 2026 builds)

Paste into the JSON file's `mcpServers` block (create the object if it doesn't exist):

```json
{
  "mcpServers": {
    "verity": {
      "type": "http",
      "url": "https://mcp.verityskills.com/mcp",
      "headers": {
        "Authorization": "Bearer vtk_<your-token>"
      }
    }
  }
}
```

Claude Desktop 2026 builds support `type: "http"` for direct Streamable HTTP MCP server connections, no proxy needed.

## Fallback for older Claude Desktop builds (mcp-remote stdio bridge)

If `type: "http"` is rejected (older Claude Desktop, or a "no tools available" response after restart), use the `mcp-remote` stdio bridge to translate stdio MCP into HTTP MCP:

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

`mcp-remote` (from npm, package `mcp-remote`) is the standard stdio-to-HTTP bridge for MCP servers. The `--header` flag uses `Header:value` with no space after the colon to dodge yargs parsing.

Do NOT use `@modelcontextprotocol/server-fetch` here. That package provides a `fetch` tool (callable from inside any MCP client); it is not a bridge to a remote MCP server. Prior versions of this doc had the wrong snippet.

## Verifying the install

Where to get `vtk_<your-token>`: https://verityskills.com/account/api-keys

Fully quit Claude Desktop (Cmd-Q on macOS, right-click tray icon then Quit on Windows) before relaunch. Open a new conversation. Type `/verity` to confirm the six tools are loaded, or just ask "Use verity-score on NVDA" and Claude will invoke the tool.

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

## API key required for every skill

All six skills require a Verity API key. Issue one at https://verityskills.com/account/api-keys and configure it as the bearer token above. A request with no bearer (or a malformed one) returns 401 (INVALID_BEARER_FORMAT at the edge for a malformed header, or upstream UNAUTHORIZED when the header is absent).

## Troubleshooting

- **Claude says "no tools available":** check the JSON is valid (no trailing commas) and Claude Desktop has been fully restarted, not just reloaded.
- **All authenticated tools return 401:** verify the token starts with `vtk_` and contains no whitespace. The bearer regex is strict: `^Bearer vtk_[A-Za-z0-9]+$`.
- **A tool returns 402:** trial cap reached. The response includes an `upgrade_url`; visit it to upgrade to Pro or Fund tier.
- **The first call after a long idle returns slowly:** Cloudflare Worker cold start. First request on a new isolate takes 200-400ms; subsequent calls are sub-100ms.
