import type { Tool } from './index';

export const coordinationHeat = {
  name: 'coordination-heat',
  description:
    'Score a topic, ticker, or narrative for coordinated activity across public social platforms. Distinguishes organic chatter from manufactured campaigns: identical phrasing across many posts, new-account clusters, synchronized posting windows. Returns a heat score with a band and the contributing signal counts.',
  inputSchema: {
    type: 'object',
    properties: {
      subject: {
        type: 'string',
        description:
          'Ticker symbol, topic phrase, or named narrative to score. Examples: GME, "AI energy demand", "Iran ceasefire".',
      },
    },
    required: ['subject'],
    additionalProperties: false,
  },
  requiresAuth: true,
  upstreamPath: '/api/skills/coordination-score',
} as const satisfies Tool;
