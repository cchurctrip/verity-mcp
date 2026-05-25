# ChatGPT Desktop install

ChatGPT Desktop's Connectors UI uses OAuth 2.1 (MCP 2025-06-18) exclusively. There is no bearer-paste field; the only install path is the OAuth flow below. For programmatic access from agent code (Anthropic Agent SDK, LangChain, custom scripts) use the API key path on [`/account/api-keys`](https://verityskills.com/account/api-keys) and pass `Authorization: Bearer vtk_<token>` directly; ChatGPT's UI Connector does not consume those.

## OAuth via the ChatGPT Desktop Connectors UI

Open ChatGPT Desktop. Settings -> Connectors -> Add custom connector. Paste:

| Field | Value |
|---|---|
| Server URL | `https://mcp.verityskills.com/mcp` |
| Discovery URL | `https://mcp.verityskills.com/.well-known/oauth-authorization-server` |
| Client ID | `chatgpt_desktop` |
| Client Secret | leave empty |

Click Connect. ChatGPT opens the consent screen at `https://verityskills.com/oauth/mcp/authorize` in your default browser. Sign in via the magic link delivered to your inbox (the first install creates a Verity account if needed; existing accounts sign in to the same email). Approve the consent. ChatGPT receives the OAuth token and registers the six Verity tools.

Verify by opening a new ChatGPT conversation and asking "Use verity-score on NVDA". ChatGPT picks the tool from the connector and invokes it.

ChatGPT Desktop uses a fixed callback URL: `https://chatgpt.com/connector_platform_oauth_redirect`. The `client_id=chatgpt_desktop` row in the pre-registered allowlist carries that exact URL; no wildcard is involved.

## Notes

- The `client_id` value (`chatgpt_desktop`) is a fixed string from v1's pre-registered allowlist. RFC 7591 dynamic client registration is deferred.
- The consent screen lives on `https://verityskills.com`; the URL bar is visible so you can confirm you are signing in to Verity, not a phishing page.
- Tokens are short-lived (1 hour access, 30 day refresh, automatic rotation per RFC 6749). Re-signing in is rare; ChatGPT Desktop handles the refresh transparently.
- Tools that need a Pro or Fund tier (e.g. unlimited verity-score calls) still gate on tier; the OAuth flow grants access to your account's existing entitlement, it does not upgrade you.
- ChatGPT Desktop's UI surfaces "Authentication required" with a Connect button if a tool returns a 401 from the Worker (token expired, revoked, or never issued). Click Connect to re-sign in.

## Transports

ChatGPT Desktop calls `POST /mcp` with `Accept: text/event-stream` (Streamable HTTP per MCP 2025-03-26). The Worker frames the response as a single SSE `event: message` followed by stream close. The probe at `scripts/multi-client-probe.sh` (probe 5/9) pins this contract.

## Troubleshooting

- **ChatGPT says "no tools available" or "connector failed":** confirm the `client_id` is exactly `chatgpt_desktop` (no whitespace, lowercase). Confirm the Discovery URL is reachable in your browser and returns JSON.
- **Approving the consent loops back to the consent screen:** the OAuth code expired (10 minute TTL). Click Connect again; ChatGPT issues a new authorize request.
- **A tool returns 402:** trial cap reached. The response includes an `upgrade_url`; visit it to upgrade to Pro or Fund.
- **The first call after a long idle returns slowly:** Cloudflare Worker cold start. First request on a new isolate takes 200 to 400ms; subsequent calls are sub-100ms.
