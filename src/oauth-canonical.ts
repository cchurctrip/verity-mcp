// Canonical-resource-URI comparator for the VRT-166 Phase 1 audience-binding
// path. RFC 8707 §2 says the `resource` parameter must be an absolute URI
// that the MCP server has chosen as its canonical identifier. The MCP
// 2025-06-18 authorization spec mandates servers reject tokens whose audience
// does not match this canonical value.
//
// Canonical form for Verity's resource server (per spec line 119):
//   - scheme = https (lowercase)
//   - host = mcp.verityskills.com (lowercase)
//   - port omitted (HTTPS default)
//   - path = empty (no '/' suffix)
//   - no query string
//   - no fragment
//
// The comparator normalizes a candidate URI to canonical form and equality-
// checks against the constant. Inputs that fail to parse as URLs are
// rejected outright. Inputs whose origin matches but carry a path, query, or
// fragment are rejected (per the spec's "no path, no trailing slash, lowercase,
// no fragment" definition).

export const CANONICAL_RESOURCE_URI = 'https://mcp.verityskills.com';

/**
 * Returns true iff the candidate string equals the canonical resource URI
 * after normalization. Defensive against:
 *
 *   - Trailing slash:                 'https://mcp.verityskills.com/'        → false (path differs)
 *   - Mixed case host:                'https://MCP.VerityskiLLs.com'         → true  (host case-folds)
 *   - Mixed case scheme:              'HTTPS://mcp.verityskills.com'         → true  (URL parser lowercases scheme)
 *   - Explicit default port:          'https://mcp.verityskills.com:443'     → true  (URL parser strips default port)
 *   - Path:                           'https://mcp.verityskills.com/oauth'   → false
 *   - Query:                          'https://mcp.verityskills.com?x=1'     → false
 *   - Fragment:                       'https://mcp.verityskills.com#frag'    → false
 *   - Wrong host:                     'https://api.verityskills.com'         → false
 *   - Wrong scheme:                   'http://mcp.verityskills.com'          → false (scheme differs)
 *   - Malformed input:                'not a uri'                            → false (URL parser throws)
 */
export function isCanonicalResourceUri(candidate: string | undefined | null): boolean {
  if (typeof candidate !== 'string' || candidate.length === 0) return false;

  // The URL parser normalizes `https://host` and `https://host/` to identical
  // URL objects (pathname becomes '/' in both cases). To reject the trailing-
  // slash form per the spec's canonical definition, we need a raw-string
  // inspection step BEFORE the structural validation below. We do this by
  // stripping the part of the input the URL parser would not surface in
  // its components (scheme + authority + path) and checking the path segment
  // explicitly on the raw string.
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  if (parsed.host !== 'mcp.verityskills.com') return false;
  if (parsed.search !== '') return false;
  if (parsed.hash !== '') return false;

  // Raw-string check: the canonical form has NO path component. We accept
  // case + port normalization through the URL parser (Host header is
  // case-insensitive per RFC 7230; explicit default ports drop) but reject
  // any path beyond what the parser-coerced authority requires. The URL
  // parser's href would re-add a trailing slash, so we cannot compare on
  // href. Instead: take the raw string up to the start of any path/search/
  // hash and require it to be exactly the canonical authority + scheme.
  //
  // Build the lowercase scheme + lowercase host (+ optional explicit port).
  // If the candidate's raw text has anything after the authority, reject.
  const pathSep = findAuthorityEnd(candidate);
  if (pathSep !== -1) {
    // There's a separator after the authority; anything past it is a path,
    // query, or fragment we must reject. Even a bare '/' is rejected.
    return false;
  }

  return true;
}

/**
 * Returns the index of the first path/query/fragment separator (`/`, `?`, `#`)
 * after the scheme-authority block. Returns -1 if the input ends at the
 * authority (canonical form).
 *
 * The scheme-authority block is everything from index 0 up to (but not
 * including) the first separator after `://`. We do not need to validate
 * the scheme or authority here; the URL parser already did that and the
 * caller pinned protocol + host.
 */
function findAuthorityEnd(input: string): number {
  const schemeIdx = input.indexOf('://');
  if (schemeIdx < 0) return -1;
  const authorityStart = schemeIdx + 3;
  for (let i = authorityStart; i < input.length; i++) {
    const ch = input[i];
    if (ch === '/' || ch === '?' || ch === '#') return i;
  }
  return -1;
}
