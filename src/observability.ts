// Structured logging + Sentry config for the verity-mcp Worker.
//
// The structured-log builder is wired into the /mcp dispatch path in
// src/index.ts. Sentry wrapping via `Sentry.withSentry(buildSentryConfig)` is
// wired in src/index.ts; when `SENTRY_DSN` is unset (the default pre-deploy
// and the local-dev path), `buildSentryConfig` returns undefined and the
// withSentry callback gracefully no-ops.
//
// Per VRT-146a spec hidden coupling #9: every request gets a UUIDv7
// request_id that propagates to upstream as x-request-id, so on-call can
// cross-reference Worker logs to main-repo Sentry + PostHog events without
// time-window joins.
//
// Log lines NEVER contain token values. The auth_present boolean is
// sufficient to classify a request's auth disposition without leaking the
// secret.
//
// Sentry beforeSend redaction is a defense-in-depth measure. Tokens should
// never reach Sentry events in the first place (the Worker doesn't put them
// in breadcrumbs or extras), but if a future bug ever passes raw req.headers
// to Sentry.captureException(), the scrubAuthorization hook strips them
// before the event leaves the Worker.

import type { CloudflareOptions } from '@sentry/cloudflare';
import type { ErrorEvent, EventHint } from '@sentry/core';

export interface ObservabilityEnv {
  SENTRY_DSN?: string;
  COMMIT_SHA?: string;
}

// OutcomeKind is the canonical classifier for every /mcp dispatch result.
// Each variant maps to a distinct log line + Sentry event shape. Matching the
// ProxyOutcome.kind variants for the proxy outcomes lets the entry-layer log
// line flow through without re-classification.
export type OutcomeKind =
  | 'initialize_ok'
  | 'tools_list_ok'
  | 'parse_error'
  | 'invalid_envelope'
  | 'method_not_found'
  | 'invalid_params'
  | 'forward'
  | 'bearer_invalid'
  | 'tool_disabled'
  | 'unknown_tool'
  | 'upstream_5xx'
  | 'upstream_network_error';

// LogLineFields is the canonical shape of every structured log line emitted
// from src/index.ts. Keeping the OutcomeKind formal on the line (instead of
// a free-form string) makes it greppable from on-call alerting.
//
// `tool` is `string | null` because not every outcome has a tool:
// parse_error and invalid_envelope happen before method dispatch. `tools/list`
// and `initialize` use the method name as `tool` (so log queries that filter
// by tool surface those too). method_not_found uses the sentinel 'unknown'.
//
// `upstream_status` is `number | null` because only the outcomes that
// reached the upstream and got a response back populate it (`forward`,
// `upstream_5xx`). `upstream_network_error` and the worker-edge rejections
// (`bearer_invalid`, `tool_disabled`, `unknown_tool`) leave it null.
//
// `error` is optional but carries a short, scrubbed detail string when set.
// On-call uses this to triage; bearer values never appear here.
export interface LogLineFields {
  request_id: string;
  outcome_kind: OutcomeKind;
  tool: string | null;
  upstream_status: number | null;
  latency_ms: number;
  auth_present: boolean;
  error?: string;
}

// UUIDv7: 48 bits of unix-time-ms (sortable) + 74 bits of random + 4 bits
// version + 2 bits variant. Per draft-ietf-uuidrev-rfc4122bis. JS bitwise
// operators are 32-bit so the timestamp split uses Math.floor for the high
// half.
//
// Intentional fail-loud: if `crypto.getRandomValues` throws (entropy
// exhaustion, CSP, future runtime restriction), we let it propagate. A
// `Math.random` fallback would silently break UUIDv7 uniqueness and the
// cross-system trace-correlation invariant of coupling #9. The Worker
// request handler will surface this as a 500 and Sentry will capture it.
export function generateRequestId(): string {
  const ts = Date.now();
  const bytes = new Uint8Array(16);

  let tsTemp = ts;
  for (let i = 5; i >= 0; i--) {
    bytes[i] = tsTemp & 0xff;
    tsTemp = Math.floor(tsTemp / 256);
  }

  const randBytes = new Uint8Array(10);
  crypto.getRandomValues(randBytes);
  bytes.set(randBytes, 6);

  // Version 7 in the high nibble of byte 6
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  // RFC 4122 variant (10xx) in the top 2 bits of byte 8
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function buildLogLine(fields: LogLineFields): Record<string, unknown> {
  return {
    ts: new Date().toISOString(),
    ...fields,
  };
}

// logRequest emits the structured log line to console.log (Cloudflare Workers
// tail). Defensive: JSON.stringify can throw on BigInt or cyclic objects. A
// logging-path crash must NEVER take down the request handler, so the catch
// emits a minimal fallback record with the request_id (if available) so the
// log timeline isn't silently broken.
export function logRequest(line: Record<string, unknown>): void {
  try {
    console.log(JSON.stringify(line));
  } catch (err) {
    const requestId = typeof line['request_id'] === 'string' ? line['request_id'] : 'unknown';
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        request_id: requestId,
        log_error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

// scrubAuthorization is the Sentry beforeSend hook. Walks the event
// recursively and replaces any Authorization-shaped header value with
// '[redacted]'. Also strips x-verity-key (which would carry the raw vtk_
// token if a future bug ever passed upstream Headers to Sentry).
//
// Cyclic-reference safe: uses a WeakSet to track visited objects. Without
// this guard, a Cloudflare Request-shaped payload containing a back-
// reference (request.response.request, or operator-set context with
// cycles) would stack-overflow inside beforeSend. Sentry's documented
// behavior when beforeSend throws is to DROP the event, which is exactly
// the silent-failure pattern this Worker exists to avoid.
//
// Signature matches the real @sentry/core Options.beforeSend type:
// (event: ErrorEvent, hint: EventHint) => ErrorEvent | null. The hint
// argument is unused (the hook only inspects + mutates the event) but
// kept in the signature so the function is assignable to the SDK's
// expected type without a cast.
//
// Failure mode: on scrubber crash, we emit a structured warn-log line
// (so on-call can see the scrubber stopped working) and return null,
// which signals Sentry to drop the event (fail closed: lose one event
// rather than risk leaking an unscrubbed token to the upstream Sentry
// service).
export function scrubAuthorization(
  event: ErrorEvent | null,
  _hint?: EventHint,
): ErrorEvent | null {
  if (event === null) return event;
  try {
    scrubInObject(event as unknown as Record<string, unknown>, new WeakSet());
  } catch (err) {
    // Log the scrubber crash so on-call doesn't silently lose Sentry signal.
    // The warn line carries no event content, only the failure cause; the
    // event itself is dropped (returning null is the Sentry contract for
    // "drop this event").
    try {
      console.warn(
        JSON.stringify({
          ts: new Date().toISOString(),
          kind: 'sentry_scrubber_crash',
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    } catch {
      // Even the warn-log path failed (JSON.stringify of an unstringifiable
      // err?). Suppress: returning null below is more important than logging.
    }
    return null;
  }
  return event;
}

const REDACTED_HEADER_NAMES = new Set(['authorization', 'x-verity-key']);

function scrubInObject(obj: Record<string, unknown>, seen: WeakSet<object>): void {
  if (seen.has(obj)) return;
  seen.add(obj);
  for (const key of Object.keys(obj)) {
    if (REDACTED_HEADER_NAMES.has(key.toLowerCase())) {
      obj[key] = '[redacted]';
      continue;
    }
    const value = obj[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'object' && item !== null) {
          scrubInObject(item as Record<string, unknown>, seen);
        }
      }
    } else if (typeof value === 'object' && value !== null) {
      scrubInObject(value as Record<string, unknown>, seen);
    }
  }
}

// Pure config builder. src/index.ts passes this to Sentry.withSentry to wrap
// the worker handler. Keeping the builder pure (no init side effects) means
// it is testable without mocking the Sentry SDK.
//
// Returns `undefined` (not null) when SENTRY_DSN is unset so the value can
// flow directly to Sentry.withSentry's optionsCallback contract (which
// accepts `CloudflareOptions | undefined`).
export function buildSentryConfig(env: ObservabilityEnv): CloudflareOptions | undefined {
  if (!env.SENTRY_DSN) return undefined;
  return {
    dsn: env.SENTRY_DSN,
    release: env.COMMIT_SHA ?? 'unknown',
    beforeSend: scrubAuthorization,
  };
}
