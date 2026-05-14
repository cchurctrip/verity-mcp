// Unit tests for src/observability.ts. Covers UUIDv7 shape + monotonicity,
// log-line structure, Sentry beforeSend redaction (the load-bearing
// defense-in-depth piece), and the pure config builder.

import { describe, expect, it } from 'vitest';
import {
  buildLogLine,
  buildSentryConfig,
  generateRequestId,
  scrubAuthorization,
} from '../src/observability';

const UUIDV7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('generateRequestId', () => {
  it('returns a string matching the UUIDv7 pattern', () => {
    const id = generateRequestId();
    expect(id).toMatch(UUIDV7_PATTERN);
  });

  it('embeds the current millisecond timestamp in the first 48 bits', () => {
    const before = Date.now();
    const id = generateRequestId();
    const after = Date.now();
    const hex = id.replace(/-/g, '').slice(0, 12);
    const ts = parseInt(hex, 16);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it('generates unique IDs across rapid calls', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      ids.add(generateRequestId());
    }
    expect(ids.size).toBe(1000);
  });

  it('always sets version 7 in the high nibble of byte 6', () => {
    for (let i = 0; i < 50; i++) {
      const id = generateRequestId();
      expect(id.charAt(14)).toBe('7');
    }
  });

  it('always sets RFC 4122 variant (10xx) in the top two bits of byte 8', () => {
    for (let i = 0; i < 50; i++) {
      const id = generateRequestId();
      const variantChar = id.charAt(19).toLowerCase();
      expect(['8', '9', 'a', 'b']).toContain(variantChar);
    }
  });

  it('generates unique IDs across concurrent (Promise.all) calls', async () => {
    // generateRequestId is synchronous but crypto.getRandomValues is callable
    // from many async contexts. Pin thread-safety expectation explicitly.
    const ids = await Promise.all(
      Array.from({ length: 1000 }, () => Promise.resolve(generateRequestId())),
    );
    expect(new Set(ids).size).toBe(1000);
  });
});

describe('logRequest fail-safe', () => {
  it('does not throw when given a body that JSON.stringify cannot handle', async () => {
    // A logging-path crash must NEVER take down the request handler.
    // Construct a body that JSON.stringify refuses (BigInt).
    const { logRequest } = await import('../src/observability');
    const cyclic: Record<string, unknown> = { request_id: 'abc' };
    cyclic['self'] = cyclic; // cyclic ref breaks JSON.stringify
    expect(() => logRequest(cyclic)).not.toThrow();
  });
});

describe('buildLogLine', () => {
  it('produces a structured object with ts + provided fields', () => {
    const line = buildLogLine({
      request_id: 'abc',
      tool: 'verity-score',
      upstream_status: 200,
      latency_ms: 42,
      auth_present: true,
    });
    expect(line['request_id']).toBe('abc');
    expect(line['tool']).toBe('verity-score');
    expect(line['upstream_status']).toBe(200);
    expect(line['latency_ms']).toBe(42);
    expect(line['auth_present']).toBe(true);
    expect(typeof line['ts']).toBe('string');
    // ISO timestamp shape
    expect(line['ts']).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('NEVER includes a token value (auth_present is boolean only)', () => {
    const line = buildLogLine({
      request_id: 'abc',
      tool: 'verity-score',
      upstream_status: 200,
      latency_ms: 42,
      auth_present: true,
    });
    const serialized = JSON.stringify(line);
    expect(serialized).not.toMatch(/vtk_/);
    expect(serialized).not.toMatch(/Bearer/i);
    expect(serialized).not.toContain('token');
  });

  it('preserves optional error field when provided', () => {
    const line = buildLogLine({
      request_id: 'abc',
      tool: 'verity-score',
      upstream_status: 502,
      latency_ms: 30100,
      auth_present: true,
      error: 'upstream timeout',
    });
    expect(line['error']).toBe('upstream timeout');
  });
});

describe('scrubAuthorization', () => {
  it('redacts top-level Authorization header (case-insensitive)', () => {
    const event = { request: { headers: { Authorization: 'Bearer vtk_secret' } } };
    scrubAuthorization(event);
    expect(event.request.headers.Authorization).toBe('[redacted]');
  });

  it('redacts top-level authorization (lowercase)', () => {
    const event = { request: { headers: { authorization: 'Bearer vtk_secret' } } };
    scrubAuthorization(event);
    expect(event.request.headers.authorization).toBe('[redacted]');
  });

  it('redacts X-Verity-Key (variant casing)', () => {
    const event = { request: { headers: { 'x-verity-key': 'vtk_abc' } } };
    scrubAuthorization(event);
    expect(event.request.headers['x-verity-key']).toBe('[redacted]');
  });

  it('walks nested objects to find Authorization', () => {
    const event = {
      breadcrumbs: [
        { data: { headers: { Authorization: 'Bearer vtk_secret' } } },
        { data: { headers: { 'content-type': 'application/json' } } },
      ],
    };
    scrubAuthorization(event);
    expect(event.breadcrumbs[0]?.data.headers.Authorization).toBe('[redacted]');
    // Non-auth header is preserved
    expect(event.breadcrumbs[1]?.data.headers['content-type']).toBe('application/json');
  });

  it('leaves non-authorization keys untouched', () => {
    const event = {
      request: { headers: { 'content-type': 'application/json', accept: '*/*' } },
      level: 'error',
    };
    scrubAuthorization(event);
    expect(event.request.headers['content-type']).toBe('application/json');
    expect(event.request.headers.accept).toBe('*/*');
    expect(event.level).toBe('error');
  });

  it('returns the input event reference (Sentry beforeSend contract)', () => {
    const event = { request: { headers: {} } };
    const result = scrubAuthorization(event);
    expect(result).toBe(event);
  });

  it('handles non-object input safely', () => {
    expect(scrubAuthorization(null)).toBe(null);
    expect(scrubAuthorization(undefined)).toBe(undefined);
    expect(scrubAuthorization('string')).toBe('string');
    expect(scrubAuthorization(42)).toBe(42);
  });

  it('handles circular references without stack overflow (WeakSet visited-tracking)', () => {
    // Cloudflare Request-shaped Sentry payloads can have back-references; a
    // future bug that passes one to captureException must not crash beforeSend
    // and silently drop the event.
    const event: Record<string, unknown> = {
      request: { headers: { Authorization: 'Bearer vtk_secret' } },
    };
    event['self'] = event;
    expect(() => scrubAuthorization(event)).not.toThrow();
    const headers = (event['request'] as Record<string, unknown>)['headers'] as Record<string, unknown>;
    expect(headers['Authorization']).toBe('[redacted]');
  });

  it('handles arrays containing objects with Authorization', () => {
    const event = {
      records: [
        { headers: { Authorization: 'Bearer vtk_a' } },
        { headers: { Authorization: 'Bearer vtk_b' } },
      ],
    };
    scrubAuthorization(event);
    expect(event.records[0]?.headers.Authorization).toBe('[redacted]');
    expect(event.records[1]?.headers.Authorization).toBe('[redacted]');
  });
});

describe('buildSentryConfig', () => {
  it('returns null when SENTRY_DSN is unset', () => {
    expect(buildSentryConfig({})).toBeNull();
    expect(buildSentryConfig({ COMMIT_SHA: 'abc' })).toBeNull();
  });

  it('returns config when SENTRY_DSN is set', () => {
    const cfg = buildSentryConfig({ SENTRY_DSN: 'https://test@sentry.io/1', COMMIT_SHA: 'abc' });
    expect(cfg).not.toBeNull();
    expect(cfg!.dsn).toBe('https://test@sentry.io/1');
    expect(cfg!.release).toBe('abc');
    expect(typeof cfg!.beforeSend).toBe('function');
  });

  it('defaults release to "unknown" when COMMIT_SHA is unset', () => {
    const cfg = buildSentryConfig({ SENTRY_DSN: 'https://test@sentry.io/1' });
    expect(cfg!.release).toBe('unknown');
  });

  it('beforeSend hook scrubs Authorization headers', () => {
    const cfg = buildSentryConfig({ SENTRY_DSN: 'https://test@sentry.io/1' });
    const event = { request: { headers: { Authorization: 'Bearer vtk_secret' } } };
    cfg!.beforeSend(event);
    expect(event.request.headers.Authorization).toBe('[redacted]');
  });
});
