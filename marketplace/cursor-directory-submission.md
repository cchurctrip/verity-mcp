# Cursor Directory submission walkthrough - DRAFT

Cursor Directory (https://cursor.com/directory) is a curated discovery surface inside the Cursor editor. Listings are reviewed editorially before going live; the editorial team checks the MCP server works inside Cursor itself, that the description is accurate, and that the auth flow is sensible for Cursor users.

## Workflow for the maintainer

1. **Set up Cursor account** (if you do not already have one). Sign in at https://cursor.com.
2. **Local install of Verity in your Cursor as a smoke test** before submitting (see "User-side install steps" below). Confirm tools resolve + a sample call succeeds.
3. **Submit via the in-app flow**: Cursor → Settings → Cursor Directory → "Submit MCP Server". OR the public form at https://cursor.com/directory/submit.
4. **Fill the submission form** with:
   - Server name: `Verity`
   - Repository: `https://github.com/cchurctrip/verity-mcp`
   - Endpoint URL: `https://mcp.verityskills.com/mcp`
   - Transport: `HTTP` (POST + JSON-RPC). Note: Cursor supports both HTTP and SSE; HTTP is fine.
   - Auth: `Bearer` (Authorization header)
   - Key obtain URL: `https://verityskills.com/account/api-keys`
   - Tagline: from `marketplace/copy/tagline.md`
   - Long description: from `marketplace/copy/long-description.md`
   - Icon: upload `verity-mark-512.png`
   - Category: `Finance` + `Research`
   - Pricing: link to https://verityskills.com/pricing
5. **Cursor editorial review** (~3-7 days based on published timelines):
   - They install Verity in their test Cursor instance.
   - They run 2-3 natural-language prompts against the tools.
   - They check that auth errors are user-friendly (e.g. 401 returns "Invalid x-verity-key." not a stack trace).
   - They check the listing copy matches what the server actually does.
6. **Post-acceptance**: Verity appears in https://cursor.com/directory under Finance. Cursor users can one-click install.

## User-side install steps (use this in the listing FAQ + own this script in test)

Once accepted, end users add Verity through Cursor's MCP UI:

1. **Cursor → Settings (Cmd+,) → search "MCP" → "Edit MCP Servers"**. Opens `~/.cursor/mcp.json`.
2. Add this block (replacing `<your-vtk-key>` with the user's key from https://verityskills.com/account/api-keys):
   ```json
   {
     "mcpServers": {
       "verity": {
         "url": "https://mcp.verityskills.com/mcp",
         "headers": {
           "Authorization": "Bearer vtk_<your-vtk-key>"
         }
       }
     }
   }
   ```
3. Save the file. Cursor auto-reloads MCP servers (or restart Cursor if not).
4. Open chat (Cmd+L). The tools panel shows "verity (7 tools)" (six detection skills plus notification-prefs, added VRT-210e).
5. Try prompts:
   - "What is the Verity score for TSLA?"
   - "Run a morning brief on AAPL and NVDA."
   - "Are there coordination signals around GameStop right now?"
   - "Cross-check this claim: BlackRock filed for a spot Solana ETF on 2026-03-12."

## What the listing card shows

- Server name + icon at top.
- Tagline immediately under the name.
- "Install in Cursor" button (one-click adds the JSON block; user pastes their key).
- 6 tool chips, each with the 1-paragraph description from `tools/list`.
- Pricing summary (Trial / Retail / Pro / Fund).
- Last-tested badge: green checkmark + timestamp of the last successful Cursor-editorial smoke test.

## Known blockers to fix BEFORE submitting

- [x] Same Verity tier-page parity check as Smithery (Retail $49, Pro $149, Fund $499 on verityskills.com/pricing). Verified 2026-07-06.
- [ ] `support@verityskills.com` inbox configured.
- [ ] Live-contract evidence is RED: nightly `live-contract-e2e` has never passed (dead `VERITY_MCP_TEST_KEY` since 2026-05-21). Cursor editorial installs and runs the tools themselves; submit only after a green nightly proves the end-to-end path.
- [x] "Install in Cursor" deep link generated (2026-07-06; base64 config per the anysphere.cursor-deeplink scheme; user replaces vtk_YOUR_KEY_HERE after install):
  ```
  cursor://anysphere.cursor-deeplink/mcp/install?name=verity&config=eyJ1cmwiOiAiaHR0cHM6Ly9tY3AudmVyaXR5c2tpbGxzLmNvbS9tY3AiLCAiaGVhZGVycyI6IHsiQXV0aG9yaXphdGlvbiI6ICJCZWFyZXIgdnRrX1lPVVJfS0VZX0hFUkUifX0=
  ```
  Validate it opens the install prompt in a local Cursor before pasting into the submission form.
- [ ] Verify a Cursor install actually works end-to-end (the user-side install steps above) before submitting. The editorial team will repeat this; if it does not work for them, listing gets rejected. The probe-script transcript from VRT-155 Step (b) is the proof artifact.

## Rollback procedure

Same as Smithery: kill switch (`MCP_KILL_SWITCH=on` Wrangler secret) returns 503 to all tool calls; Cursor surfaces an "Error connecting to MCP server" toast. To remove the listing entirely, email the Cursor Directory team via the contact link on cursor.com/directory.
