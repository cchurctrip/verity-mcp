// Unit tests for src/auth.ts.
//
// parseBearer is the pure string-level function; tested against raw inputs (including
// values that WHATWG Headers would normalize away). readBearer is the Request-level
// tri-state classifier; tested through Request + Headers so the production code path
// is exercised end-to-end.

import { describe, expect, it } from 'vitest';
import { parseBearer, readBearer, type BearerResult } from '../src/auth';

function reqWith(authValue: string | null): Request {
  const headers = new Headers();
  if (authValue !== null) headers.set('Authorization', authValue);
  return new Request('http://example.com/mcp', { method: 'POST', headers });
}

describe('parseBearer happy path', () => {
  it('extracts the raw token from canonical Bearer vtk_<alphanumeric>', () => {
    expect(parseBearer('Bearer vtk_abc123XYZ')).toBe('vtk_abc123XYZ');
  });

  it('extracts a short token', () => {
    expect(parseBearer('Bearer vtk_a')).toBe('vtk_a');
  });

  it('extracts a long token (256 alphanumeric chars)', () => {
    const long = 'a'.repeat(256);
    expect(parseBearer(`Bearer vtk_${long}`)).toBe(`vtk_${long}`);
  });
});

describe('parseBearer rejections (raw-string inputs that bypass Headers normalization)', () => {
  it('returns null on empty input', () => {
    expect(parseBearer('')).toBeNull();
  });

  it('returns null on lowercase bearer prefix', () => {
    expect(parseBearer('bearer vtk_abc')).toBeNull();
  });

  it('returns null on uppercase BEARER prefix', () => {
    expect(parseBearer('BEARER vtk_abc')).toBeNull();
  });

  it('returns null on double-space separator between prefix and token', () => {
    expect(parseBearer('Bearer  vtk_abc')).toBeNull();
  });

  it('returns null on trailing CRLF (Headers strips this; defense-in-depth at parseBearer)', () => {
    expect(parseBearer('Bearer vtk_abc\r\n')).toBeNull();
  });

  it('returns null on trailing newline only', () => {
    expect(parseBearer('Bearer vtk_abc\n')).toBeNull();
  });

  it('returns null on trailing space', () => {
    expect(parseBearer('Bearer vtk_abc ')).toBeNull();
  });

  it('returns null on leading whitespace', () => {
    expect(parseBearer(' Bearer vtk_abc')).toBeNull();
  });

  it('returns null on non-alphanumeric token chars', () => {
    expect(parseBearer('Bearer vtk_abc+def')).toBeNull();
    expect(parseBearer('Bearer vtk_abc-def')).toBeNull();
    expect(parseBearer('Bearer vtk_abc/def')).toBeNull();
    expect(parseBearer('Bearer vtk_abc.def')).toBeNull();
    expect(parseBearer('Bearer vtk_abc_def')).toBeNull();
  });

  it('returns null when token prefix is not vtk_', () => {
    expect(parseBearer('Bearer abc123')).toBeNull();
    expect(parseBearer('Bearer VTK_abc')).toBeNull();
    expect(parseBearer('Bearer vtk-abc')).toBeNull();
  });

  it('returns null when token body is empty (vtk_ alone has zero alphanumeric chars)', () => {
    expect(parseBearer('Bearer vtk_')).toBeNull();
  });

  it('returns null on garbage', () => {
    expect(parseBearer('garbage')).toBeNull();
  });
});

describe('readBearer tri-state classifier', () => {
  it('returns { kind: "absent" } when no Authorization header', () => {
    const result: BearerResult = readBearer(reqWith(null));
    expect(result.kind).toBe('absent');
  });

  it('returns { kind: "valid", token } for canonical Bearer vtk_<token>', () => {
    const result = readBearer(reqWith('Bearer vtk_abc123XYZ'));
    expect(result.kind).toBe('valid');
    if (result.kind === 'valid') {
      expect(result.token).toBe('vtk_abc123XYZ');
    }
  });

  it('returns { kind: "invalid" } on malformed Bearer (lowercase prefix)', () => {
    expect(readBearer(reqWith('bearer vtk_abc')).kind).toBe('invalid');
  });

  it('returns { kind: "invalid" } on malformed Bearer (double space)', () => {
    expect(readBearer(reqWith('Bearer  vtk_abc')).kind).toBe('invalid');
  });

  it('returns { kind: "invalid" } on malformed Bearer (non-alphanumeric chars)', () => {
    expect(readBearer(reqWith('Bearer vtk_abc+def')).kind).toBe('invalid');
  });

  it('returns { kind: "invalid" } on non-vtk_ prefix', () => {
    expect(readBearer(reqWith('Bearer abc123')).kind).toBe('invalid');
  });

  it('returns { kind: "invalid" } on garbage Authorization value', () => {
    expect(readBearer(reqWith('garbage')).kind).toBe('invalid');
  });

  it('returns { kind: "invalid" } on empty-string Authorization (header present, value empty)', () => {
    // Pins finding R5: empty string is "present but malformed" (regex miss), NOT "absent".
    // A future runtime change that normalizes empty -> absent would silently flip this
    // from 401 INVALID_BEARER_FORMAT to anonymous proxy; this test catches the regression.
    expect(readBearer(reqWith('')).kind).toBe('invalid');
  });

  it('readBearer.valid token never contains the Bearer prefix (coupling #8: hash equality)', () => {
    // Main repo lib/apiKeyAuth.ts hashApiKey() SHA-256s the raw vtk_ string. If readBearer
    // ever returned the full match (Bearer vtk_*) instead of capture group 1 (vtk_*), the
    // upstream x-verity-key hash compare would fail for every valid token.
    const result = readBearer(reqWith('Bearer vtk_abc123'));
    expect(result.kind).toBe('valid');
    if (result.kind === 'valid') {
      expect(result.token.startsWith('Bearer')).toBe(false);
      expect(result.token.startsWith('vtk_')).toBe(true);
    }
  });

  it('TypeScript exhaustiveness check: kind narrows correctly in switch', () => {
    // Smoke check that the discriminated union narrows properly. If the type definition
    // ever changes (e.g., adds a fourth kind), this switch becomes non-exhaustive and
    // the compiler will flag it.
    const result = readBearer(reqWith('Bearer vtk_abc'));
    let label = '';
    switch (result.kind) {
      case 'absent':
        label = 'absent';
        break;
      case 'invalid':
        label = 'invalid';
        break;
      case 'valid':
        label = result.token;
        break;
    }
    expect(label).toBe('vtk_abc');
  });
});
