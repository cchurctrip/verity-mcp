# Gemini CLI install

[Gemini CLI](https://github.com/google-gemini/gemini-cli) supports MCP servers via OAuth 2.1 (MCP 2025-06-18) or direct bearer config. End-user install uses OAuth; automation uses the API key.

## Path 1: OAuth via Gemini CLI's MCP add command (recommended for end users)

```
gemini mcp add verity --oauth \
  --discovery https://mcp.verityskills.com/.well-known/oauth-authorization-server \
  --client-id gemini_cli
```

Gemini CLI opens the consent screen at `https://verityskills.com/oauth/mcp/authorize` in your default browser. Sign in via the magic link delivered to your inbox. Approve the consent. Gemini CLI receives the OAuth token and stores it locally (per Gemini CLI's credential cache).

Verify by listing the registered tools:

```
gemini mcp list
```

Verity's six tools should appear under the `verity` server.

Gemini CLI uses a loopback callback (`http://localhost:<port>/oauth/callback`) per RFC 8252 §7.3. The Worker accepts any localhost port at validation time (the `client_id=gemini_cli` row in the pre-registered allowlist carries the sentinel `http://localhost:0/oauth/callback`).

## Path 2: Direct bearer (recommended for automation, CI, headless agents)

```
gemini mcp add verity \
  --url https://mcp.verityskills.com/mcp \
  --header "Authorization: Bearer vtk_<your-token>"
```

Where to get `vtk_<your-token>`: https://verityskills.com/account/api-keys

This path skips the OAuth handshake entirely and uses the user API key directly. Recommended for agent code, scheduled jobs, and any environment without a browser.

## Notes

- The `client_id` value (`gemini_cli`) is a fixed string from v1's pre-registered allowlist. RFC 7591 dynamic client registration is deferred.
- "Gemini CLI" is the documented MCP-OAuth surface for Gemini as of May 2026. Gemini AI Studio does not host custom MCP connectors with OAuth at the time of writing.
- Tokens are short-lived (1 hour access, 30 day refresh, automatic rotation per RFC 6749). Gemini CLI handles the refresh transparently.
- Tools that need a Pro or Fund tier (e.g. unlimited verity-score calls) still gate on tier; the OAuth flow grants access to your account's existing entitlement, it does not upgrade you.

## Transports

Gemini CLI calls `POST /mcp` with `Accept: text/event-stream;q=0.9, application/json` (Streamable HTTP per MCP 2025-03-26). The Worker frames the response as a single SSE `event: message` followed by stream close. The probe at `scripts/multi-client-probe.sh` (probe 7/9) pins this contract.

## Troubleshooting

- **`gemini mcp add` errors with "discovery doc missing required field":** confirm the Discovery URL returns JSON with `issuer`, `token_endpoint`, and `code_challenge_methods_supported`. Hit it in your browser to verify.
- **Approving the consent does not return to the terminal:** Gemini CLI's loopback listener may have timed out. Re-run `gemini mcp add verity --oauth ...` and approve faster.
- **A tool returns 402:** trial cap reached. The response includes an `upgrade_url`; visit it to upgrade to Pro or Fund.
- **The first call after a long idle returns slowly:** Cloudflare Worker cold start. First request on a new isolate takes 200 to 400ms; subsequent calls are sub-100ms.
