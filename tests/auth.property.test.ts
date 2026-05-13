// Property-based fuzz tests for src/auth.ts.
//
// One of the three Gate 4 (property-based test) targets from VRT-146a spec.
// Tests parseBearer (pure function on strings) rather than extractBearer so
// inputs are exercised without WHATWG Headers normalization stripping
// leading/trailing whitespace and CRLF. The Headers layer is the runtime's
// first line of defense; parseBearer is the second.

import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { parseBearer } from '../src/auth';

const ALNUM = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const alphanumericChar = fc.constantFrom(...ALNUM.split(''));
const alphanumericString = (minLength: number, maxLength: number) =>
  fc.array(alphanumericChar, { minLength, maxLength }).map((arr) => arr.join(''));

describe('parseBearer property: only canonical inputs return non-null', () => {
  it('result is non-null iff input matches the canonical bearer pattern exactly', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 1024 }), (input) => {
        const result = parseBearer(input);
        const canonical = /^Bearer vtk_[A-Za-z0-9]+$/.test(input);
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

describe('parseBearer property: DoS resistance on long inputs', () => {
  it('returns null in bounded time for very long non-matching inputs (up to 50KB)', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 10_000, maxLength: 50_000 }), (input) => {
        const canonical = /^Bearer vtk_[A-Za-z0-9]+$/.test(input);
        const result = parseBearer(input);
        return canonical ? result !== null : result === null;
      }),
      { numRuns: 20 },
    );
  });
});
