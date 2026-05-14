import type { Tool } from './index';

export const verityScore: Tool = {
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
  requiresAuth: true,
  upstreamPath: '/api/skills/verity-score',
};
