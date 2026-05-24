// Unit + property tests for the VRT-166 vto_ branch of src/auth.ts.
//
// The arch review R7 mandates a property test asserting the two regexes
// (vtk_ and vto_) are mutually exclusive on any input. With distinct
// three-character prefixes (vtk_ vs vto_) the proof is structural; the
// property test pins the invariant against any future regex weakening.

import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { parseBearer, parseOauthBearer, readBearer, type BearerResult } from '../src/auth';

function reqWith(authValue: string | null): Request {
  const headers = new Headers();
  if (authValue !== null) headers.set('Authorization', authValue);
  return new Request('http://example.com/mcp', { method: 'POST', headers });
}

const ALNUM = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const alnumChar = fc.constantFrom(...ALNUM.split(''));
const alnumString = (minLen: number, maxLen: number) =>
  fc.array(alnumChar, { minLength: minLen, maxLength: maxLen }).map((arr) => arr.join(''));

describe('parseOauthBearer happy path', () => {
  it('extracts the raw token from canonical Bearer vto_<alphanumeric>', () => {
    expect(parseOauthBearer('Bearer vto_abc123XYZ')).toBe('vto_abc123XYZ');
  });

  it('extracts a short oauth token', () => {
    expect(parseOauthBearer('Bearer vto_a')).toBe('vto_a');
  });

  it('extracts a long oauth token (256 alphanumeric chars)', () => {
    const long = 'a'.repeat(256);
    expect(parseOauthBearer(`Bearer vto_${long}`)).toBe(`vto_${long}`);
  });
});

describe('parseOauthBearer rejections', () => {
  it('returns null on empty input', () => {
    expect(parseOauthBearer('')).toBeNull();
  });

  it('returns null on lowercase bearer prefix', () => {
    expect(parseOauthBearer('bearer vto_abc')).toBeNull();
  });

  it('returns null on trailing CRLF / LF / space', () => {
    expect(parseOauthBearer('Bearer vto_abc\r\n')).toBeNull();
    expect(parseOauthBearer('Bearer vto_abc\n')).toBeNull();
    expect(parseOauthBearer('Bearer vto_abc ')).toBeNull();
  });

  it('returns null on non-alphanumeric token chars', () => {
    expect(parseOauthBearer('Bearer vto_abc+def')).toBeNull();
    expect(parseOauthBearer('Bearer vto_abc-def')).toBeNull();
    expect(parseOauthBearer('Bearer vto_abc_def')).toBeNull();
  });

  it('returns null when token prefix is not vto_', () => {
    expect(parseOauthBearer('Bearer vtk_abc')).toBeNull();
    expect(parseOauthBearer('Bearer VTO_abc')).toBeNull();
  });

  it('returns null when token body is empty (vto_ alone)', () => {
    expect(parseOauthBearer('Bearer vto_')).toBeNull();
  });
});

describe('readBearer four-state classifier', () => {
  it('returns { kind: "valid_oauth_token", token } for canonical Bearer vto_<token>', () => {
    const result: BearerResult = readBearer(reqWith('Bearer vto_abc123'));
    expect(result.kind).toBe('valid_oauth_token');
    if (result.kind === 'valid_oauth_token') {
      expect(result.token).toBe('vto_abc123');
    }
  });

  it('returns { kind: "valid", token } for canonical Bearer vtk_<token> (regression)', () => {
    const result = readBearer(reqWith('Bearer vtk_abc123'));
    expect(result.kind).toBe('valid');
    if (result.kind === 'valid') {
      expect(result.token).toBe('vtk_abc123');
    }
  });

  it('returns { kind: "invalid" } when both regexes miss', () => {
    expect(readBearer(reqWith('Bearer vts_abc')).kind).toBe('invalid');
    expect(readBearer(reqWith('Bearer abc123')).kind).toBe('invalid');
  });

  it('valid_oauth_token token never carries Bearer prefix', () => {
    const result = readBearer(reqWith('Bearer vto_abc123'));
    expect(result.kind).toBe('valid_oauth_token');
    if (result.kind === 'valid_oauth_token') {
      expect(result.token.startsWith('Bearer')).toBe(false);
      expect(result.token.startsWith('vto_')).toBe(true);
    }
  });

  it('exhaustive switch compiles for all four variants', () => {
    const result = readBearer(reqWith('Bearer vto_abc'));
    let label = '';
    switch (result.kind) {
      case 'absent':
        label = 'absent';
        break;
      case 'invalid':
        label = 'invalid';
        break;
      case 'valid':
        label = `user:${result.token}`;
        break;
      case 'valid_oauth_token':
        label = `oauth:${result.token}`;
        break;
    }
    expect(label).toBe('oauth:vto_abc');
  });
});

describe('vtk_ and vto_ regex mutual exclusion (arch review R7)', () => {
  it('property: no Bearer-shaped input parses as both a vtk_ and a vto_ token', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 100 }), (input) => {
        const u = parseBearer(input);
        const o = parseOauthBearer(input);
        // Mutual exclusion: at most one of the two regexes matches.
        return !(u !== null && o !== null);
      }),
      { numRuns: 1000 },
    );
  });

  it('property: 1000 random alphanumeric Bearer suffixes route deterministically', () => {
    fc.assert(
      fc.property(alnumString(1, 64), (suffix) => {
        const userInput = `Bearer vtk_${suffix}`;
        const oauthInput = `Bearer vto_${suffix}`;

        expect(parseBearer(userInput)).toBe(`vtk_${suffix}`);
        expect(parseOauthBearer(userInput)).toBeNull();

        expect(parseBearer(oauthInput)).toBeNull();
        expect(parseOauthBearer(oauthInput)).toBe(`vto_${suffix}`);
      }),
      { numRuns: 1000 },
    );
  });
});
