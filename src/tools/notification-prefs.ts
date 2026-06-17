import type { Tool } from './index';

// VRT-210e: the notification-prefs MCP tool. Forwards to the parent repo's
// notification-preferences endpoint (TOOL_ROUTES['notification-prefs']). The
// tool's arguments are forwarded as the request body byte-identical, so the
// { action, prefs } input shape maps straight onto the upstream contract.
// requiresAuth: true -> the OAuth path (x-verity-user-id + shared secret) or a
// vtk_* key resolves the account upstream; no anonymous access.
//
// Brand Rule #2: description + property descriptions stay free of file paths,
// identifiers, story IDs, and implementation prose (asserted by
// tests/manifest.snapshot.test.ts).
export const notificationPrefs = {
  name: 'notification-prefs',
  description:
    'Read or change which Verity emails you receive: the daily brief, the market pulse, anomaly alerts, the weekly digest, and product news. Turn any category off, or turn one back on. Account and billing messages are always sent and are not controlled here.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['get', 'set'],
        description: "Use 'get' to read your current preferences, or 'set' to change them.",
      },
      prefs: {
        type: 'object',
        description:
          "Only for 'set'. List each category you want to change, mapped to true to receive it or false to stop it.",
        properties: {
          morning_brief: { type: 'boolean', description: 'Your daily watchlist brief and the Sunday week-ahead outlook.' },
          market_pulse: { type: 'boolean', description: 'The daily market-wide read.' },
          alerts: { type: 'boolean', description: 'Alerts when Verity flags coordinated activity on a ticker you follow.' },
          weekly_digest: { type: 'boolean', description: 'Periodic summaries such as the monthly wrap-up.' },
          product_marketing: { type: 'boolean', description: 'Occasional product and feature updates.' },
        },
        additionalProperties: false,
      },
    },
    required: ['action'],
    additionalProperties: false,
  },
  requiresAuth: true,
  upstreamPath: '/api/mcp/notification-prefs',
} as const satisfies Tool;
