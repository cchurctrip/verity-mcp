# VRT-165 multi-client transport: live-deploy verification

**Date**: 2026-05-21
**Live deploy**: `mcp.verityskills.com`
**Wrangler version ID**: `a5fc5144-fbaa-4546-bbe2-fc17b2b19169`
**Worker commit (/health)**: `39bb5a7d6eaa814608d940eb8fd16ba3b542e617`
**Spec**: `cchurctrip/verity` `mydocs/specs/2026-05-21_VRT-165_multi-client-transport.md`
**Impl PR**: `cchurctrip/verity-mcp` #14 (merged 2026-05-21T20:46:17Z)

## Probe matrix (9 / 9 pass)

`scripts/multi-client-probe.sh https://mcp.verityskills.com` against the live deploy returned 9 of 9. Each probe corresponds to a target client class.

| # | Probe | Client class | Method + Accept | Expected | Result |
|---|---|---|---|---|---|
| 1 | Cursor no Accept header | Cursor | POST /mcp (no Accept) | application/json | PASS |
| 2 | Cursor Accept: */* | Cursor | POST /mcp Accept: */* | application/json | PASS |
| 3 | Cursor Accept: application/json | Cursor | POST /mcp Accept: application/json | application/json | PASS |
| 4 | Claude Desktop default Accept | Claude Desktop (native HTTP) | POST /mcp Accept: */* | application/json | PASS |
| 5 | ChatGPT Desktop Streamable HTTP | ChatGPT Desktop | POST /mcp Accept: text/event-stream | text/event-stream + one `event: message` + close, no `event: done` | PASS |
| 6 | ChatGPT spec-canonical | ChatGPT Desktop | POST /mcp Accept: application/json, text/event-stream | text/event-stream | PASS |
| 7 | Gemini Streamable HTTP | Gemini Enterprise / AI Studio / Vertex / CLI | POST /mcp Accept: text/event-stream;q=0.9, application/json | text/event-stream + event: message | PASS |
| 8 | Comet GET /sse handshake | Perplexity Comet | GET /sse | text/event-stream + `event: endpoint` with `data: https://mcp.verityskills.com/sse` (absolute URL per Gate-2 R3) | PASS |
| 9 | Comet POST /sse cross-isolate fallback | Perplexity Comet | POST /sse (no open same-isolate GET) | 200 + application/json + envelope inline (MCP 2024-11-05 6.2.2 fallback) | PASS |

## /health snapshot

```json
{
  "status": "ok",
  "commit": "39bb5a7d6eaa814608d940eb8fd16ba3b542e617",
  "uptime_s": 0,
  "kill_switch_engaged": false
}
```

## Vitest e2e suite

`npx vitest run --project e2e` against the live deploy returned 19 of 20 passing. The 1 failing case (`live contract: 6 tools vs mcp.verityskills.com > coordination-heat returns the subject-score shape`) is a **pre-existing** test-fixture issue introduced by VRT-160 (the status discriminator) and unrelated to VRT-165. The route correctly returns `status: "insufficient_data"` when the 2-hour signal window is empty; the test pinned only the `status: "ok"` shape. Filed as a follow-up (separate from this PR).

## Manual per-client end-to-end (owner action)

The transport surface is verified at the network level by the 9-probe matrix above. Confirming the actual MCP client UIs round-trip through their respective install paths requires the owner's machine. The expected paths are:

- **Claude Desktop**: paste the snippet from `docs/CLAUDE_DESKTOP.md` into `claude_desktop_config.json`, fully quit Claude (Cmd-Q), relaunch, invoke `verity-score NVDA`. Native HTTP transport on Claude Desktop 2026 builds; `mcp-remote` stdio bridge as the fallback for older builds.
- **ChatGPT Desktop**: add custom connector at `https://mcp.verityskills.com/mcp`, invoke `verity-score`. Streamable HTTP direct.
- **Perplexity Comet**: paste manifest URL or `https://mcp.verityskills.com/sse` in Comet MCP settings, invoke any tool. Legacy SSE bridge.
- **Gemini (AI Studio)**: add MCP server at `https://mcp.verityskills.com/mcp` (Streamable HTTP only per Gate-2 R4), invoke any tool.

## Follow-ups filed (not blocking marketplace submission)

- silent-failure-hunter MEDIUM 2: openStreams map TTL/LRU eviction. Bounded by isolate lifetime today; promote to follow-up if production traffic shows map growth.
- code-reviewer HIGH 1: POST /sse double-parses bearer + recomputes sha256 once per relay attempt. Sub-millisecond CPU cost; refactor would change `handleMcpRequest` signature.
- type-design: brand `BearerHash` opaque-string type; wrap `OpenStreamEntry` in a dispose() class for centralized cleanup.
- pr-test-analyzer 3.1: deterministic same-isolate 202 relay test (would need a new test-helper API).
- pre-existing live-contract.test.ts coordination-heat status-discriminator branch.
- pre-existing post-deploy-smoke.sh `kill_switch_engaged` jq `// empty` bug (strips `false` value; assertion never passes on a healthy worker).

## Sign-off

The live transport surface for VRT-165 is verified. VRT-149h (marketplace submissions) is unblocked pending owner go-ahead.
