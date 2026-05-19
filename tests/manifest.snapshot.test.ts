// Forbidden-string snapshot enforcing Brand Rule #2.
//
// Every string that ends up on a user-facing or marketplace-facing surface
// must stay free of:
//   - file paths (`lib/`, `app/`, `supabase/`)
//   - TypeScript / runtime identifiers (`getEffectiveLimits`, `hashApiKey`,
//     `TRIAL_CAP_REACHED`)
//   - story IDs (`VRT-`)
//   - implementation prose (`Supabase`, `PostgREST`, `Cloudflare Worker`,
//     `JSON-RPC`)
//
// Surfaces covered:
//   - manifest.json: top-level description, every tool entry description,
//     auth.obtain_url string is exempt (it is a URL by design).
//   - src/tools/*.ts Tool.description fields (everything in TOOLS[].description).
//
// Also enforces order + size invariants:
//   - manifest.json.tools length === 6 and names + order match TOOLS[].
//   - Every TOOLS[].requiresAuth matches the manifest entry.

import { describe, expect, it } from 'vitest';
import { TOOLS } from '../src/tools';
import { TOOL_ROUTES } from '../src/upstream';
import manifest from '../manifest.json';

const FORBIDDEN_SUBSTRINGS: ReadonlyArray<string> = [
  // File paths
  'lib/',
  'app/',
  'supabase/',
  // TS / runtime identifiers
  'getEffectiveLimits',
  'hashApiKey',
  'TRIAL_CAP_REACHED',
  // Story IDs
  'VRT-',
  // Implementation prose
  'Supabase',
  'PostgREST',
  'Cloudflare Worker',
  'JSON-RPC',
];

function assertCleanDescription(surface: string, value: string): void {
  for (const token of FORBIDDEN_SUBSTRINGS) {
    expect(value, `${surface} contains forbidden token "${token}"`).not.toContain(token);
  }
}

describe('Brand Rule #2: manifest.json descriptions stay free of implementation surface', () => {
  it('top-level manifest description is clean', () => {
    assertCleanDescription('manifest.description', manifest.description);
  });

  it('every manifest tool description is clean', () => {
    for (const t of manifest.tools) {
      assertCleanDescription(`manifest.tools[${t.name}].description`, t.description);
    }
  });
});

describe('Brand Rule #2: src/tools/*.ts descriptions stay free of implementation surface', () => {
  it('every TOOLS[].description is clean', () => {
    for (const t of TOOLS) {
      assertCleanDescription(`TOOLS[${t.name}].description`, t.description);
    }
  });

  it('every TOOLS[].inputSchema property description is also clean', () => {
    for (const t of TOOLS) {
      const schema = t.inputSchema as { properties?: Record<string, { description?: string }> };
      for (const [propName, prop] of Object.entries(schema.properties ?? {})) {
        if (typeof prop.description === 'string') {
          assertCleanDescription(`TOOLS[${t.name}].inputSchema.${propName}.description`, prop.description);
        }
      }
    }
  });
});

describe('Marketplace schema invariants (manifest <-> TOOLS parity)', () => {
  it('manifest.tools and TOOLS have the same 6 names in the same order', () => {
    const manifestNames = manifest.tools.map((t) => t.name);
    const codeNames = TOOLS.map((t) => t.name);
    expect(manifestNames).toEqual(codeNames);
    expect(manifestNames).toHaveLength(6);
  });

  it('manifest.tools[].requires_auth matches TOOLS[].requiresAuth', () => {
    const codeMap = new Map<string, boolean>(TOOLS.map((t) => [t.name, t.requiresAuth] as const));
    for (const t of manifest.tools) {
      expect(codeMap.get(t.name), `${t.name} requires_auth`).toBe(t.requires_auth);
    }
  });

  it('manifest.auth.anonymous_tools matches the !requiresAuth tools in TOOLS', () => {
    const codeAnon = TOOLS.filter((t) => !t.requiresAuth).map((t) => t.name).sort();
    const manifestAnon = [...manifest.auth.anonymous_tools].sort();
    expect(manifestAnon).toEqual(codeAnon);
  });

  it('manifest.mcp_spec_version matches src/mcp.ts PROTOCOL_VERSION', async () => {
    const mcp = await import('../src/mcp');
    expect(manifest.mcp_spec_version).toBe(mcp.PROTOCOL_VERSION);
  });

  // Parity between TOOLS (registry consumed by tools/list) and TOOL_ROUTES
  // (dispatch table consumed by proxyToolCall). 3-lens convergent finding:
  // a future contributor adding a tool to only one of the two would compile
  // clean today and silently break dispatch at runtime. This test makes the
  // drift a unit-test failure.
  it('TOOLS names match TOOL_ROUTES keys (registry-dispatch parity)', () => {
    const codeNames = TOOLS.map((t) => t.name).sort();
    const routeNames = Object.keys(TOOL_ROUTES).sort();
    expect(codeNames).toEqual(routeNames);
  });

  it('each TOOLS[].upstreamPath matches the corresponding TOOL_ROUTES entry', () => {
    for (const t of TOOLS) {
      // Cast through Record because TOOL_ROUTES is the satisfies-narrowed
      // literal whose keys are not `string`. The test is the cross-check.
      const route = (TOOL_ROUTES as Readonly<Record<string, string>>)[t.name];
      expect(t.upstreamPath, `${t.name} upstreamPath`).toBe(route);
    }
  });
});

describe('Tool inputSchema invariants (Brand Rule #2 + marketplace contract)', () => {
  it('every inputSchema declares type=object, additionalProperties=false, and a required array', () => {
    for (const t of TOOLS) {
      const schema = t.inputSchema as unknown as {
        type?: string;
        properties?: Record<string, unknown>;
        required?: readonly string[];
        additionalProperties?: boolean;
      };
      expect(schema.type, `${t.name}.inputSchema.type`).toBe('object');
      expect(schema.additionalProperties, `${t.name}.inputSchema.additionalProperties`).toBe(false);
      expect(Array.isArray(schema.required), `${t.name}.inputSchema.required`).toBe(true);
      expect(schema.properties, `${t.name}.inputSchema.properties`).toBeTruthy();
    }
  });

  it('inputSchema.required snapshot for marketplace stability', () => {
    // Marketplace consumers may build forms or argument validators off the
    // required arrays. Pinning these prevents silent regressions when a
    // future PR makes a previously-required field optional or vice versa.
    const snapshot = TOOLS.map((t) => [
      t.name,
      (t.inputSchema as { required: readonly string[] }).required,
    ]);
    expect(snapshot).toEqual([
      ['coordination-heat', ['subject']],
      ['verity-score', ['subject']],
      ['morning-brief', ['watchlist']],
      ['verity-scan', ['subject']],
      ['cross-check-alert', ['claim']],
      ['disinfo-alert', ['subject', 'severity_threshold']],
    ]);
  });
});
