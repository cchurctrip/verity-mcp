import type { Tool } from './index';

// maxItems below is pinned to the upstream Pro-tier watchlist ceiling
// (currently 50). Upstream derives its max from the Pro watchlist tier
// limit, so this Worker number MUST equal that tier value. If the upstream
// Pro watchlist tier limit changes, this literal has to change in lockstep
// or a marketplace consumer that builds a form/validator off this schema
// will silently diverge from what upstream accepts. Do not bump one without
// the other.
const MORNING_BRIEF_MAX_WATCHLIST = 50;

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
        minItems: 1,
        maxItems: MORNING_BRIEF_MAX_WATCHLIST,
        description:
          'Tickers or topic phrases to brief on. Required: a non-empty list.',
      },
    },
    required: ['watchlist'],
    additionalProperties: false,
  },
  // VRT-160: success-shape with `status` discriminator per VRT-159.
  // morning-brief has a single success branch.
  outputSchema: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['ok'] },
      variant: { type: 'string' },
      subject: { type: 'string' },
      tickers: { type: 'array' },
      asof: { type: 'string' },
    },
    required: ['status', 'variant', 'subject', 'tickers', 'asof'],
  },
  requiresAuth: true,
  upstreamPath: '/api/skills/morning-brief',
} as const satisfies Tool;
