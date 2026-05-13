// Bearer extraction for inbound MCP requests.
//
// Contract (per VRT-146a spec hidden couplings #1, #7, #8):
//
//   No Authorization header                -> hasAuthHeader = false; extractBearer = null
//                                              (caller forwards anonymously for coordination-heat,
//                                               returns 401 at upstream for the other five tools)
//   Authorization present + canonical      -> hasAuthHeader = true;  extractBearer = "vtk_..."
//                                              (caller sets x-verity-key with the raw token,
//                                               no Bearer prefix per lib/apiKeyAuth.ts:15-17 hash equality)
//   Authorization present + regex miss     -> hasAuthHeader = true;  extractBearer = null
//                                              (caller returns 401 INVALID_BEARER_FORMAT at the Worker edge)
//
// Strict regex: ^Bearer (vtk_[A-Za-z0-9]+) anchored with a negative-lookahead
// end-of-input. JS regex $ can match before a trailing newline in some
// engines, which would leak CRLF into the upstream x-verity-key header and
// (worse) into hash-equality compare in the main repo. The (?![\s\S]) anchor
// rejects any character past the token, including \r, \n, control chars,
// and embedded whitespace. Property test in tests/auth.property.test.ts
// fuzzes this against arbitrary strings, alphanumeric tokens with trailing
// contaminants, and very long inputs.

const BEARER_REGEX = /^Bearer (vtk_[A-Za-z0-9]+)(?![\s\S])/;

// parseBearer is the pure-function contract. extractBearer is a Request-level
// convenience that fetches the Authorization header (which is pre-normalized
// by WHATWG Headers: leading/trailing whitespace and CRLF stripped, internal
// whitespace preserved) and delegates to parseBearer. Property tests call
// parseBearer directly so they can exercise raw inputs that Headers would
// otherwise normalize away.
export function parseBearer(authValue: string): string | null {
  const match = authValue.match(BEARER_REGEX);
  return match ? (match[1] ?? null) : null;
}

export function extractBearer(req: Request): string | null {
  const auth = req.headers.get('authorization');
  if (auth === null) return null;
  return parseBearer(auth);
}

export function hasAuthHeader(req: Request): boolean {
  return req.headers.get('authorization') !== null;
}
