// Unit tests for src/auth.ts.
//
// parseBearer is tested against raw strings (including inputs that WHATWG
// Headers would normalize away). extractBearer is tested through Request +
// Headers (the production code path). hasAuthHeader is also Request-level.

import { describe, expect, it } from 'vitest';
import { extractBearer, hasAuthHeader, parseBearer } from '../src/auth';

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

describe('extractBearer (Request-level integration)', () => {
  it('extracts canonical Bearer vtk_<token>', () => {
    expect(extractBearer(reqWith('Bearer vtk_abc123XYZ'))).toBe('vtk_abc123XYZ');
  });

  it('returns null when no Authorization header', () => {
    expect(extractBearer(reqWith(null))).toBeNull();
  });

  it('returns null on malformed Authorization header values that survive Headers normalization', () => {
    expect(extractBearer(reqWith('bearer vtk_abc'))).toBeNull();
    expect(extractBearer(reqWith('Bearer  vtk_abc'))).toBeNull();
    expect(extractBearer(reqWith('Bearer vtk_abc+def'))).toBeNull();
    expect(extractBearer(reqWith('garbage'))).toBeNull();
  });
});

describe('hasAuthHeader', () => {
  it('returns true when Authorization header is set to a canonical token', () => {
    expect(hasAuthHeader(reqWith('Bearer vtk_abc'))).toBe(true);
  });

  it('returns true when Authorization header is malformed (still present)', () => {
    expect(hasAuthHeader(reqWith('garbage'))).toBe(true);
  });

  it('returns false when Authorization header is absent', () => {
    expect(hasAuthHeader(reqWith(null))).toBe(false);
  });
});
