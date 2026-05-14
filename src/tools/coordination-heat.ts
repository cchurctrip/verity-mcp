import type { Tool } from './index';

export const coordinationHeat: Tool = {
  name: 'coordination-heat',
  description:
    'Detect coordinated activity around a topic, ticker, or narrative across public social platforms. Returns an intensity score with contributing source signals. Anonymous use permitted for public market subjects.',
  inputSchema: {
    type: 'object',
    properties: {
      subject: {
        type: 'string',
        description:
          'Ticker symbol, topic phrase, or named narrative to score. Examples: GME, "AI energy demand", "Iran ceasefire".',
      },
      window_hours: {
        type: 'integer',
        minimum: 1,
        maximum: 168,
        description:
          'Lookback window in hours. Defaults to 24 if omitted.',
      },
    },
    required: ['subject'],
    additionalProperties: false,
  },
  requiresAuth: false,
  upstreamPath: '/api/skills/coordination-heat',
};
