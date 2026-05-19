import type { Tool } from './index';

export const disinfoAlert = {
  name: 'disinfo-alert',
  description:
    'Monitor a topic or ticker for ongoing disinformation patterns and coordinated narratives. Scores recent signals against detection rules, filters by a severity threshold, and returns the detected patterns, source diversity, and a summary so a workflow can act on the verdict.',
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
          'Minimum pattern strength to include. Required: one of low, medium, or high.',
      },
    },
    required: ['subject', 'severity_threshold'],
    additionalProperties: false,
  },
  requiresAuth: true,
  upstreamPath: '/api/skills/disinfo-monitor',
} as const satisfies Tool;
