import type { Tool } from './index';

export const verityScore = {
  name: 'verity-score',
  description:
    'Composite integrity score for a market subject. Returns a 0 to 100 score with contributing factor weights so an analyst can decide whether a thesis is grounded before committing capital.',
  inputSchema: {
    type: 'object',
    properties: {
      subject: {
        type: 'string',
        description:
          'Ticker symbol or topic phrase to score. Examples: NVDA, "Bitcoin ETF flows", "Tesla robotaxi launch".',
      },
    },
    required: ['subject'],
    additionalProperties: false,
  },
  // VRT-160: discriminated union on `status` per VRT-159. Consumers branch on
  // status to handle every success case exhaustively. `type: "object"` lives at
  // the ROOT alongside `oneOf` because the official @modelcontextprotocol/sdk
  // ToolSchema (chunk-65X3S4HB.js:11857 in mcp-remote 0.1.37; identical Zod
  // schema in Cursor 1.x's MCP client and Claude Desktop) requires
  // `outputSchema.type === "object"` as a literal at the root. Without it,
  // strict Zod validation drops the entire tools/list response and the client
  // surfaces zero tools even though the connection itself is healthy. The
  // outer schema is `.catchall(unknown())` so the `oneOf` discriminator passes
  // through untouched and JSON Schema applies it as an implicit allOf against
  // the base `type: "object"`. Issue #25 part 8 (Cursor 0-tools regression).
  outputSchema: {
    type: 'object',
    oneOf: [
      {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['ok'] },
          ticker: { type: 'string' },
          score: { type: 'number' },
          breakdown: { type: 'object' },
          explanation: { type: 'string' },
          asof: { type: 'string' },
        },
        required: ['status', 'ticker', 'score', 'explanation', 'asof'],
      },
      {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['insufficient_data'] },
          ticker: { type: 'string' },
          score: { type: 'null' },
          explanation: { type: 'string' },
          asof: { type: ['string', 'null'] },
        },
        required: ['status', 'ticker', 'score', 'explanation', 'asof'],
      },
    ],
  },
  requiresAuth: true,
  upstreamPath: '/api/skills/verity-score',
} as const satisfies Tool;