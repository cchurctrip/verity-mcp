# Verity MCP Server

Public MCP (Model Context Protocol) server for [Verity](https://verityskills.com) skills.

Production endpoint: `https://mcp.verityskills.com`

## Connect your MCP client

1. Get an API key at [verityskills.com/account/api-keys](https://verityskills.com/account/api-keys).
2. Configure your MCP client:
   - Server URL: `https://mcp.verityskills.com/mcp`
   - Authentication: `Authorization: Bearer <your-vtk_-token>`
   - Transport: HTTP+SSE
3. The `coordination-heat` tool accepts anonymous requests. The other five require a token.

## Available skills

| Tool | Auth | Capability |
|---|---|---|
| `coordination-heat` | Anonymous OK | Detect coordinated activity around a topic. |
| `verity-score` | Required | Composite integrity signal. |
| `morning-brief` | Required | Daily summary of relevant signals. |
| `verity-scan` | Required | Real-time scan of a topic, ticker, or claim. |
| `cross-check-alert` | Required | Cross-reference a claim against authoritative sources. |
| `disinfo-alert` | Required | Flag potential disinformation patterns. |

## Marketplace listings

- PulseMCP
- Smithery
- Glama
- MCP.so

## Operations

Deploy + rotate + observe instructions live in the parent repo at [`docs/mcp-runbook.md`](https://github.com/cchurctrip/verity/blob/main/docs/mcp-runbook.md).

Server health: `GET https://mcp.verityskills.com/health`.

## License

MIT. See [LICENSE](./LICENSE).
