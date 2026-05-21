# Cursor Directory + Cursor Desktop install

[Cursor](https://cursor.com) ships native MCP support. Two listings to pursue: their public Directory (discovery) and a one-paste config snippet (install).

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

### Option B: Manual config

Add to `~/.cursor/mcp.json`:

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

Restart Cursor. Open settings -> MCP. Verity should appear with 6 tools listed. Test by typing `@verity-score NVDA` in chat.

## Transports available

Cursor connects via Streamable HTTP at `POST /mcp` (MCP 2025-03-26). The Worker also serves a legacy SSE bridge at `GET /sse` + `POST /sse` for clients that need EventSource handshake (Perplexity Comet today). Cursor does not need the legacy SSE path; the snippet above hits Streamable HTTP automatically. The server returns `Content-Type: application/json` for Cursor requests (Cursor's `mcp.json` direct-HTTP path does not send `text/event-stream` in Accept), and `Content-Type: text/event-stream` only when the client requests it.

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
