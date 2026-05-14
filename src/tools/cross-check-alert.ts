import type { Tool } from './index';

export const crossCheckAlert = {
  name: 'cross-check-alert',
  description:
    'Cross-reference a claim against authoritative sources and flag inconsistencies. Returns matched citations, source conflicts, and a confidence verdict suitable for compliance trails.',
  inputSchema: {
    type: 'object',
    properties: {
      claim: {
        type: 'string',
        description:
          'A specific testable statement to verify. Example: "BlackRock filed for a spot Solana ETF on 2026-03-12".',
      },
      sources: {
        type: 'array',
        items: { type: 'string' },
        maxItems: 10,
        description:
          'Optional preferred sources to weight higher. Pass canonical domains, like reuters.com or sec.gov.',
      },
    },
    required: ['claim'],
    additionalProperties: false,
  },
  requiresAuth: true,
  upstreamPath: '/api/skills/cross-check-alert',
} as const satisfies Tool;