// Unit + property tests for src/oauth-crypto.ts.
//
// PKCE S256 (RFC 7636) is the load-bearing primitive here: the property test
// asserts that for any random verifier the only challenge that verifies is
// the actual base64url(sha256(verifier)). Negative property: 100 random
// non-matching challenges all reject.

import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { randomTokenSuffix, sha256Hex, verifyPkceS256 } from '../src/oauth-crypto';

// RFC 7636 charset: unreserved [A-Z][a-z][0-9]-._~
const PKCE_CHARSET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~';
const pkceVerifierChar = fc.constantFrom(...PKCE_CHARSET.split(''));
const pkceVerifier = (minLen: number, maxLen: number) =>
  fc.array(pkceVerifierChar, { minLength: minLen, maxLength: maxLen }).map((arr) => arr.join(''));

// Helper: compute the canonical S256 challenge for a verifier, so tests can
// pin the positive case without re-implementing the primitive.
async function s256Challenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(digest);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  const b64 = btoa(bin);
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

describe('sha256Hex', () => {
  it('returns 64 lowercase hex chars for any input', () => {
    return fc.assert(
      fc.asyncProperty(fc.string({ minLength: 0, maxLength: 256 }), async (s) => {
        const out = await sha256Hex(s);
        expect(out).toMatch(/^[0-9a-f]{64}$/);
      }),
    );
  });

  it('matches known SHA-256 fixture for empty string', async () => {
    // Independent oracle: SHA-256("") = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
    expect(await sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('matches known SHA-256 fixture for "abc"', async () => {
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('verifyPkceS256 positive', () => {
  it('returns true for the canonical S256 challenge of any RFC 7636 verifier', async () => {
    await fc.assert(
      fc.asyncProperty(pkceVerifier(43, 128), async (verifier) => {
        const challenge = await s256Challenge(verifier);
        return verifyPkceS256(verifier, challenge);
      }),
      { numRuns: 30 },
    );
  });
});

describe('verifyPkceS256 negative', () => {
  it('returns false for a verifier outside the RFC 7636 length range (too short)', async () => {
    expect(await verifyPkceS256('short', 'unused')).toBe(false);
  });

  it('returns false for a verifier outside the RFC 7636 length range (too long)', async () => {
    expect(await verifyPkceS256('x'.repeat(129), 'unused')).toBe(false);
  });

  it('returns false for a verifier with an out-of-charset character', async () => {
    // "+" is not in the RFC 7636 unreserved set.
    const verifier = 'a'.repeat(43).split('');
    verifier[10] = '+';
    expect(await verifyPkceS256(verifier.join(''), 'unused')).toBe(false);
  });

  it('rejects 100 random non-matching challenges for any verifier', async () => {
    await fc.assert(
      fc.asyncProperty(
        pkceVerifier(43, 128),
        fc.string({ minLength: 10, maxLength: 64 }),
        async (verifier, wrongChallenge) => {
          // Avoid the rare case where the random wrongChallenge happens to be
          // the canonical one (vanishingly improbable, but pin the property).
          const real = await s256Challenge(verifier);
          if (wrongChallenge === real) return true;
          return !(await verifyPkceS256(verifier, wrongChallenge));
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('randomTokenSuffix', () => {
  it('returns a string of the requested length in [A-Za-z0-9]', () => {
    for (const len of [16, 24, 32, 48, 64]) {
      const tok = randomTokenSuffix(len);
      expect(tok.length).toBe(len);
      expect(tok).toMatch(/^[A-Za-z0-9]+$/);
    }
  });

  it('throws for byteLen below the 16-byte entropy floor', () => {
    expect(() => randomTokenSuffix(8)).toThrow(/byteLen 8 below 16-byte floor/);
  });

  it('produces unique values across 1000 rapid calls', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(randomTokenSuffix(32));
    expect(seen.size).toBe(1000);
  });
});
