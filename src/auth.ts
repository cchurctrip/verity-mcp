// Bearer extraction for inbound MCP requests.
//
// Contract (per VRT-146a spec hidden couplings #1, #7, #8):
//
//   readBearer(req).kind === 'absent'   -> no Authorization header
//                                            caller forwards with no x-verity-key; upstream
//                                            returns its own 401 for every tool (all six now
//                                            back authenticated operations).
//   readBearer(req).kind === 'valid'    -> canonical Bearer vtk_<alphanumeric token>
//                                            caller sets x-verity-key with result.token
//                                            (no Bearer prefix on the upstream side, since
//                                            cchurctrip/verity:lib/apiKeyAuth.ts hashApiKey()
//                                            SHA-256s the raw token).
//   readBearer(req).kind === 'invalid'  -> Authorization header present but malformed
//                                            (regex miss: lowercase prefix, non-vtk_ token,
//                                            non-alphanumeric chars, etc.)
//                                            caller returns 401 INVALID_BEARER_FORMAT at the
//                                            Worker edge. Do NOT forward upstream.
//
// The discriminated-union return forces the consumer to handle all three states. A previous
// (string | null) shape collapsed 'absent' and 'invalid' into the same return value, making
// the silent-anonymous-downgrade pattern easy to write by accident. Multiple parallel reviewers
// flagged this convergently on PR #2; see DIFFERENTIAL_REVIEW_REPORT_PR2.md finding R1.
//
// Strict regex: ^Bearer (vtk_[A-Za-z0-9]+) anchored with a negative-lookahead end-of-input
// (?![\s\S]). The default JS $ anchor matches before a trailing newline when the /m flag is
// added; (?![\s\S]) is unconditional and rejects any trailing character. Property test in
// tests/auth.property.test.ts fuzzes this against arbitrary strings, alphanumeric tokens with
// trailing contaminants, and inputs up to 50KB. Scar tissue:
// feedback_js_regex_dollar_end_anchor_newline.md from Verity PR #404 iter 3.

const BEARER_REGEX = /^Bearer (vtk_[A-Za-z0-9]+)(?![\s\S])/;

export type BearerResult =
  | { kind: 'absent' }
  | { kind: 'invalid' }
  | { kind: 'valid'; token: string };

// parseBearer is the pure-function contract on raw strings. Exported so property tests
// can exercise inputs that WHATWG Headers would otherwise normalize (leading/trailing
// whitespace and CRLF are stripped at the Headers.set/get boundary).
export function parseBearer(authValue: string): string | null {
  const match = authValue.match(BEARER_REGEX);
  return match ? (match[1] ?? null) : null;
}

// readBearer is the Request-level tri-state classifier. Use this from the dispatcher.
// The consumer pattern is:
//
//   const b = readBearer(req);
//   switch (b.kind) {
//     case 'invalid': return invalidBearerFormat();
//     case 'absent':  return forwardWithoutKey(); // upstream returns its own 401
//     case 'valid':   return forwardAuthed(b.token);
//   }
//
// TypeScript exhaustiveness checking on the kind discriminator forces the consumer to
// handle every state. If a future tool needs a distinct absent-key policy that becomes
// a switch-statement edit, not a regex change.
export function readBearer(req: Request): BearerResult {
  const auth = req.headers.get('authorization');
  if (auth === null) return { kind: 'absent' };
  const token = parseBearer(auth);
  return token === null ? { kind: 'invalid' } : { kind: 'valid', token };
}
