// Minimal PostgREST HTTP client for the OAuth path.
//
// We deliberately do NOT depend on @supabase/supabase-js. The SDK pulls in
// the realtime + storage clients (~50KB minified) for a Worker that needs
// nothing but a small set of PostgREST CRUD calls against five OAuth tables.
// PostgREST is just HTTP, and the Worker has no need for the SDK's session
// management (we always use the service-role JWT).
//
// Auth posture:
//   - service-role JWT only (RLS bypass; Supabase default for service role).
//   - both `apikey` and `Authorization: Bearer <jwt>` headers required per
//     Supabase docs; the apikey header is the routing token, the bearer is
//     the actual auth credential.
//   - URL shape: `${SUPABASE_URL}/rest/v1/<table>?<filters>` for SELECT;
//     `${SUPABASE_URL}/rest/v1/<table>` with POST body for INSERT.
//
// Headers used:
//   - apikey + Authorization: required on every request.
//   - Prefer: return=representation: tells PostgREST to echo back inserted/
//     updated rows so we can read e.g. generated default columns.
//   - Prefer: resolution=merge-duplicates: used on the upsert helper.
//
// All helpers return a typed result that distinguishes (a) row(s) found,
// (b) zero rows (404-like via PostgREST's empty array on a query), (c) HTTP
// error from PostgREST. The OAuth handlers map (a/b/c) to OAuth error codes.

export interface SupabaseEnv {
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
}

/**
 * Result kind for every helper in this module. Callers exhaustively switch
 * on `kind` so a future variant becomes a compile error rather than a silent
 * branch fall-through.
 */
export type SupabaseResult<T> =
  | { kind: 'ok'; rows: T[] }
  | { kind: 'http_error'; status: number; body: string }
  | { kind: 'network_error'; cause: string };

export interface SupabaseClient {
  /**
   * SELECT all rows matching the given filters. `filters` is appended as
   * PostgREST query params (e.g. `id=eq.123&used_at=is.null`). `select` is
   * a comma-separated column list; defaults to '*'.
   */
  select<T>(
    table: string,
    filters: string,
    select?: string,
  ): Promise<SupabaseResult<T>>;

  /**
   * INSERT a row. Returns the inserted row (PostgREST `Prefer:
   * return=representation`).
   */
  insert<T>(table: string, row: Record<string, unknown>): Promise<SupabaseResult<T>>;

  /**
   * UPDATE rows matching `filters`. Returns the updated rows.
   */
  update<T>(
    table: string,
    filters: string,
    patch: Record<string, unknown>,
  ): Promise<SupabaseResult<T>>;

  /**
   * DELETE rows matching `filters`. Returns the deleted rows (so the caller
   * can confirm at least one row was deleted, which matters for refresh-token
   * single-use semantics).
   */
  remove<T>(table: string, filters: string): Promise<SupabaseResult<T>>;
}

/**
 * `oauth_misconfigured` sentinel: when SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY
 * is missing at request time, OAuth endpoints return a 503 with this body so
 * an operator can distinguish "secret not set" from "DB down" in the logs.
 * `vtk_*` user-key paths never touch Supabase from the Worker; they remain
 * unaffected by the misconfiguration.
 */
export const OAUTH_MISCONFIGURED_BODY = {
  code: 'oauth_misconfigured',
  message:
    'OAuth token endpoint is not configured. Operator action required: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY Wrangler secrets.',
} as const;

/**
 * Returns a client wired to the given env, or null when either secret is
 * missing. Caller checks for null and returns the misconfigured 503.
 *
 * `fetchImpl` is a parameter so tests can intercept without monkey-patching
 * global fetch.
 */
export function buildSupabaseClient(
  env: SupabaseEnv,
  fetchImpl: typeof fetch = fetch,
): SupabaseClient | null {
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (typeof url !== 'string' || url.length === 0) return null;
  if (typeof key !== 'string' || key.length === 0) return null;

  // Strip trailing slash on the base URL once so call sites can always
  // concat `/rest/v1/...` without producing `//rest/v1/...`.
  const base = url.endsWith('/') ? url.slice(0, -1) : url;

  const baseHeaders = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
  } as const;

  async function doFetch(
    path: string,
    init: RequestInit,
  ): Promise<SupabaseResult<unknown>> {
    let resp: Response;
    try {
      resp = await fetchImpl(`${base}${path}`, init);
    } catch (err) {
      return {
        kind: 'network_error',
        cause: err instanceof Error ? err.message : String(err),
      };
    }
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      return { kind: 'http_error', status: resp.status, body };
    }
    // PostgREST returns an array for table-scope queries even with `.single()`-
    // style filters. We do not use `Accept: application/vnd.pgrst.object+json`
    // because the empty-result handling is cleaner with arrays (length === 0).
    let parsed: unknown;
    try {
      const txt = await resp.text();
      parsed = txt.length === 0 ? [] : JSON.parse(txt);
    } catch (err) {
      return {
        kind: 'network_error',
        cause: `response body parse failure: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    return { kind: 'ok', rows: Array.isArray(parsed) ? parsed : [parsed] };
  }

  return {
    async select<T>(
      table: string,
      filters: string,
      select: string = '*',
    ): Promise<SupabaseResult<T>> {
      const qs = filters.length > 0 ? `&${filters}` : '';
      const path = `/rest/v1/${table}?select=${encodeURIComponent(select)}${qs}`;
      return doFetch(path, { method: 'GET', headers: baseHeaders }) as Promise<SupabaseResult<T>>;
    },

    async insert<T>(table: string, row: Record<string, unknown>): Promise<SupabaseResult<T>> {
      return doFetch(`/rest/v1/${table}`, {
        method: 'POST',
        headers: { ...baseHeaders, Prefer: 'return=representation' },
        body: JSON.stringify(row),
      }) as Promise<SupabaseResult<T>>;
    },

    async update<T>(
      table: string,
      filters: string,
      patch: Record<string, unknown>,
    ): Promise<SupabaseResult<T>> {
      const path = `/rest/v1/${table}?${filters}`;
      return doFetch(path, {
        method: 'PATCH',
        headers: { ...baseHeaders, Prefer: 'return=representation' },
        body: JSON.stringify(patch),
      }) as Promise<SupabaseResult<T>>;
    },

    async remove<T>(table: string, filters: string): Promise<SupabaseResult<T>> {
      const path = `/rest/v1/${table}?${filters}`;
      return doFetch(path, {
        method: 'DELETE',
        headers: { ...baseHeaders, Prefer: 'return=representation' },
      }) as Promise<SupabaseResult<T>>;
    },
  };
}
