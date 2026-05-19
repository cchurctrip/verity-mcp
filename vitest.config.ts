import { defineWorkersProject } from '@cloudflare/vitest-pool-workers/config';
import { defineConfig } from 'vitest/config';

// Two test projects:
//
//  - "workers": every existing unit / property / integration test runs in
//    the Cloudflare Workers pool (Miniflare isolate), exactly as before. It
//    explicitly excludes tests/e2e so the live contract tests do not run in
//    the sandboxed isolate (Miniflare blocks arbitrary outbound network and
//    does not expose Node process.env).
//
//  - "e2e": the live contract tests run in the plain Node environment so
//    they can make real network calls to mcp.verityskills.com and read the
//    integration-test API key from process.env. They self-skip when the
//    secret is absent (CI without the secret stays green).
const workersProject = defineWorkersProject({
  test: {
    name: 'workers',
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/e2e/**', 'node_modules/**'],
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.toml' },
      },
    },
  },
});

export default defineConfig({
  test: {
    projects: [
      workersProject,
      {
        test: {
          name: 'e2e',
          environment: 'node',
          include: ['tests/e2e/**/*.test.ts'],
        },
      },
    ],
  },
});
