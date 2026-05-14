# Twitter / X launch thread

## Thread structure (8 tweets)

**Tweet 1 (hook):**
ApeWisdom has a dashboard. StockTwits has a feed. Verity has skills.

Six callable endpoints your AI agent can invoke before it ever recommends a trade. The pre-trade check most AI workflows are missing.

mcp.verityskills.com

**Tweet 2 (problem):**
Every AI workflow I see checks price, volume, technicals.

None of them check whether the narrative driving the move is real.

Coordinated activity moves tickers. Disinformation moves tickers. Your model has no idea.

**Tweet 3 (solution):**
We just shipped an MCP server.

POST a ticker, get a structured verdict in under two seconds.

Was the run-up organic? Did coordinated accounts amplify the thesis? Is anything in the bull narrative cross-checked against authoritative sources?

**Tweet 4 (tools list):**
The six callable skills:

→ coordination-heat (anonymous, free)
→ verity-score
→ morning-brief
→ verity-scan
→ cross-check-alert
→ disinfo-alert

First one is anonymous. Hit it from curl. The other five need an API key.

**Tweet 5 (install):**
Add to Claude Desktop:

```
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

Restart Claude. Type "use verity-score on NVDA". Done.

**Tweet 6 (architecture):**
Architecture: Cloudflare Worker as a thin bearer-token proxy.

JSON-RPC 2.0 over HTTP. Zero state. Zero DB credentials. ~1000 LOC TypeScript with three property-tested predicates and 237 unit/integration tests.

Open source: github.com/cchurctrip/verity-mcp

**Tweet 7 (thesis):**
The dashboard era is ending.

We used to log into Twilio dashboards to send SMS. Now SMS is an API call.
We used to visit Stripe dashboards to charge a card. Now payments are an API call.

Manipulation detection is the next category that becomes an API call.

**Tweet 8 (CTA):**
Try the anonymous coordination-heat skill against any ticker in your watchlist.

curl -sS -X POST https://mcp.verityskills.com/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"coordination-heat","arguments":{"subject":"GME"}}}'

---

## Posting plan

- Post the thread on Tuesday or Wednesday, 10am ET (highest finance-Twitter engagement window).
- Reply to the first 5 comments within 30 minutes.
- Cross-post tweet 1 to LinkedIn (without the thread; the LinkedIn essay covers it).
- DM the thread to 10 hand-picked AI-trading audience accounts who've engaged with similar content recently.
- Pin the thread to the Verity X profile for 7 days.

## Variants

If the first thread underperforms (under 1k impressions in first 4 hours), reframe as a single tweet pointing at the LinkedIn essay. Different audiences different formats.

## Engagement hooks to set up before posting

- Be ready to reply with: "Here's what the structured verdict looks like" + a Claude Desktop screenshot.
- Be ready to reply with: "Yeah, here's how it differs from Graphika at $100k/year." Have the comparison table copy-pastable.
- Be ready for: "Doesn't Bloomberg do this?" Have the 30-second elevator answer rehearsed.
- Be ready for: "How do you detect manipulation from public APIs?" Don't promise specifics; point at the source-cross-checking methodology.

## Tone notes

- No emoji on Tuesday-launch posts. Save them for follow-up engagement.
- Em-dashes already scrubbed. Use periods.
- Don't lead with pricing in any tweet (turns into a "is it worth $499/mo" debate that distracts from the technical reveal).
