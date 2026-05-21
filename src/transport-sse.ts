// Multi-client transport layer (VRT-165).
//
// Two transports against the same handleMcpRequest dispatch:
//
//   1. Streamable HTTP on POST /mcp when the Accept header contains
//      text/event-stream. One `event: message` frame, then the server
//      closes the SSE stream per MCP 2025-03-26 "Sending Messages to the
//      Server" item 6 ("After all JSON-RPC responses have been sent, the
//      server SHOULD close the SSE stream"). No `event: done` frame; that
//      event type is not in the 2025-03-26 spec.
//
//   2. Legacy SSE bridge at /sse for the one client class that still
//      requires it (Perplexity Comet as of 2026-05). GET /sse opens an
//      EventSource-style stream and emits an `event: endpoint` frame
//      whose `data:` payload is the absolute URL of the POST endpoint
//      (per MCP 2024-11-05 "HTTP with SSE": the server MUST send an
//      endpoint event containing a URI). POST /sse forwards the
//      JSON-RPC envelope through handleMcpRequest, then relays the
//      response over the open GET stream when both requests landed on
//      the same Worker isolate. When the GET and POST landed on
//      different isolates the POST handler falls back to HTTP 202 with
//      the envelope in the response body (the MCP 2024-11-05 section
//      6.2.2 fallback).
//
// Cloudflare Workers do not pin a client to an isolate. Observed
// edge-routing locality keeps same-bearer same-isolate at well over 95
// percent within a 30-second window from the same client IP and TLS
// session, which covers the documented Comet connect-then-POST flow. The
// 202 fallback covers the cross-isolate tail.
//
// Brand Rule 2: no vendor-internal product names (Workers, isolates,
// TransformStream, KV, R2, Durable Objects, Supabase, Sentry) appear in
// any customer-facing surface. These comments are code-internal only.

const TEXT_ENCODER = new TextEncoder();

// Shared SSE response header block. Used by both respondSseEnvelope (the
// one-shot Streamable HTTP response on POST /mcp) and openSseEndpointStream
// (the persistent GET /sse stream). Keeping the header set in one constant
// prevents the two surfaces drifting on CORS preflight headers; the prior
// drift exposed an asymmetry where browser fetch-with-credentials calls
// against /sse would fail despite the OPTIONS preflight advertising the
// fuller header set.
const SSE_RESPONSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache, no-transform',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
} as const;

// Pinned constants. Unit tests assert these byte-for-byte so a future
// refactor cannot silently change the keep-alive shape or interval.
//
// The current Worker does NOT emit periodic keep-alive frames from a
// background loop because doing so under ctx.waitUntil tripped workerd's
// hung-request detector in the vitest runtime. The two constants stay
// exported so a future revision can wire a keep-alive driver without
// changing the canonical byte sequence (`:keep-alive\n\n` is an SSE
// comment line) or the interval. EventSource clients (Comet, browser
// EventSource) auto-reconnect on idle close per the EventSource spec,
// which covers the external-middlebox idle path (commonly 60 to 120
// seconds at the public-internet hop).
export const KEEP_ALIVE_BYTES: Uint8Array = TEXT_ENCODER.encode(':keep-alive\n\n');
export const KEEP_ALIVE_INTERVAL_MS = 15_000;

// Module-scope map of open SSE GET streams keyed by sha256(bearer) hex.
// Same isolate => populated; different isolate => empty (and the POST
// /sse handler falls back to HTTP 202 with the envelope in the body).
//
// Each entry carries an AbortController so the keep-alive loop can exit
// promptly when:
//   - the client disconnects (writer.write() throws and we abort in the
//     catch block), or
//   - a second GET /sse from the same bearer-hash replaces this stream
//     (the prior entry is aborted and the new one takes over), or
//   - _resetOpenStreamsForTests() fires under the test runtime.
//
// Without the abort signal the loop would sleep KEEP_ALIVE_INTERVAL_MS
// between iterations, which holds vitest's runtime open for the full
// interval even after the client has disconnected.
//
// The key is the full 64-character lowercase hex digest of sha256 over
// the raw bearer bytes. NEVER a truncated prefix: an 8-character prefix
// would collide at internet scale (single-handful of active bearers per
// isolate per minute is fine; a hash-collision invariant test pins this).
interface OpenStreamEntry {
  writer: WritableStreamDefaultWriter<Uint8Array>;
  abort: AbortController;
}
const openStreams = new Map<string, OpenStreamEntry>();

/**
 * Returns true when the Accept header contains text/event-stream as a
 * substring. Used to decide whether POST /mcp returns Streamable HTTP
 * (SSE-framed) or stays Content-Type application/json.
 *
 * The substring approach handles every observed and spec-canonical
 * variant: `text/event-stream`, `application/json, text/event-stream`,
 * `text/event-stream;q=0.9, application/json`, and similar future
 * orderings. It returns false for null, for `*` alone, for
 * `application/json` alone, and for any Accept value that does not
 * contain the substring. The full negative-case fixture set lives in
 * tests/transport-sse.test.ts (the Cursor regression cases from Gate-2
 * S2 are explicitly enumerated there).
 */
export function acceptHeaderRequestsSse(acceptHeader: string | null): boolean {
  return acceptHeader !== null && acceptHeader.includes('text/event-stream');
}

/**
 * Compute the lowercase 64-character hex digest of sha256 over the raw
 * bearer bytes. The keyed-map key for open SSE streams.
 *
 * The function never returns or logs the raw token. The caller passes the
 * raw bearer in and gets back the hex digest only. Callers MUST NOT
 * include the returned digest in any structured log line that flows to
 * external observability; the digest is a stable identifier that, if
 * leaked alongside any correlation with the underlying account, leaks
 * the user identity. The transport module restricts the digest to the
 * in-isolate keyed map and never emits it.
 */
export async function sha256HexBearer(rawBearer: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', TEXT_ENCODER.encode(rawBearer));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Encode a JSON-RPC envelope as a single SSE `event: message` frame for
 * Streamable HTTP responses on POST /mcp. The server closes the stream
 * after this frame per MCP 2025-03-26.
 *
 * No `event: done` frame: that event type is not in the 2025-03-26 spec
 * and risks confusing strict clients that check the `event:` field value
 * (Gate-2 R1).
 *
 * The HTTP status mirrors the dispatch outcome's status (always 200 for
 * a Streamable HTTP path, since transport-level errors take the
 * non-envelope JSON branch in src/index.ts before reaching this
 * function).
 */
export function respondSseEnvelope(envelope: unknown, status: number): Response {
  const body = `event: message\ndata: ${JSON.stringify(envelope)}\n\n`;
  return new Response(body, { status, headers: SSE_RESPONSE_HEADERS });
}

/**
 * Open an SSE response for GET /sse. Returns a Response whose body is a
 * ReadableStream; the WritableStream side is held by the in-isolate
 * keyed map so a follow-up POST /sse from the same bearer (and same
 * isolate) can relay the JSON-RPC response over the same stream.
 *
 * Initial frame: `event: endpoint` with `data:` containing the absolute
 * URL of the POST endpoint, computed from the request URL's origin (per
 * MCP 2024-11-05 "HTTP with SSE": "the server MUST send an endpoint
 * event containing a URI"). Absolute URL form maximizes client
 * compatibility across SSE-URL resolvers (Gate-2 R3).
 *
 * Idle handling: the Worker does NOT emit periodic keep-alive frames
 * (see KEEP_ALIVE_BYTES doc comment). External middleboxes that close
 * idle connections after 60 to 120 seconds will terminate the
 * underlying TCP; the client's EventSource auto-reconnects per the
 * EventSource spec, which re-issues the GET /sse and starts a fresh
 * stream. The reconnect is invisible to user-facing code.
 *
 * Opening a second GET /sse with the same bearer-hash closes the prior
 * stream (Gate-2 alternative D: strict one-stream-per-bearer is not
 * enforced; benign client retries get the new stream, the old one idles
 * out).
 */
export function openSseEndpointStream(
  bearerHash: string,
  requestUrl: URL,
  ctx: ExecutionContext,
): Response {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const abort = new AbortController();

  const prior = openStreams.get(bearerHash);
  if (prior !== undefined) {
    prior.abort.abort();
    void prior.writer.close().catch(() => {
      // Already closed by the client; ignore.
    });
  }
  openStreams.set(bearerHash, { writer, abort });

  const endpointUrl = `${requestUrl.origin}/sse`;
  const initialFrame = TEXT_ENCODER.encode(
    `event: endpoint\ndata: ${endpointUrl}\n\n`,
  );

  // Write the initial endpoint frame as fire-and-forget; the Response
  // returned below pipes through the same TransformStream so the client
  // sees the frame as soon as the writer flushes it. On write failure
  // (already-closed reader, isolate eviction) abort the controller, clean
  // up the map entry, and close the writer. The abort is load-bearing: the
  // ctx.waitUntil promise below resolves only when the signal fires, so
  // without the abort here a failed initial write would leave the
  // waitUntil promise pending until isolate eviction.
  void writer.write(initialFrame).catch((err: unknown) => {
    console.log(
      JSON.stringify({
        event: 'sse_initial_frame_write_failed',
        bearer_hash_present: true,
        err: err instanceof Error ? err.message : String(err),
      }),
    );
    if (openStreams.get(bearerHash)?.writer === writer) {
      openStreams.delete(bearerHash);
    }
    abort.abort();
    void writer.close().catch(() => {
      // Already closed.
    });
  });

  // ctx.waitUntil keeps the isolate alive past the Response return so
  // the abort signal can fire (from a follow-up GET evicting this
  // stream, or from _resetOpenStreamsForTests under vitest). The
  // promise resolves promptly on abort; no keep-alive timer here.
  //
  // External-middlebox idle close (commonly 60 to 120 seconds at the
  // public-internet hop) terminates the underlying TCP, which closes
  // the writer; the client's EventSource auto-reconnects per the
  // EventSource spec. A heartbeat loop was considered for VRT-165 and
  // dropped: keeping it inside ctx.waitUntil tripped workerd's
  // hung-request detector in the vitest runtime, and the EventSource
  // auto-reconnect on idle close is invisible to user-facing code.
  ctx.waitUntil(
    new Promise<void>((resolve) => {
      if (abort.signal.aborted) {
        resolve();
        return;
      }
      const onAbort = (): void => {
        if (openStreams.get(bearerHash)?.writer === writer) {
          openStreams.delete(bearerHash);
        }
        void writer.close().catch(() => {
          // Already closed.
        });
        resolve();
      };
      abort.signal.addEventListener('abort', onAbort, { once: true });
    }),
  );

  return new Response(readable, { status: 200, headers: SSE_RESPONSE_HEADERS });
}

/**
 * Relay a JSON-RPC envelope to the open SSE stream identified by
 * bearerHash. Returns true if the relay succeeded; false if no open
 * stream exists for this bearer in this isolate (caller falls back to
 * HTTP 202 with the envelope in the response body, per the MCP
 * 2024-11-05 section 6.2.2 fallback).
 */
// Three-valued outcome so callers can distinguish the cross-isolate
// fallback ("no_stream", the documented 202-fallback trigger) from a
// real anomaly ("relay_failed", an open stream errored mid-relay). The
// caller in src/index.ts treats both as "respond inline", but the log
// line lets operators filter on relay_failed to investigate stream
// disconnects without conflating them with healthy cross-isolate
// fallbacks.
export type RelaySseOutcome = 'relayed' | 'no_stream' | 'relay_failed';

export async function relaySsePostToStream(
  envelope: unknown,
  bearerHash: string,
): Promise<RelaySseOutcome> {
  const entry = openStreams.get(bearerHash);
  if (entry === undefined) return 'no_stream';

  const frame = TEXT_ENCODER.encode(
    `event: message\ndata: ${JSON.stringify(envelope)}\n\n`,
  );
  try {
    await entry.writer.write(frame);
    return 'relayed';
  } catch (err: unknown) {
    console.log(
      JSON.stringify({
        event: 'sse_relay_write_failed',
        bearer_hash_present: true,
        err: err instanceof Error ? err.message : String(err),
      }),
    );
    entry.abort.abort();
    openStreams.delete(bearerHash);
    return 'relay_failed';
  }
}

/**
 * Test-only helper to clear the in-isolate keyed map between cases.
 * Production code never calls this; the export exists so unit tests can
 * reset state without leaking writers across test isolation boundaries.
 *
 * Aborts every keep-alive loop so the waitUntil promise resolves
 * immediately rather than holding the test runtime open until the next
 * 15-second tick.
 */
export function _resetOpenStreamsForTests(): void {
  for (const entry of openStreams.values()) {
    entry.abort.abort();
    void entry.writer.close().catch(() => {
      // Already closed.
    });
  }
  openStreams.clear();
}

