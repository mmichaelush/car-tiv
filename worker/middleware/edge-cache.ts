/**
 * The Worker's own response cache.
 *
 * ## Why this file exists
 *
 * Every cacheable endpoint already sent `Cache-Control: public, …, s-maxage=…`,
 * and the comment above `cacheControl()` used to claim that Cloudflare's edge
 * would therefore absorb the traffic. It does not. A response *produced by a
 * Worker* is not stored in Cloudflare's cache unless the Worker stores it
 * there itself: `s-maxage` on a Worker response tells other caches what they
 * may do, and Cloudflare's own cache is not in that path.
 *
 * So the numbers were the ones that mattered: every visitor, on every page,
 * reached the Worker and D1. This module closes that gap. A cache hit costs one
 * Worker request — which is unavoidable, since the Worker is what answers the
 * hostname — and **zero D1 rows**, which is the budget that was actually at
 * risk.
 *
 * ## What is cached
 *
 * Only `GET`, only status 200, and only when the handler itself asked for it by
 * returning a `Cache-Control` with `s-maxage`. Everything personal —
 * `/api/me/*`, the session, anything that sets a cookie — is `no-store` at the
 * route and is therefore never even considered here. There is a second,
 * belt-and-braces check on `Set-Cookie` below: caching a response that carries
 * a session cookie would hand one visitor's session to the next, and no
 * refactor of the routes should ever be able to cause that.
 *
 * ## Cache keys
 *
 * The key is not the request URL. Two things would go wrong if it were:
 *
 *  * `?category=all&page=1` and `?page=1&category=all` are the same query and
 *    would occupy two entries — as would `/api/videos` and
 *    `/api/videos?page=1`, which are also the same query.
 *  * Anyone could fragment the cache into uselessness with `?x=1`, `?x=2`, `…`,
 *    because unknown parameters are ignored by `parseQuery` but would still
 *    change the key. Analytics parameters (`utm_*`, `fbclid`) do this by
 *    accident on every shared link.
 *
 * So the key is built from the path plus a **canonical** form of the
 * parameters: for the listing endpoints, the query is parsed into a
 * `VideoQuery` and serialised back, which collapses defaults, orders keys and
 * discards anything unrecognised. For the rest, an explicit allowlist per path.
 * A parameter nobody listed cannot affect the answer, so it must not affect the
 * key.
 */

import { parseQuery, serializeQuery } from '@shared/core/query.js';

/**
 * Parameters that affect the answer, per route.
 *
 * Matched against the route *pattern*, not the literal path, so an endpoint
 * with a path parameter is covered too. `/api/videos/:id/related` reads a
 * `limit`; keyed on its literal path it would serve the twelve-item answer to
 * a caller asking for five, which is the bug this table exists to prevent.
 *
 * A route absent from this table and not handled by `CANONICAL_QUERY_PATHS` is
 * cached on its path alone. That is correct precisely because its handler reads
 * no parameters — and if one ever starts to, its entry belongs here in the same
 * commit.
 */
const SIGNIFICANT_PARAMS: readonly (readonly [pattern: string, params: readonly string[]])[] = [
  ['/api/channels', ['q', 'all', 'page', 'limit']],
  ['/api/tags', ['category', 'limit']],
  ['/api/tags/search', ['q', 'category']],
  ['/api/search/suggestions', ['q']],
  // `include` folds the related videos and the channel's other videos into the
  // one response, so it changes the body and must change the key.
  ['/api/videos/:id', ['include']],
  ['/api/videos/:id/related', ['limit']],
];

/** Compiled once: `/api/videos/:id/related` -> /^\/api\/videos\/[^/]+\/related$/ */
const COMPILED_PARAMS: readonly (readonly [RegExp, readonly string[]])[] = SIGNIFICANT_PARAMS.map(
  ([pattern, params]) =>
    [
      new RegExp(
        `^${pattern
          .split('/')
          .map((segment) =>
            segment.startsWith(':') ? '[^/]+' : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
          )
          .join('/')}$`,
      ),
      params,
    ] as const,
);

/** The parameters that matter for a path, or none. */
function significantParams(path: string): readonly string[] {
  for (const [regex, params] of COMPILED_PARAMS) {
    if (regex.test(path)) return params;
  }
  return [];
}

/** Paths whose parameters are canonicalised through `VideoQuery`. */
const CANONICAL_QUERY_PATHS = new Set(['/api/videos']);

/**
 * `include` as a sorted, de-duplicated list.
 *
 * The handler treats `include` as a set — it asks "does this contain
 * `related`?" — so `related,channel` and `channel,related` produce byte-
 * identical responses. Keyed on the raw string they were two cache entries for
 * one answer: half the hit rate, two D1 round trips instead of one, and
 * `purgeVideo` (which builds the key for exactly one spelling) evicting only
 * one of them, leaving the other to serve an editor's stale video for its
 * whole TTL.
 *
 * Unknown values are kept rather than dropped. They change nothing in the
 * response today, but a key that silently discards part of its input is how a
 * future `include=transcript` gets served the answer that has no transcript.
 */
function canonicalInclude(value: string): string {
  return [
    ...new Set(
      value
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part.length > 0),
    ),
  ]
    .sort()
    .join(',');
}

/**
 * Subtrees that are never cached, whatever their handlers say.
 *
 * `/api/me` and `/api/auth` are per-visitor; `/api/admin` is staff-only, shows
 * unpublished rows, and covers the import endpoints too. All of them already
 * return `no-store`, so this is a second lock on the same door — and the one
 * that does not depend on every future handler remembering.
 */
const PRIVATE_PREFIXES = ['/api/me', '/api/auth', '/api/admin'] as const;

/**
 * Build the cache key for a request, or `null` when the request must not be
 * served from cache at all.
 */
export function cacheKeyFor(request: Request, url: URL, version: string): string | null {
  if (request.method !== 'GET') return null;

  // A caller that explicitly asked for fresh data gets it. This is what lets
  // the admin see an edit immediately without waiting for a TTL.
  const control = request.headers.get('cache-control') ?? '';
  if (control.includes('no-cache') || control.includes('no-store')) return null;

  const path = url.pathname.replace(/\/+$/, '') || '/';

  // Whole subtrees that are per-visitor by definition. Their handlers all
  // return `no-store`, so `isCacheable` would refuse to store them anyway —
  // but not looking them up at all means a bug in one of those handlers can
  // never turn into one visitor's data being served to another. The cost of
  // the check is a string comparison; the cost of being wrong is a breach.
  if (PRIVATE_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) {
    return null;
  }

  let query: string;
  if (CANONICAL_QUERY_PATHS.has(path)) {
    query = serializeQuery(parseQuery(url.searchParams)).toString();
  } else {
    const params = new URLSearchParams();
    for (const name of [...significantParams(path)].sort()) {
      const value = url.searchParams.get(name);
      if (value == null || value.length === 0) continue;
      params.set(name, name === 'include' ? canonicalInclude(value) : value);
    }
    query = params.toString();
  }

  // The version salt makes every key change at once. Bumping `CACHE_VERSION` in
  // the Cloudflare dashboard is a full invalidation with no purge API and no
  // deployment — the escape hatch for the day a wrong answer is cached.
  return `https://cache.car-tiv.internal/v${version}${path}${query.length > 0 ? `?${query}` : ''}`;
}

/** Whether a produced response is safe and worth storing. */
export function isCacheable(response: Response): boolean {
  if (response.status !== 200) return false;

  // Never cache anything that carries a cookie. Routes that set one are all
  // `no-store` already; this is the check that survives a future refactor.
  if (response.headers.getSetCookie().length > 0) return false;

  const control = response.headers.get('cache-control') ?? '';
  return control.includes('public') && /s-maxage=([1-9]\d*)/.test(control);
}

/**
 * Serve `produce()` through the cache.
 *
 * A miss stores the response after it has been sent, via `waitUntil`, so a
 * visitor never waits for the write.
 *
 * ## Where the cache does nothing
 *
 * Cloudflare documents `caches.default` as having no effect in the dashboard
 * editor, in Playground previews, and behind Cloudflare Access. Whether it is
 * fully effective on a `workers.dev` subdomain is *not* clearly documented —
 * the same docs both note that `.workers.dev` domains include the query string
 * in the cache key (which implies it works) and list only custom domains and
 * Pages as having "functional cache operations".
 *
 * Rather than guess, the code treats an ineffective cache as a supported state:
 * every request becomes a miss and the site behaves exactly as it did before
 * this file existed, only more expensively. The `x-cache` header on every API
 * response is how to find out for a given deployment — if it never says `HIT`
 * in production, the cache is not working there and a custom domain is the fix.
 * `docs/deployment.md` has this as a checklist item, because on a free plan the
 * difference is the whole read budget.
 */
export async function withEdgeCache(
  request: Request,
  url: URL,
  version: string,
  waitUntil: (work: Promise<unknown>) => void,
  produce: () => Promise<Response>,
): Promise<{ response: Response; hit: boolean }> {
  const key = cacheKeyFor(request, url, version);
  if (key == null) return { response: await produce(), hit: false };

  const cache = openCache();
  if (cache == null) return { response: await produce(), hit: false };

  const cached = await cache.match(key).catch(() => undefined);
  if (cached != null) return { response: cached, hit: true };

  const response = await produce();
  if (isCacheable(response)) {
    // `put` consumes the body, so the copy going into the cache is the clone
    // and the original is what the visitor receives.
    const copy = response.clone();
    waitUntil(cache.put(key, copy).catch(() => undefined));
  }

  return { response, hit: false };
}

/**
 * Drop the cached responses for one video.
 *
 * Best effort, and honestly so. Cloudflare's cache is per-colo and this plan
 * has no purge API, so this only clears the data centre that happened to handle
 * the admin request. Every other colo keeps its copy until the TTL expires,
 * which is why `CACHE_SECONDS.video` is five minutes rather than an hour.
 *
 * It is still worth doing: the editor who just hid a video is almost always
 * routed to the same colo a moment later, so "I hid it and it is still there"
 * — the thing that makes someone doubt the admin works at all — is fixed even
 * though full invalidation is not available.
 */
export async function purgeVideo(videoId: string, version: string): Promise<void> {
  const cache = openCache();
  if (cache == null) return;

  const id = encodeURIComponent(videoId);

  // The keys are built by `cacheKeyFor`, not written out here. Writing them by
  // hand would mean two places that have to agree about escaping and about
  // which parameters are significant — and the day they disagree, the purge
  // silently deletes nothing.
  const keys = [
    `/api/videos/${id}`,
    `/api/videos/${id}?include=related,channel`,
    `/api/videos/${id}/related`,
  ]
    .map((path) => {
      const url = new URL(path, 'https://car-tiv.internal');
      return cacheKeyFor(new Request(url, { method: 'GET' }), url, version);
    })
    .filter((key): key is string => key != null);

  await Promise.all(keys.map((key) => cache.delete(key).catch(() => undefined)));
}

/**
 * The default cache, or `null` where there is none.
 *
 * `caches` is absent in Node — the test suite calls the routes directly — and
 * is a no-op on `workers.dev`. Both are "no cache", not an error.
 */
function openCache(): Cache | null {
  try {
    const store = (globalThis as { caches?: { default?: Cache } }).caches;
    return store?.default ?? null;
  } catch {
    return null;
  }
}
