import type { Tool } from './index';

export const morningBrief = {
  name: 'morning-brief',
  description:
    'Daily briefing of overnight signals across a watchlist. Aggregates coordination shifts, narrative changes, and integrity flags into one structured report ready to drop into a morning prep workflow.',
  inputSchema: {
    type: 'object',
    properties: {
      watchlist: {
        type: 'array',
        items: { type: 'string' },
        maxItems: 50,
        description:
          'List of tickers or topic phrases. Optional. Omit to use your default watchlist.',
      },
      date: {
        type: 'string',
        format: 'date',
        description:
          'Briefing date in YYYY-MM-DD form. Optional. Defaults to the current trading day.',
      },
    },
    required: [],
    additionalProperties: false,
  },
  requiresAuth: true,
  upstreamPath: '/api/skills/morning-brief',
} as const satisfies Tool;