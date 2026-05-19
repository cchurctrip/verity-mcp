import type { Tool } from './index';

export const crossCheckAlert = {
  name: 'cross-check-alert',
  description:
    'Cross-reference a claim against monitored sources and flag inconsistencies. Returns matched citations, cross-source conflicts, and a confidence verdict (CORROBORATED, CONFLICTED, UNVERIFIED, or NO_SIGNAL) suitable for a compliance trail.',
  inputSchema: {
    type: 'object',
    properties: {
      claim: {
        type: 'string',
        maxLength: 500,
        description:
          'A specific testable statement to verify. Example: "BlackRock filed for a spot Solana ETF on 2026-03-12".',
      },
      sources: {
        type: 'array',
        items: { type: 'string' },
        maxItems: 20,
        description:
          'Optional preferred sources to weight higher. Pass canonical domains, like reuters.com or sec.gov.',
      },
    },
    required: ['claim'],
    additionalProperties: false,
  },
  requiresAuth: true,
  upstreamPath: '/api/skills/cross-check-claim',
} as const satisfies Tool;
