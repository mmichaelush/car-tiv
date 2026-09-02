/**
 * The Worker's response cache.
 *
 * Two things are being protected here, and they pull in opposite directions.
 *
 * The first is the saving: a cache that misses on requests it should have hit
 * does nothing, and the specific way that happens is a key that varies when the
 * answer does not — a reordered query string, a `utm_source` on a shared link,
 * an explicit `?page=1` that is the default anyway.
 *
 * The second is correctness, and it is the one worth being paranoid about:
 * caching a response that carries a session cookie would serve one visitor's
 * session to the next. The routes that set cookies are all `no-store`, so this
 * should never arise — which is exactly why the check is asserted here rather
 * than assumed.
 */

import { describe, expect, it } from 'vitest';
import { cacheKeyFor, isCacheable } from '@worker/middleware/edge-cache.js';
import { cacheControl, CACHE } from '@worker/lib/response.js';
import { serializeHint } from '@worker/lib/cookies.js';
import { Router, get as route } from '@worker/router.js';

const get = (path: string, headers: Record<string, string> = {}): [Request, URL] => {
  const url = new URL(path, 'https://car-tiv.test');
  return [new Request(url, { method: 'GET', headers }), url];
};

const keyOf = (path: string, headers: Record<string, string> = {}): string | null =>
  cacheKeyFor(...get(path, headers), '1');

describe('what is eligible at all', () => {
  it('caches a plain GET', () => {
    expect(keyOf('/api/videos')).not.toBeNull();
  });

  it('never caches a write', () => {
    const url = new URL('https://car-tiv.test/api/reports');
    expect(cacheKeyFor(new Request(url, { method: 'POST' }), url, '1')).toBeNull();
  });

  it('honours a caller asking for fresh data', () => {
    // This is how an editor sees their change immediately instead of waiting
    // for a TTL — the browser sends `no-cache` on a hard reload.
    expect(keyOf('/api/videos', { 'cache-control': 'no-cache' })).toBeNull();
    expect(keyOf('/api/videos', { 'cache-control': 'no-store' })).toBeNull();
  });
});

describe('keys that should collide', () => {
  it('ignores the order parameters were written in', () => {
    expect(keyOf('/api/videos?category=review&sort=title-asc')).toBe(
      keyOf('/api/videos?sort=title-asc&category=review'),
    );
  });

  it('treats a defaulted parameter as absent', () => {
    // `page=1` and `category=all` are the defaults, so these are one query and
    // must not occupy two cache entries.
    expect(keyOf('/api/videos?page=1&category=all')).toBe(keyOf('/api/videos'));
  });

  it('ignores a tracking parameter on a shared link', () => {
    // Every link shared from social media carries one of these. Left in the
    // key, each share would be its own cache entry and hit D1 exactly once.
    expect(keyOf('/api/videos?utm_source=whatsapp')).toBe(keyOf('/api/videos'));
    expect(keyOf('/api/tags?fbclid=abc123')).toBe(keyOf('/api/tags'));
  });

  it('cannot be fragmented by parameters nobody reads', () => {
    // Without an allowlist this is a denial-of-wallet: a few thousand requests
    // with a junk parameter would fill the cache with entries that never hit
    // again, and every one of them costs a D1 read.
    expect(keyOf('/api/tags?x=1')).toBe(keyOf('/api/tags?x=99999'));
    expect(keyOf('/api/categories?nonsense=1')).toBe(keyOf('/api/categories'));
  });

  it('ignores a trailing slash', () => {
    expect(keyOf('/api/categories/')).toBe(keyOf('/api/categories'));
  });
});

describe('keys that must differ', () => {
  it('separates two pages of the same listing', () => {
    expect(keyOf('/api/videos?page=2')).not.toBe(keyOf('/api/videos'));
  });

  it('separates two categories', () => {
    expect(keyOf('/api/videos?category=review')).not.toBe(keyOf('/api/videos?category=diy'));
  });

  it('separates two searches', () => {
    expect(keyOf('/api/videos?q=מזגן')).not.toBe(keyOf('/api/videos?q=בלמים'));
  });

  it('separates the parameters an endpoint actually reads', () => {
    expect(keyOf('/api/tags?category=review')).not.toBe(keyOf('/api/tags?category=diy'));
    expect(keyOf('/api/channels?featured=1')).not.toBe(keyOf('/api/channels'));
  });

  it('separates two endpoints', () => {
    expect(keyOf('/api/tags')).not.toBe(keyOf('/api/categories'));
  });

  it('changes wholesale when the version salt changes', () => {
    // The escape hatch: bumping CACHE_VERSION invalidates everything at once,
    // with no purge API and no deployment.
    expect(cacheKeyFor(...get('/api/videos'), '2')).not.toBe(
      cacheKeyFor(...get('/api/videos'), '1'),
    );
  });
});

describe('what may be stored', () => {
  const withControl = (policy: Parameters<typeof cacheControl>[0], init: ResponseInit = {}) =>
    new Response('{}', {
      ...init,
      headers: { ...init.headers, 'cache-control': cacheControl(policy) },
    });

  it('stores a public catalog response', () => {
    expect(isCacheable(withControl(CACHE.catalog))).toBe(true);
    expect(isCacheable(withControl(CACHE.reference))).toBe(true);
  });

  it('refuses anything marked no-store', () => {
    expect(isCacheable(withControl(CACHE.none))).toBe(false);
  });

  it('refuses an error response', () => {
    expect(isCacheable(withControl(CACHE.catalog, { status: 500 }))).toBe(false);
    expect(isCacheable(withControl(CACHE.catalog, { status: 404 }))).toBe(false);
  });

  it('refuses a response carrying a cookie, whatever its cache header says', () => {
    // The scenario this exists to make impossible: a route that sets a session
    // cookie is changed to be cacheable, and the next visitor is handed the
    // previous one's session.
    const response = withControl(CACHE.catalog);
    response.headers.append('set-cookie', '__Host-session=secret; Path=/; HttpOnly');

    expect(isCacheable(response)).toBe(false);
  });

  it('refuses a response carrying only the readable hint cookie', () => {
    // The hint is harmless in itself, but it is per-visitor, so a cached copy
    // would tell the wrong people they are signed in.
    const response = withControl(CACHE.catalog);
    response.headers.append('set-cookie', serializeHint({ signedIn: true, signInAvailable: true }));

    expect(isCacheable(response)).toBe(false);
  });
});

describe('paths that are never cached at all', () => {
  it('refuses the private subtrees outright', () => {
    // These handlers all return `no-store`, so `isCacheable` would refuse them
    // anyway. The point of checking here too is that a future handler which
    // forgets `no-store` still cannot leak one visitor's data to another.
    for (const path of [
      '/api/me/library',
      '/api/me/favorites',
      '/api/auth/session',
      '/api/admin/overview',
      '/api/admin/imports/abc',
    ]) {
      expect(keyOf(path)).toBeNull();
    }
  });

  it('does not mistake a public path for a private one', () => {
    // `/api/media` starts with the same letters as `/api/me`; a naive
    // `startsWith` would silently stop caching it.
    expect(keyOf('/api/metadata')).not.toBeNull();
    expect(keyOf('/api/videos')).not.toBeNull();
  });
});

describe('routes with a path parameter', () => {
  it('separates two limits on the same related-videos request', () => {
    // The bug this catches: keyed on the literal path, `?limit=5` and
    // `?limit=12` share one entry, and whichever ran first decides what
    // everyone gets. The handler reads `limit`, so the key must too.
    expect(keyOf('/api/videos/dQw4w9WgXcQ/related?limit=5')).not.toBe(
      keyOf('/api/videos/dQw4w9WgXcQ/related?limit=12'),
    );
  });

  it('separates two videos', () => {
    expect(keyOf('/api/videos/dQw4w9WgXcQ/related')).not.toBe(
      keyOf('/api/videos/aQw4w9WgXcZ/related'),
    );
  });

  it('separates the combined page payload from the plain video', () => {
    // `?include=` changes the body, so it has to change the key — otherwise a
    // video page could be served the payload without its related videos.
    expect(keyOf('/api/videos/dQw4w9WgXcQ?include=related,channel')).not.toBe(
      keyOf('/api/videos/dQw4w9WgXcQ'),
    );
  });

  it('still ignores parameters those routes do not read', () => {
    expect(keyOf('/api/videos/dQw4w9WgXcQ?utm_source=x')).toBe(keyOf('/api/videos/dQw4w9WgXcQ'));
  });
});

describe('routes the router itself has to match', () => {
  it('matches a parameter in the middle of a path segment', () => {
    // Not a cache concern, but the same class of bug: the router only treated a
    // segment starting with `:` as a parameter, so `/sitemap-videos-:page.xml`
    // was escaped whole and matched only its own literal text. Every video
    // sitemap the index advertises returned the 404 page — a list of broken
    // URLs handed to search engines for all 7,876 videos.
    const routes = new Router().add(
      route('/sitemap-videos-:page.xml', () => new Response()),
      route('/api/videos/:id/related', () => new Response()),
    );

    const sitemap = routes.match('GET', '/sitemap-videos-7.xml');
    expect('handler' in sitemap).toBe(true);
    expect('handler' in sitemap ? sitemap.params.page : null).toBe('7');
  });

  it('still refuses a parameter that would swallow a slash', () => {
    const routes = new Router().add(route('/api/videos/:id', () => new Response()));
    expect('handler' in routes.match('GET', '/api/videos/a/b')).toBe(false);
  });

  it('still refuses an empty parameter', () => {
    const routes = new Router().add(route('/sitemap-videos-:page.xml', () => new Response()));
    expect('handler' in routes.match('GET', '/sitemap-videos-.xml')).toBe(false);
  });

  it('treats the literal suffix as literal, not as a regex', () => {
    // `.xml` must match a dot, not any character.
    const routes = new Router().add(route('/sitemap-videos-:page.xml', () => new Response()));
    expect('handler' in routes.match('GET', '/sitemap-videos-1Xxml')).toBe(false);
  });
});
