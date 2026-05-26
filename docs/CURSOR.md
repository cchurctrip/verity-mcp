# Verity MCP Server Setup for Cursor

Verity's MCP server connects to Cursor via OAuth 2.1, end-user clicks-only install once configured. Verified working with Cursor's OAuth picker as of 2026-05.

## Quick Setup (2 minutes)

### Step 1: Add to Cursor Configuration

Add this to your `~/.cursor/mcp.json` file (create it if it doesn't exist):

```json
{
  "mcpServers": {
    "verity": {
      "url": "https://mcp.verityskills.com/mcp",
      "type": "http",
      "auth": {
        "type": "oauth",
        "authorizationUrl": "https://mcp.verityskills.com/authorize",
        "tokenUrl": "https://mcp.verityskills.com/oauth/token",
        "clientId": "cursor",
        "scopes": ["mcp:invoke"],
        "resource": "https://mcp.verityskills.com"
      }
    }
  }
}
```

If you already have other MCP servers, just add the `"verity"` section inside `"mcpServers"`.

### Step 2: Restart Cursor

Completely quit and restart Cursor (not just reload window).

### Step 3: Authenticate

OAuth authentication triggers automatically when you first use a Verity tool that requires auth (see below for the four auth-required tools).

To trigger authentication:

1. Open Cursor Agent chat
2. Type: `Use coordination-heat on GME`
3. A browser window opens automatically
4. Sign in with your email (magic link delivered to your inbox)
5. Approve the connection
6. Browser redirects back to Cursor automatically via the localhost callback
7. Done; your command runs with the issued OAuth token

---

## Available Tools

After authentication, you can use these tools in Agent chat. Four require OAuth; two have an anonymous-fallback path that returns zero-stub data without a token.

### Auth-required tools (force OAuth on first call)

- coordination-heat: leaderboards of coordinated activity and sentiment manipulation across seven tabs (most-coordinated, sentiment-flip, cross-platform-velocity, suspect-pump, suspect-fud, verity-score-movers, and an alphabetical fallback).
  - Example: `Use coordination-heat on GME`
- verity-scan: subject-level scan that returns the most-recent signals for a given ticker or topic.
  - Example: `Run verity-scan on $NVDA`
- cross-check-alert: cross-reference a single claim across the live signals stream and prediction-market data.
  - Example: `Cross-check this alert: TSLA pumping`
- disinfo-alert: detect coordinated disinformation patterns on a specific narrative.
  - Example: `Disinfo-alert on the latest Tesla earnings narrative`

### Tools with anonymous fallback (will return zero-stub data without OAuth)

- verity-score: trust and integrity score for a ticker. Anonymous fallback returns `score=0, "Verity Score within normal range"`; signed-in callers get the real score breakdown.
  - Example: `Use verity-score on NVDA`
- morning-brief: daily roundup of overnight signals across your watchlist. Anonymous fallback returns zero-stub rows; signed-in callers get the real brief.
  - Example: `Show me the verity morning brief for NVDA, TSLA, GME`

To force OAuth at install time, call one of the four auth-required tools first.

---

## Troubleshooting

### OAuth window does not open

- Make sure you have completely restarted Cursor (not just reloaded the window)
- Try running a coordination-heat or verity-scan command to trigger authentication manually
- Check MCP logs: press `Cmd + Shift + U` (Mac) or `Ctrl + Shift + U` (Windows/Linux), then select "MCP Logs"

### "Verity server not available" error

- Verify your `mcp.json` configuration matches the snippet above exactly
- Check that you can reach `https://mcp.verityskills.com/health` from your browser (returns JSON)
- Try removing and re-adding the configuration

### Tools not showing up

- Open Settings > Tools & MCP
- Look for "verity" in the list
- Make sure it is toggled ON
- Status indicator should be green after authentication completes

### Auth completes but tools still 401

- Token may have expired (1 hour TTL). Cursor handles refresh automatically; if it does not, restart Cursor.
- If 401 persists, check Cursor's MCP Logs for the exact request/response.

---

## Example Workflows

### Stock market coordination analysis

```
Use coordination-heat on GME
Use coordination-heat on AMC
Compare coordination patterns between both
```

### News verification

```
Verity-scan: "Breaking news about company X merger"
Cross-check-alert: this news across sources
Use verity-score on the source ticker
```

### Daily monitoring

```
Show me today's morning brief for my watchlist
Disinfo-alert on the trending Tesla narrative
```

---

## OAuth specifics (for client implementers)

Verity's OAuth surface is MCP 2025-06-18 + OAuth 2.1 + RFC 8414/9728 conformant. Verified by the 12-probe harness in `scripts/multi-client-probe.sh`. Specifics relevant to a Cursor-style loopback client:

- Authorization URL: `https://mcp.verityskills.com/authorize`
- Token URL: `https://mcp.verityskills.com/oauth/token`
- Client ID (pre-registered, no DCR in v1): `cursor`
- Client Secret: empty (public client; PKCE-only)
- Scopes: `mcp:invoke`
- Resource: `https://mcp.verityskills.com`
- PKCE: S256 required (plain method rejected at the DB CHECK constraint)
- Redirect URI: `http://localhost:<any-port>/oauth/callback`; pre-registered seed allowlists `http://localhost:0/oauth/callback` for `client_id=cursor` per RFC 8252 section 7.3 (the `:0` is a wildcard matching any numeric port)

Discovery (auto-flow):
- Protected Resource Metadata: `https://mcp.verityskills.com/.well-known/oauth-protected-resource`
- Authorization Server Metadata: `https://mcp.verityskills.com/.well-known/oauth-authorization-server`

Tokens:
- Access tokens prefixed `vto_*`, hashed SHA-256 at rest, 1 hour TTL
- Refresh tokens, hashed at rest, 30 day TTL, rotation on every redeem
- Family revocation on replay per RFC 6819 section 5.2.2.3

---

## Cursor Directory submission (separate distribution channel)

Cursor maintains a public listing at https://cursor.directory/mcp. Submitting Verity there means any Cursor user can find it via the in-app marketplace and install with one click.

1. Open a PR to the Cursor directory's listing repo (check `cursor.directory` for the current upstream).
2. Add an entry under category `finance` or `research` with this payload:

```markdown
### Verity

Coordination, market integrity, and disinformation signals for AI
trading agents. Six callable skills detect coordinated activity,
score market subjects, and flag manipulation patterns. Pre-trade
integrity check for AI workflows.

- URL: https://mcp.verityskills.com/mcp
- Repo: https://github.com/cchurctrip/verity-mcp
- Auth: OAuth 2.1 (recommended) or Bearer token from https://verityskills.com/account/api-keys
- Categories: finance, research, data
```

This is one of the marketplace submissions tracked under VRT-148; same payload applies (with format edits) to Smithery and the modelcontextprotocol/registry.

---

## Support

- Documentation: https://github.com/cchurctrip/verity-mcp
- Issues: report on GitHub
- Logs: access via Cursor's MCP Logs panel (`Cmd + Shift + U` on Mac)

---

## Security and Privacy

- OAuth tokens are stored securely by Cursor's MCP credential cache
- Access tokens expire after 1 hour
- Refresh tokens are valid for 30 days; rotated on every refresh
- No API keys or credentials live in the configuration file
- PKCE S256 enforced end to end
- Verity's Sentry integration scrubs `vto_*` token patterns and OAuth-credential body keys from breadcrumbs before sending events

For the API-key install path (recommended if Cursor's OAuth picker is unavailable on your build), see [Path 1 in CLAUDE_DESKTOP.md](./CLAUDE_DESKTOP.md); same JSON pattern works in Cursor's `mcp.json`.
