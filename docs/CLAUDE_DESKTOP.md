# Claude Desktop install

Claude Desktop reads MCP server configs from `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows).

## Direct config snippet

Paste into the JSON file's `mcpServers` block (create the object if it doesn't exist):

```json
{
  "mcpServers": {
    "verity": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-fetch",
        "https://mcp.verityskills.com/mcp"
      ],
      "env": {
        "AUTHORIZATION": "Bearer vtk_<your-token>"
      }
    }
  }
}
```

Where to get `vtk_<your-token>`: https://verityskills.com/account/api-keys

Restart Claude Desktop. Open a new conversation. Type `/verity` to confirm the 6 tools are loaded, or just ask "Use verity-score on NVDA" and Claude will invoke the tool.

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
- **`coordination-heat` works but `verity-score` returns 402:** trial cap reached. The response includes an `upgrade_url`; visit it to upgrade to Pro or Fund tier.
- **The first call after a long idle returns slowly:** Cloudflare Worker cold start. First request on a new isolate takes 200-400ms; subsequent calls are sub-100ms.
