/**
 * Response builders.
 *
 * Every JSON response the API produces is created here, so the envelope, the
 * character set and the cache headers are identical across 40-odd endpoints and
 * a new route cannot accidentally invent its own shape.
 */

import { CACHE_SECONDS, type ErrorCode } from '@shared/constants.js';
import type { ApiEnvelope, ApiErrorBody, PageMeta } from '@shared/types/api.js';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' } as const;

/** How long a response may be cached, in the browser and at the edge. */
export interface CachePolicy {
  readonly browser: number;
  readonly edge: number;
}

/** Named policies from `shared/constants.ts`, plus "never cache". */
export const CACHE = {
  none: null,
  reference: CACHE_SECONDS.reference,
  catalog: CACHE_SECONDS.catalog,
  video: CACHE_SECONDS.video,
  home: CACHE_SECONDS.home,
} as const;

export interface ResponseOptions {
  readonly status?: number;
  /** `null`, or omitted, means `no-store`. */
  readonly cache?: CachePolicy | null;
  /**
   * Extra headers. A `Headers` instance may carry several `Set-Cookie`
   * values; a plain object cannot, so use one when it must.
   */
  readonly headers?: Headers | Record<string, string>;
}

/** A successful response carrying `data` and optional `meta`. */
export function ok<TData, TMeta extends Record<string, unknown> = Record<string, unknown>>(
  data: TData,
  meta: TMeta = {} as TMeta,
  options: ResponseOptions = {},
): Response {
  const envelope: ApiEnvelope<TData, TMeta> = { data, meta, error: null };
  return json(envelope, options);
}

/** A paginated list response. */
export function okList<TItem>(
  items: readonly TItem[],
  meta: PageMeta,
  options: ResponseOptions = {},
): Response {
  return json({ data: items, meta, error: null }, options);
}

/** An error response. Prefer throwing an `HttpError`; the handler calls this. */
export function fail(
  status: number,
  code: ErrorCode,
  message: string,
  options: ResponseOptions & { fields?: ApiErrorBody['fields'] } = {},
): Response {
  const error: ApiErrorBody =
    options.fields == null ? { code, message } : { code, message, fields: options.fields };
  return json({ data: null, meta: {}, error }, { ...options, status, cache: null });
}

/**
 * Low-level JSON writer. Everything above funnels through here.
 *
 * Headers are built with `append`, not object spread, because a response may
 * legitimately carry more than one `Set-Cookie` — signing in sets the session
 * and the readable hint together — and an object literal can only hold one
 * value per key.
 */
export function json(body: unknown, options: ResponseOptions = {}): Response {
  const headers = new Headers(JSON_HEADERS);
  headers.set('cache-control', cacheControl(options.cache ?? null));

  const extra = options.headers;
  if (extra instanceof Headers) {
    for (const cookie of extra.getSetCookie()) headers.append('set-cookie', cookie);
    for (const [name, value] of extra) {
      if (name.toLowerCase() !== 'set-cookie') headers.set(name, value);
    }
  } else if (extra != null) {
    for (const [name, value] of Object.entries(extra)) headers.set(name, value);
  }

  return new Response(JSON.stringify(body), { status: options.status ?? 200, headers });
}

/**
 * Build a `Cache-Control` header.
 *
 * `max-age` is the one that saves a request outright: a browser holding a fresh
 * copy does not ask again, so a visitor moving between pages costs nothing.
 *
 * `s-maxage` is read by `worker/middleware/edge-cache.ts`, which is what
 * actually caches these responses. It is worth being precise about this,
 * because the intuition is wrong and the comment here used to be too: a
 * response *produced by a Worker* is not stored in Cloudflare's cache by
 * setting `s-maxage` on it. The Worker has to store it. So this header is a
 * declaration of intent that the cache layer honours — no route needs to know
 * the cache exists, but no route gets edge caching for free either.
 *
 * `stale-while-revalidate` lets a browser paint immediately with a slightly old
 * copy while it refreshes in the background.
 */
export function cacheControl(policy: CachePolicy | null): string {
  if (policy == null) return 'no-store';
  return [
    'public',
    `max-age=${String(policy.browser)}`,
    `s-maxage=${String(policy.edge)}`,
    `stale-while-revalidate=${String(policy.edge)}`,
  ].join(', ');
}

/** 204, for a successful write with nothing to return. */
export function noContent(): Response {
  return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
}

/** A permanent redirect, used for the legacy query-string URLs. */
export function permanentRedirect(location: string): Response {
  return new Response(null, {
    status: 301,
    headers: { location, 'cache-control': 'public, max-age=86400' },
  });
}
