# Owner action checklist

Everything that requires your hands on a keyboard or a UI to ship Verity skills to agents. Ordered for shortest critical path to "an agent can find and use Verity."

## Block A: deploy (45 minutes, blocking everything else)

| # | Action | Time | Where |
|---|---|---|---|
| 1 | `npx wrangler login` and confirm OAuth scopes | 5 min | terminal in `~/workspace/verity-mcp` |
| 2 | Create Sentry project for `verity-mcp` (JavaScript / Cloudflare Workers platform). Copy DSN. | 5 min | https://sentry.io |
| 3 | `echo "<DSN>" | npx wrangler secret put SENTRY_DSN --env production` | 1 min | terminal |
| 4 | `echo "<DSN>" | npx wrangler secret put SENTRY_DSN --env preview` | 1 min | terminal |
| 5 | `npx wrangler deploy --env preview` | 1 min | terminal |
| 6 | `bash scripts/post-deploy-smoke.sh https://verity-mcp-preview.<account>.workers.dev` | 1 min | terminal |
| 7 | Add CNAME `mcp` -> `<account>.workers.dev` (proxied / orange cloud) in Cloudflare DNS for `verityskills.com` | 5 min | Cloudflare DNS UI |
| 8 | Wait for DNS propagation. `dig +short mcp.verityskills.com` should return an anycast IP. | 5-15 min | terminal |
| 9 | `npx wrangler deploy --env production` | 1 min | terminal |
| 10 | `bash scripts/post-deploy-smoke.sh https://mcp.verityskills.com` | 1 min | terminal |
| 11 | Flip `MCP_HEALTH_EXPECTED=true` in `cchurctrip/verity` Vercel env (production scope) | 2 min | Vercel dashboard or `vercel env add` |
| 12 | Smoke test from Claude Desktop: paste config from `docs/CLAUDE_DESKTOP.md`, restart, ask "use verity-score on NVDA" | 5 min | Claude Desktop |

Full step-by-step with verification commands in `docs/DEPLOY_RUNBOOK.md`.

## Block B: discovery (90 minutes, parallel to Block C)

| # | Action | Time | Where |
|---|---|---|---|
| 1 | Approve the proposed `/skills` page rewrite in `docs/launch-drafts/skills-page-rewrite.md` (or redirect with feedback) | 10 min | review file |
| 2 | Once approved, apply the rewrite to `cchurctrip/verity:app/skills/page.tsx`. Open PR there. | 30 min | workspace-verity repo |
| 3 | Submit verity-mcp to Smithery.ai per `docs/SMITHERY.md` | 15 min | smithery.ai/new |
| 4 | Submit verity-mcp to Cursor Directory per `docs/CURSOR.md` | 15 min | PR against the Cursor MCP listing repo |
| 5 | Submit to the official `modelcontextprotocol/registry` GitHub repo | 15 min | github.com PR |
| 6 | Add an `mcp.verityskills.com` ping to your existing uptime monitoring | 5 min | wherever you monitor |

## Block C: launch (60 minutes, parallel to Block B)

| # | Action | Time | Where |
|---|---|---|---|
| 1 | Review `docs/launch-drafts/hn-show-post.md`. Approve or redirect. | 10 min | review file |
| 2 | Review `docs/launch-drafts/linkedin-essay.md`. Approve or redirect. | 10 min | review file |
| 3 | Review `docs/launch-drafts/twitter-thread.md`. Approve or redirect. | 10 min | review file |
| 4 | Schedule the HN post for next Tuesday or Wednesday at 8am ET (use the HN sticky-replies plan in the draft) | 5 min | calendar |
| 5 | Schedule the LinkedIn post for the same day at 8am ET | 5 min | LinkedIn / Buffer |
| 6 | Schedule the Twitter thread for 10am ET (same day) | 5 min | X / Buffer |
| 7 | Prep the Day 0 reply hooks: have Claude Desktop screenshot, comparison-vs-Bloomberg copy, demo curl call ready | 15 min | your notes |

## Block D: post-launch (ongoing)

- Monitor `mcp.verityskills.com/health` for the first 7 days (cron alerts to Telegram via the existing pipeline)
- Watch for marketplace approval emails (Smithery, Cursor); when approved, add badges to README
- First 100 users get a hand-written welcome email (Marcus Webb @ verityskills.com)
- After 7 days, review:
  - Smithery: did the listing get approved? (Re-submit if rejected.)
  - HN: did the post hit front page? (Repost variant if not, per the HN draft variants section.)
  - Cursor Directory: did the PR get merged?
  - DNS propagation: any user reports of resolution issues?
  - Sentry: any P0 issues captured in the first wave of real traffic?

## Sequencing summary

```
Day 0 (today or tomorrow): Block A (deploy, 45 min)
                          └─→ once live, kick off Block B (discovery, 90 min parallel)

Day +3 (review window):    Block C drafts approved
                          └─→ Block C scheduled

Day +5 to +7:              Launch day. HN + LinkedIn + X.
                          └─→ Block D monitoring kicks in.
```

Critical path is Block A (~45 min owner time). Everything else can layer on top once `mcp.verityskills.com` is serving 200s.

## Total owner time

About 4 hours of focused work, spread across 5-7 days. Most of it is review of drafts and submission forms; the actual deploy is 45 minutes.
