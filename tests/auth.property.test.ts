// Property-based fuzz tests for src/auth.ts.
//
// One of the three Gate 4 (property-based test) targets from VRT-146a spec
// (mydocs/specs/2026-05-13_VRT-146a_mcp_worker.md). The spec names extractBearer
// as the property-test target; the implementation fuzzes parseBearer instead so
// inputs are exercised without WHATWG Headers normalization stripping
// leading/trailing whitespace and CRLF before the regex sees them. This is a
// deliberate spec deviation: the Headers layer is the runtime's first line of
// defense; parseBearer is the second and must be exercised against raw inputs.

import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { parseBearer } from '../src/auth';

const ALNUM = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const alphanumericChar = fc.constantFrom(...ALNUM.split(''));
const alphanumericString = (minLength: number, maxLength: number) =>
  fc.array(alphanumericChar, { minLength, maxLength }).map((arr) => arr.join(''));

// Independent oracle: hand-written predicate that mirrors the spec prose rather
// than the production regex. If the regex in src/auth.ts is ever weakened
// (e.g., the (?![\s\S]) end anchor is dropped or /m flag added), this oracle
// stays correct and the property test catches the drift. Using the production
// regex as oracle would be tautological.
function isCanonicalBearer(input: string): boolean {
  const PREFIX = 'Bearer vtk_';
  if (!input.startsWith(PREFIX)) return false;
  const tokenBody = input.slice(PREFIX.length);
  if (tokenBody.length === 0) return false;
  for (const ch of tokenBody) {
    if (!/[A-Za-z0-9]/.test(ch)) return false;
  }
  return true;
}

describe('parseBearer property: only canonical inputs return non-null', () => {
  it('result is non-null iff input matches the canonical bearer pattern', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 1024 }), (input) => {
        const result = parseBearer(input);
        const canonical = isCanonicalBearer(input);
        if (result === null) {
          return !canonical;
        }
        return canonical && result === input.slice('Bearer '.length);
      }),
    );
  });

  it('canonical inputs round-trip: extracted token matches the substring after the Bearer prefix', () => {
    fc.assert(
      fc.property(alphanumericString(1, 64), (suffix) => {
        const input = `Bearer vtk_${suffix}`;
        expect(parseBearer(input)).toBe(`vtk_${suffix}`);
      }),
    );
  });

  it('extracted tokens never carry the Bearer prefix (coupling #8: hash equality)', () => {
    fc.assert(
      fc.property(alphanumericString(1, 64), (suffix) => {
        const result = parseBearer(`Bearer vtk_${suffix}`);
        return result !== null && !result.startsWith('Bearer') && result.startsWith('vtk_');
      }),
    );
  });
});

describe('parseBearer property: contaminated inputs are rejected', () => {
  it('rejects canonical pattern with trailing whitespace, control char, or newline', () => {
    fc.assert(
      fc.property(
        alphanumericString(1, 32),
        fc.constantFrom('\n', '\r\n', '\r', '\t', ' ', '\0', '\x7f'),
        (suffix, contaminant) => {
          expect(parseBearer(`Bearer vtk_${suffix}${contaminant}`)).toBeNull();
        },
      ),
    );
  });

  it('rejects canonical pattern with leading whitespace or control char', () => {
    fc.assert(
      fc.property(
        alphanumericString(1, 32),
        fc.constantFrom('\n', '\r\n', '\t', ' ', '\0', '\x7f'),
        (suffix, contaminant) => {
          expect(parseBearer(`${contaminant}Bearer vtk_${suffix}`)).toBeNull();
        },
      ),
    );
  });

  it('rejects canonical pattern with any internal non-alphanumeric char in the token', () => {
    fc.assert(
      fc.property(
        alphanumericString(1, 16),
        fc.constantFrom('+', '-', '_', '/', '.', '=', '@', '!', '#', '$', '%', '&', '*'),
        alphanumericString(1, 16),
        (prefix, contaminant, suffix) => {
          expect(parseBearer(`Bearer vtk_${prefix}${contaminant}${suffix}`)).toBeNull();
        },
      ),
    );
  });
});

describe('parseBearer property: long-input correctness (regex is structurally O(n))', () => {
  it('returns null for very long non-matching inputs up to 50KB', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 10_000, maxLength: 50_000 }), (input) => {
        const canonical = isCanonicalBearer(input);
        const result = parseBearer(input);
        return canonical ? result !== null : result === null;
      }),
      { numRuns: 20 },
    );
  });
});
