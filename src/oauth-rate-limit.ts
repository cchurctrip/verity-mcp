// Per-code fixed-window rate limit for the /oauth/token endpoint.
//
// Attack model: an attacker scrapes an authorization code from a victim's
// redirect leg (e.g. via a leaked Referer header on a misconfigured client)
// and hammers /oauth/token brute-forcing the PKCE code_verifier. Per the
// arch review §Q9 R8 test #1, the eleventh rapid request on the same code
// must return 429. The first ten cover the authorization-code single-use
// invariant plus nine PKCE-mismatch retries which is already pathological.
//
// Storage: in-isolate Map keyed by sha256(code). KV upgrade is a follow-up
// per the spec Risks #5; the in-isolate map provides per-isolate scoping
// that is weaker than a global counter but sufficient given Cloudflare's
// strong isolate affinity for a single client IP. The map carries a fixed
// max size with simple oldest-entry eviction to bound memory under sustained
// attack.
//
// The window is fixed (not sliding): a counter is reset only when the
// authorization code's row leaves the table (TTL cleanup, follow-up cron).
// For Phase 1 we rely on the natural code lifetime (10 minutes) plus the
// MAX_ENTRIES cap to bound memory.

const PER_CODE_LIMIT = 10;
const MAX_ENTRIES = 10_000;

/**
 * Bucket entry: count of requests observed against this code-hash plus the
 * timestamp of the first observation (for FIFO-style eviction when the map
 * grows past MAX_ENTRIES).
 */
interface Bucket {
  count: number;
  firstSeenMs: number;
}

// Module-scope state. The Worker rebuilds this map per-isolate on cold start;
// the test reset helper at the bottom clears it for unit-test isolation.
const buckets = new Map<string, Bucket>();

/**
 * Records one attempted /oauth/token request against the given code hash and
 * returns true iff the request is over the per-code limit (11th and beyond).
 *
 * Caller pattern:
 *
 *   const overLimit = noteRequestForCode(codeHash);
 *   if (overLimit) {
 *     return rateLimitedResponse();
 *   }
 *   // ... continue to authorization-code redemption ...
 *
 * Returns true on the 11th-and-beyond observation so the caller can emit
 * the 429 before doing any DB work.
 */
export function noteRequestForCode(codeHash: string): boolean {
  evictIfFull();
  const existing = buckets.get(codeHash);
  if (existing === undefined) {
    buckets.set(codeHash, { count: 1, firstSeenMs: Date.now() });
    return false;
  }
  existing.count += 1;
  return existing.count > PER_CODE_LIMIT;
}

/**
 * Test-only helper: clear the in-isolate rate-limit map between cases. The
 * vitest runtime reuses one isolate across all tests in a file, so without
 * this reset a "10 requests then 11th 429" test followed by another "10
 * requests then 11th 429" test would observe the second 11th request as the
 * 21st cumulative request and the assertion would still pass; the reset
 * makes the intent obvious.
 */
export function _resetRateLimitForTests(): void {
  buckets.clear();
}

/**
 * When the map hits MAX_ENTRIES, drop the oldest 10% by firstSeenMs. This
 * bounds memory under a sustained code-flood attack without iterating the
 * full map on every insert. The 10% cushion amortizes the eviction cost.
 */
function evictIfFull(): void {
  if (buckets.size < MAX_ENTRIES) return;
  // Sort entries by firstSeenMs ascending and drop the oldest 10%. O(n log n)
  // but only runs once per MAX_ENTRIES/10 inserts, so amortized cost is small.
  const toDrop = Math.floor(MAX_ENTRIES / 10);
  const ordered = Array.from(buckets.entries()).sort(
    (a, b) => a[1].firstSeenMs - b[1].firstSeenMs,
  );
  for (let i = 0; i < toDrop && i < ordered.length; i++) {
    buckets.delete(ordered[i]![0]);
  }
}
