// Bearer extraction for inbound MCP requests.
//
// Contract (per VRT-146a spec hidden couplings #1, #7, #8 and VRT-166 arch
// review R7):
//
//   readBearer(req).kind === 'absent'             no Authorization header
//                                                    caller forwards with no x-verity-key; upstream
//                                                    returns its own 401 for every tool (all six now
//                                                    back authenticated operations).
//   readBearer(req).kind === 'valid'              canonical Bearer vtk_<alphanumeric token>
//                                                    (user-issued API key path; existing semantics)
//                                                    caller sets x-verity-key with result.token
//                                                    (no Bearer prefix on the upstream side, since
//                                                    cchurctrip/verity:lib/apiKeyAuth.ts hashApiKey()
//                                                    SHA-256s the raw token).
//   readBearer(req).kind === 'valid_oauth_token'  canonical Bearer vto_<alphanumeric token>
//                                                    (OAuth-issued access token path; VRT-166)
//                                                    caller hashes the token, looks up
//                                                    mcp_oauth_tokens, validates aud_uri equals
//                                                    https://mcp.verityskills.com, resolves to
//                                                    user_id, then forwards upstream with
//                                                    x-verity-user-id: <uuid>. NEVER as
//                                                    x-verity-key: vto_* (MCP 2025-06-18 token
//                                                    passthrough is forbidden).
//   readBearer(req).kind === 'invalid'            Authorization header present but malformed
//                                                    (neither regex matches: lowercase prefix,
//                                                    non-vtk_/vto_ token, non-alphanumeric chars,
//                                                    trailing whitespace, etc.)
//                                                    caller returns 401 INVALID_BEARER_FORMAT at the
//                                                    Worker edge. Do NOT forward upstream.
//
// The discriminated-union return forces the consumer to handle all four states. A previous
// (string | null) shape collapsed 'absent' and 'invalid' into the same return value, making
// the silent-anonymous-downgrade pattern easy to write by accident. Multiple parallel reviewers
// flagged this convergently on PR #2; see DIFFERENTIAL_REVIEW_REPORT_PR2.md finding R1.
//
// Two strict regexes, one per prefix:
//
//   /^Bearer (vtk_[A-Za-z0-9]+)(?![\s\S])/  for the existing user-API-key path
//   /^Bearer (vto_[A-Za-z0-9]+)(?![\s\S])/  for the new OAuth-token path
//
// Both anchored with the (?![\s\S]) negative-lookahead end-of-input. The default JS $ anchor
// matches before a trailing newline when the /m flag is added; (?![\s\S]) is unconditional and
// rejects any trailing character. Property test in tests/auth.property.test.ts fuzzes both
// regexes against arbitrary strings, alphanumeric tokens with trailing contaminants, and inputs
// up to 50KB. The two prefixes (vtk_ / vto_) differ on the third character, so the property test
// asserts mutual exclusion across 1000 random alphanumeric inputs (arch review R7).
//
// Scar tissue: feedback_js_regex_dollar_end_anchor_newline.md from Verity PR #404 iter 3.

const BEARER_USER_KEY_REGEX = /^Bearer (vtk_[A-Za-z0-9]+)(?![\s\S])/;
const BEARER_OAUTH_TOKEN_REGEX = /^Bearer (vto_[A-Za-z0-9]+)(?![\s\S])/;

export type BearerResult =
  | { kind: 'absent' }
  | { kind: 'invalid' }
  | { kind: 'valid'; token: string }
  | { kind: 'valid_oauth_token'; token: string };

// parseBearer is the pure-function contract on raw strings for the user-API-key path.
// Exported so property tests can exercise inputs that WHATWG Headers would otherwise
// normalize (leading/trailing whitespace and CRLF are stripped at the Headers.set/get
// boundary).
export function parseBearer(authValue: string): string | null {
  const match = authValue.match(BEARER_USER_KEY_REGEX);
  return match ? (match[1] ?? null) : null;
}

// parseOauthBearer is the pure-function contract on raw strings for the OAuth-token path.
// Same exhaustive contract as parseBearer, anchored on the vto_ prefix instead.
export function parseOauthBearer(authValue: string): string | null {
  const match = authValue.match(BEARER_OAUTH_TOKEN_REGEX);
  return match ? (match[1] ?? null) : null;
}

// readBearer is the Request-level four-state classifier. Use this from the dispatcher.
// The consumer pattern is:
//
//   const b = readBearer(req);
//   switch (b.kind) {
//     case 'invalid':           return invalidBearerFormat();
//     case 'absent':            return forwardWithoutKey();              // upstream returns its own 401
//     case 'valid':             return forwardAuthedUserKey(b.token);    // x-verity-key
//     case 'valid_oauth_token': return forwardAuthedOauth(b.token);      // hash + lookup + x-verity-user-id
//   }
//
// TypeScript exhaustiveness checking on the kind discriminator forces the consumer to
// handle every state. If a future bearer family needs a distinct policy that becomes a
// switch-statement edit, not a regex change.
//
// Dispatch order: try the user-key regex first (existing path, hot in cache), then the
// OAuth regex. The two prefixes are mutually exclusive on the third character so the
// order is correctness-irrelevant; the user-key-first choice is performance only.
export function readBearer(req: Request): BearerResult {
  const auth = req.headers.get('authorization');
  if (auth === null) return { kind: 'absent' };
  const userKeyToken = parseBearer(auth);
  if (userKeyToken !== null) return { kind: 'valid', token: userKeyToken };
  const oauthToken = parseOauthBearer(auth);
  if (oauthToken !== null) return { kind: 'valid_oauth_token', token: oauthToken };
  return { kind: 'invalid' };
}
