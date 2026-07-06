# modelcontextprotocol registry submission walkthrough - READY FOR OWNER EXECUTION (rewritten 2026-07-06)

> **This walkthrough was rewritten on 2026-07-06.** The original draft described a fork-and-PR flow adding `servers/community/verity.yaml`. That flow no longer exists. The official MCP Registry is now an API-driven service at https://registry.modelcontextprotocol.io, published to via the `mcp-publisher` CLI with a `server.json` descriptor. Registry entries live in the registry database, not in the GitHub repo. Docs: https://github.com/modelcontextprotocol/registry/tree/main/docs/modelcontextprotocol-io

## Decision the owner makes first: namespace

The authentication method chosen at publish time fixes the server's registry name permanently.

| Option | Registry name | Auth mechanism | Effort |
|---|---|---|---|
| A. GitHub auth (recommended for first publish) | `io.github.cchurctrip/verity` | `mcp-publisher login github` device-code flow with the cchurctrip account | 2 minutes, no infrastructure changes |
| B. Domain auth | `com.verityskills/verity` | Ed25519 keypair + TXT record on the verityskills.com apex (Cloudflare DNS), `mcp-publisher login dns` | 15 minutes, key custody to manage, brandier name |

Note for option B: the TXT record goes on the apex (`verityskills.com`), not under a selector. macOS system openssl is LibreSSL and cannot generate Ed25519 keys; use `brew install openssl@3` and call it explicitly, or use the ECDSA P-384 variant.

## Workflow for the maintainer

1. Install the publisher CLI:
   ```bash
   brew install mcp-publisher
   ```
2. From the verity-mcp repo root, verify `server.json` (exact contents below, kept at `marketplace/server.json` until publish; move or copy to repo root when publishing).
3. Authenticate (option A shown):
   ```bash
   mcp-publisher login github
   ```
4. Publish:
   ```bash
   mcp-publisher publish
   ```
5. Verify the listing:
   ```bash
   curl -s "https://registry.modelcontextprotocol.io/v0.1/servers?search=verity"
   ```
6. Downstream aggregators (Smithery, PulseMCP, client-side registries) sync from this API on their own cadence.

## Exact server.json (remote server, no packages)

Schema reference: https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json. Verity is a remote-only server, so it uses the `remotes` array; there is no npm package to verify. The name below assumes option A; switch to `com.verityskills/verity` for option B.

```json
{
  "$schema": "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
  "name": "io.github.cchurctrip/verity",
  "title": "Verity",
  "description": "Real-time social media and prediction market integrity layer. Tools for AI workflows: integrity scoring, pre-trade scans, cross-reference checks, coordinated-narrative detection, daily watchlist briefs, coordination heat, and notification preferences. Bearer-token auth, seven-day trial without credit card.",
  "repository": {
    "url": "https://github.com/cchurctrip/verity-mcp",
    "source": "github"
  },
  "version": "1.0.0",
  "remotes": [
    {
      "type": "streamable-http",
      "url": "https://mcp.verityskills.com/mcp",
      "headers": [
        {
          "name": "Authorization",
          "description": "Bearer vtk_<token>. Obtain a key at https://verityskills.com/account/api-keys. Seven-day trial, no credit card.",
          "isRequired": true,
          "isSecret": true
        }
      ]
    },
    {
      "type": "sse",
      "url": "https://mcp.verityskills.com/sse"
    }
  ]
}
```

Both transports are live post VRT-165: POST `/mcp` content-negotiates Streamable HTTP (SSE-framed when `Accept: text/event-stream`, plain JSON otherwise); GET/POST `/sse` is the legacy EventSource bridge.

## Current live-surface facts (verified 2026-07-06)

- `/health` returns 200 with commit SHA `b70ddca` and `kill_switch_engaged: false`.
- `tools/list` now REQUIRES auth (the Worker returns `AUTHENTICATION_REQUIRED` with an OAuth pointer when the Authorization header is absent). Registry publication does not need anonymous tools/list, but some downstream aggregators probe it; their scan surfaces whatever the Worker returns.
- The server exposes SEVEN tools, not six: coordination-heat, verity-score, morning-brief, verity-scan, cross-check-alert, disinfo-alert, notification-prefs (account utility added in VRT-210e). Marketing copy in `marketplace/copy/` still says "six tools" (six detection skills; notification-prefs is account management). Owner call on whether to adjust copy; brand rules forbid agent-written copy edits.

## Known blockers to fix BEFORE publishing

- [ ] `support@verityskills.com` inbox configured (Cloudflare Email Routing forward). Listed as the maintainer contact.
- [x] Pricing-page parity: verityskills.com/pricing shows $49 / $149 / $499 (verified 2026-07-06).
- [ ] Live-contract evidence is RED: the nightly `live-contract-e2e` workflow has never passed (all runs since 2026-05-28 fail 7/22; `VERITY_MCP_TEST_KEY` set 2026-05-21 no longer matches any active account key hash). Rotate the secret to a valid key for a dedicated smoke account and get one green run before publishing.
- [ ] Owner explicit go-ahead. Publishing makes the listing public immediately (no editorial review queue on the official registry).

## Post-publish behaviour

- The entry is served from the registry API immediately; aggregators pick it up on their next sync.
- Updates: bump `version` in server.json and run `mcp-publisher publish` again with the same auth.
- Rollback: publish an updated entry, or for a serious issue engage the kill switch (`MCP_KILL_SWITCH=on` Wrangler secret; /mcp returns 503 `KILL_SWITCH_ENGAGED` while /health stays reachable). Registry deletion requests go through the registry moderation process (see docs/modelcontextprotocol-io/moderation-policy.mdx).
