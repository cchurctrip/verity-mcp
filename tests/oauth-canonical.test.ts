// Unit + property tests for src/oauth-canonical.ts.
//
// The audience-canonical comparator is the hot path for the MCP 2025-06-18
// audience-binding rule. The arch review R8 test #3 mandates a property
// test on 100 random non-matching audience values; this file holds it.

import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import {
  CANONICAL_RESOURCE_URI,
  isCanonicalEquivalentResource,
  isCanonicalResourceUri,
} from '../src/oauth-canonical';

describe('isCanonicalResourceUri positive', () => {
  it('accepts the canonical bare-origin URI', () => {
    expect(isCanonicalResourceUri(CANONICAL_RESOURCE_URI)).toBe(true);
  });

  it('accepts mixed-case host (URL parser case-folds)', () => {
    expect(isCanonicalResourceUri('https://MCP.VerityskiLLs.com')).toBe(true);
  });

  it('accepts mixed-case scheme (URL parser lowercases)', () => {
    expect(isCanonicalResourceUri('HTTPS://mcp.verityskills.com')).toBe(true);
  });

  it('accepts explicit default port 443 (URL parser strips)', () => {
    expect(isCanonicalResourceUri('https://mcp.verityskills.com:443')).toBe(true);
  });
});

describe('isCanonicalResourceUri negative', () => {
  it('rejects empty / null / undefined', () => {
    expect(isCanonicalResourceUri('')).toBe(false);
    expect(isCanonicalResourceUri(null)).toBe(false);
    expect(isCanonicalResourceUri(undefined)).toBe(false);
  });

  it('rejects trailing slash (path differs)', () => {
    expect(isCanonicalResourceUri('https://mcp.verityskills.com/')).toBe(false);
  });

  it('rejects a path component', () => {
    expect(isCanonicalResourceUri('https://mcp.verityskills.com/oauth')).toBe(false);
  });

  it('rejects a query string', () => {
    expect(isCanonicalResourceUri('https://mcp.verityskills.com?x=1')).toBe(false);
  });

  it('rejects a fragment', () => {
    expect(isCanonicalResourceUri('https://mcp.verityskills.com#frag')).toBe(false);
  });

  it('rejects http (wrong scheme)', () => {
    expect(isCanonicalResourceUri('http://mcp.verityskills.com')).toBe(false);
  });

  it('rejects a different host', () => {
    expect(isCanonicalResourceUri('https://api.verityskills.com')).toBe(false);
  });

  it('rejects a non-URL string', () => {
    expect(isCanonicalResourceUri('not a uri')).toBe(false);
    expect(isCanonicalResourceUri('mcp.verityskills.com')).toBe(false);
  });

  it('property: 100 random non-canonical inputs all reject', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          // Random non-URL strings
          fc.string({ minLength: 1, maxLength: 100 }),
          // URL-shaped strings with a wrong host
          fc
            .string({ minLength: 1, maxLength: 30 })
            .filter((s) => s.length > 0 && !/[\s/?#]/.test(s))
            .map((host) => `https://${host}.example.com`),
          // Canonical host with a random path
          fc
            .string({ minLength: 1, maxLength: 30 })
            .filter((s) => s.length > 0 && !/\s/.test(s))
            .map((p) => `https://mcp.verityskills.com/${encodeURIComponent(p)}`),
        ),
        (candidate) => {
          // The property: the only canonical input is the bare origin (or
          // the case-folded equivalent we accept). Reject the rare false
          // positive from a fuzzed input that happens to land on that.
          if (candidate.toLowerCase() === 'https://mcp.verityskills.com') return true;
          return !isCanonicalResourceUri(candidate);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('isCanonicalEquivalentResource (#25 part 7: SDK trailing-slash form)', () => {
  it('accepts the canonical bare-origin URI', () => {
    expect(isCanonicalEquivalentResource(CANONICAL_RESOURCE_URI)).toBe(true);
  });

  it('accepts the trailing-slash form (the variant SDK clients emit)', () => {
    // `new URL("https://mcp.verityskills.com").href` returns
    // `"https://mcp.verityskills.com/"` per WHATWG URL §4.5. mcp-remote
    // and the official @modelcontextprotocol/sdk both emit `.href`
    // when constructing the `resource` param on /authorize and
    // /oauth/token, so we must accept this form at both entry points.
    expect(isCanonicalEquivalentResource('https://mcp.verityskills.com/')).toBe(true);
  });

  it('accepts mixed-case host', () => {
    expect(isCanonicalEquivalentResource('https://MCP.VerityskiLLs.com')).toBe(true);
    expect(isCanonicalEquivalentResource('https://MCP.VerityskiLLs.com/')).toBe(true);
  });

  it('accepts explicit default port 443', () => {
    expect(isCanonicalEquivalentResource('https://mcp.verityskills.com:443')).toBe(true);
  });

  it('rejects empty / null / undefined', () => {
    expect(isCanonicalEquivalentResource('')).toBe(false);
    expect(isCanonicalEquivalentResource(null)).toBe(false);
    expect(isCanonicalEquivalentResource(undefined)).toBe(false);
  });

  it('rejects a deeper path beyond bare slash', () => {
    expect(isCanonicalEquivalentResource('https://mcp.verityskills.com/oauth')).toBe(false);
    expect(isCanonicalEquivalentResource('https://mcp.verityskills.com/mcp')).toBe(false);
  });

  it('rejects a query string', () => {
    expect(isCanonicalEquivalentResource('https://mcp.verityskills.com?x=1')).toBe(false);
  });

  it('rejects a fragment', () => {
    expect(isCanonicalEquivalentResource('https://mcp.verityskills.com#frag')).toBe(false);
  });

  it('rejects http (wrong scheme)', () => {
    expect(isCanonicalEquivalentResource('http://mcp.verityskills.com')).toBe(false);
    expect(isCanonicalEquivalentResource('http://mcp.verityskills.com/')).toBe(false);
  });

  it('rejects a different host', () => {
    expect(isCanonicalEquivalentResource('https://api.verityskills.com')).toBe(false);
    expect(isCanonicalEquivalentResource('https://evil.example.com/')).toBe(false);
  });

  it('rejects userinfo', () => {
    expect(isCanonicalEquivalentResource('https://user:pass@mcp.verityskills.com')).toBe(false);
    expect(isCanonicalEquivalentResource('https://user@mcp.verityskills.com/')).toBe(false);
  });

  it('rejects a non-URL string', () => {
    expect(isCanonicalEquivalentResource('not a uri')).toBe(false);
    expect(isCanonicalEquivalentResource('mcp.verityskills.com')).toBe(false);
  });
});
