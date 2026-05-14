import type { Tool } from './index';

export const disinfoAlert = {
  name: 'disinfo-alert',
  description:
    'Flag potential disinformation patterns and coordinated narratives around a topic or ticker. Returns evidence patterns, source diversity, and pattern strength so a workflow can act on the verdict.',
  inputSchema: {
    type: 'object',
    properties: {
      subject: {
        type: 'string',
        description:
          'Ticker symbol, topic phrase, or named narrative to monitor. Examples: TSLA, "AI bubble", "election fraud claims".',
      },
      severity_threshold: {
        type: 'string',
        enum: ['low', 'medium', 'high'],
        description:
          'Minimum pattern strength to include. Defaults to medium when omitted.',
      },
    },
    required: ['subject'],
    additionalProperties: false,
  },
  requiresAuth: true,
  upstreamPath: '/api/skills/disinfo-alert',
} as const satisfies Tool;