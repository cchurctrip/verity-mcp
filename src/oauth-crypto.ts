// OAuth crypto helpers for the VRT-166 Phase 1 token endpoint.
//
// Three primitives, all built on Web Crypto so they run in the Cloudflare
// Workers runtime without polyfills:
//
//   sha256Hex(input)             SHA-256 of a UTF-8 string, hex-encoded.
//                                Used to hash codes + access tokens + refresh
//                                tokens before storage. Matches the existing
//                                vtk_* convention in the parent repo
//                                (lib/apiKeyAuth.ts:hashApiKey).
//   verifyPkceS256(verifier, challenge)
//                                RFC 7636 S256 verification: base64url-encoded
//                                SHA-256 of the verifier MUST equal the
//                                stored challenge. Constant-time comparison
//                                to avoid timing leaks.
//   randomTokenSuffix(byteLen)   Cryptographically random URL-safe alphanumeric
//                                token suffix. Used for vto_<suffix> access
//                                tokens and the opaque refresh tokens.
//
// All three are pure (no state, no IO) so the property tests in
// tests/oauth-crypto.test.ts can exercise them deterministically by stubbing
// the seeded inputs.
//
// PKCE notes:
//   - RFC 7636 §4.2: code_verifier is 43-128 chars from the set
//     [A-Z][a-z][0-9]-._~. We accept the spec range; shorter or out-of-charset
//     verifiers fail verification with PKCE_MISMATCH rather than a separate
//     INVALID_REQUEST so the error surface stays uniform.
//   - RFC 7636 §4.6: S256 transform is BASE64URL-ENCODE(SHA256(ASCII(verifier))).
//     We compute the BASE64URL form (no '=' padding, '-' and '_' substitutions)
//     and constant-time-compare against the stored challenge.

const BASE62 =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/**
 * SHA-256 of a UTF-8 string, returned as 64 lowercase hex chars. The hashed
 * form is what gets stored in mcp_oauth_codes.code_hash, mcp_oauth_tokens
 * .token_hash, and mcp_oauth_refresh_tokens.token_hash. Raw tokens never
 * touch the DB.
 */
export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(digest);
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i]!.toString(16).padStart(2, '0');
  }
  return out;
}

/**
 * RFC 7636 §4.6 S256 verification. Returns true iff
 * BASE64URL(SHA-256(verifier)) === challenge. Constant-time compare on the
 * computed digest bytes; we still walk the full compare loop when lengths
 * differ to keep the upper-bound timing equal for the matching-length case.
 */
export async function verifyPkceS256(
  verifier: string,
  challenge: string,
): Promise<boolean> {
  // RFC 7636 charset + length check. Out-of-range still produces a
  // verifier-digest that almost-certainly will not match a stored
  // challenge, but rejecting early saves a SubtleCrypto call and avoids
  // exposing the digest to a malformed input path.
  if (verifier.length < 43 || verifier.length > 128) return false;
  for (let i = 0; i < verifier.length; i++) {
    const c = verifier.charCodeAt(i);
    const isAlpha =
      (c >= 0x41 && c <= 0x5a) || // A-Z
      (c >= 0x61 && c <= 0x7a);   // a-z
    const isDigit = c >= 0x30 && c <= 0x39;
    const isUnreserved = c === 0x2d || c === 0x2e || c === 0x5f || c === 0x7e; // - . _ ~
    if (!isAlpha && !isDigit && !isUnreserved) return false;
  }

  const data = new TextEncoder().encode(verifier);
  const digestBuf = await crypto.subtle.digest('SHA-256', data);
  const computed = base64urlNoPad(new Uint8Array(digestBuf));
  return constantTimeStringEquals(computed, challenge);
}

/**
 * Cryptographically random alphanumeric suffix. The default 32 bytes gives
 * 192 bits of entropy after base62 encoding, well above the OAuth 2.1
 * recommended >= 128 bits for access + refresh tokens (RFC 6749 §10.10).
 *
 * Output character set is [A-Za-z0-9] (no symbols) so the token is safe to
 * embed in URLs, headers, and JSON without quoting. Matches the existing
 * vtk_* convention (alphanumeric body).
 */
export function randomTokenSuffix(byteLen: number = 32): string {
  if (byteLen < 16) {
    // Fail loud rather than silently mint low-entropy tokens. Any future
    // call site under 16 bytes is almost certainly a bug; the floor matches
    // OAuth 2.1 minimum entropy for non-guessable tokens.
    throw new Error(`randomTokenSuffix: byteLen ${byteLen} below 16-byte floor`);
  }
  const bytes = new Uint8Array(byteLen);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += BASE62[bytes[i]! % 62];
  }
  return out;
}

/**
 * URL-safe base64 (RFC 4648 §5) without trailing '=' padding. Used to encode
 * the SHA-256 PKCE digest in S256 verification.
 */
function base64urlNoPad(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  // btoa is available in the Workers runtime.
  const b64 = btoa(bin);
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Constant-time string equality on strings of equal length. Walks the full
 * loop even on length-mismatch (returning the mismatch verdict after) so
 * timing depends on max-length only. Used for PKCE digest comparison.
 */
function constantTimeStringEquals(a: string, b: string): boolean {
  const maxLen = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < maxLen; i++) {
    diff |= (a.charCodeAt(i) ?? 0) ^ (b.charCodeAt(i) ?? 0);
  }
  return diff === 0;
}
