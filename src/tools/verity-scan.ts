import type { Tool } from './index';

export const verityScan = {
  name: 'verity-scan',
  description:
    'Real-time scan of a topic, ticker, or claim. Returns a structured verdict an agent can use as a pre-trade check before any significant position. The trade does not fire until the scan clears it.',
  inputSchema: {
    type: 'object',
    properties: {
      subject: {
        type: 'string',
        description:
          'Ticker symbol, topic phrase, or short claim to scan. Examples: AAPL, "Fed pause priced in", "OPEC cut announcement".',
      },
    },
    required: ['subject'],
    additionalProperties: false,
  },
  requiresAuth: true,
  upstreamPath: '/api/skills/verity-scan',
} as const satisfies Tool;