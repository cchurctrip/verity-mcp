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
  // VRT-160: success-shape with `status` discriminator per VRT-159.
  // verity-scan has a single success branch (no degenerate case).
  outputSchema: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['ok'] },
      tickers_checked: { type: 'array', items: { type: 'string' } },
      scan_window_hours: { type: 'number' },
      anomalies: { type: 'array' },
      clean: { type: 'array', items: { type: 'string' } },
      anomaly_count: { type: 'number' },
      scanned_at: { type: 'string' },
    },
    required: ['status', 'tickers_checked', 'anomalies', 'clean', 'anomaly_count', 'scanned_at'],
  },
  requiresAuth: true,
  upstreamPath: '/api/skills/verity-scan',
} as const satisfies Tool;