# LinkedIn essay draft (Angle 9 long form)

**Headline:** The next $100M software companies won't look like SaaS companies. Here's what they look like.

**Body (about 600 words, LinkedIn algorithm-optimized for the 1500-character preview cut):**

The dashboard era is ending.

ApeWisdom is a page you visit. StockTwits is a feed you scroll. Bloomberg is a terminal you sit at for ten hours a day. These are all places. Places that you go to in order to do work.

The next generation of trading tools doesn't look like that. It looks like a function call.

When I built Verity, I had a choice. We could build the dashboard. Charts, alerts, watchlists, the whole product surface. Or we could build skills: discrete callable endpoints that any AI agent could invoke from inside its workflow. POST a ticker, get a structured verdict. The manipulation check your AI workflow was missing.

We chose skills.

Here's the bet: in the skills era, the product that embeds in your stack wins. Dashboards become commodities. Skills become infrastructure.

Consider the workflow of a fund running Claude for Teams. Their analyst types: "Should we increase our NVDA position?" Claude thinks for thirty seconds, pulls earnings, scans sentiment, checks technicals. Then what? Right now: the trade goes through to compliance review, eventually to execution. The manipulation layer is missing entirely. A coordinated narrative could have driven the move; nobody checked.

With Verity skills, the workflow inserts one call. `/verity-scan NVDA`. Returns a structured verdict in under two seconds. Was the narrative driving this organic? Did coordinated activity precede the move? Is any of the bull thesis sourced from disinformation patterns? The trade doesn't fire until Verity clears it.

This is the same thing that happened to other infrastructure categories. We used to log into Twilio dashboards to send SMS. Now SMS is an API call. We used to visit Stripe dashboards to charge a card. Now payments are an API call. Verity is the same shape for manipulation detection.

We just launched the MCP server: mcp.verityskills.com.

Six callable skills. The first one (coordination-heat) is anonymous and free; you can hit it right now with curl. The other five are gated behind our Pro and Fund tiers.

Connect from Claude Desktop in three lines of config. Connect from Cursor in two. Connect from any LangChain or LlamaIndex agent in a few. The same endpoint serves every AI runtime that supports MCP. We didn't have to build six adapters; we built one server and the ecosystem connects.

Three things this opens up:

First, asymmetric advantages for traders running AI-assisted workflows. Right now you can pay Bloomberg $24k/year for one trader's seat. Or you can wire Verity into your Claude workflow and every signal it generates gets manipulation-checked before it hits your execution layer.

Second, audit trails for compliance. Every Verity call returns a verdict with sources and a confidence score. Fund tier subscribers get the API timestamps automatically logged for compliance review. The same workflow your trader runs, your compliance officer can replay.

Third, defensibility through workflow embedding. A dashboard you visit can be replaced with another dashboard. A skill embedded in your daily prompt cannot.

If you're building AI workflows for trading desks or running them yourself, point your agent at mcp.verityskills.com. Try `coordination-heat` on a ticker you're watching. Then ask yourself whether the manipulation layer should be in your stack.

The dashboard era is ending. The skill era starts now.

---

## Posting plan

- **Day 1 (launch day)**: post at 8am ET, comment from author account within 5 min, like 5-10 comments to bump engagement.
- **Day 2**: comment-thread response to top 3 comments. Include a screenshot of a Claude Desktop conversation invoking verity-score.
- **Day 7**: follow-up post with usage data ("We've had X agents invoke skills since launch") if metrics are interesting; skip if not.

## Audience targeting

LinkedIn organic reach is segmented. This post is aimed at:
- AI workflow builders (Cursor, Cline, Claude users in fintech and trading)
- Quant fund engineers (the buyers of Pro and Fund tiers)
- Compliance officers (the secondary buyer for Fund tier)
- AI-curious finance Twitter / LinkedIn audience (broad awareness)

Avoid:
- Generic "AI is the future" framing (post will get skipped)
- Naming specific competitors (Bloomberg is fine; Graphika / Cyabra naming might trigger their LinkedIn comms)
- Implying Verity is a regulated entity or financially credentialed (Brand Rule)

## Variants

If the long-form post doesn't perform in the first 4 hours, repost as a short-form 200-word version with the same Angle 9 hook ("ApeWisdom has a dashboard. Verity has skills."). LinkedIn rewards shorter posts in algorithm cycles after the first reach window decays.
