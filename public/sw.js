/**
 * The service worker.
 *
 * Written by hand rather than generated, because the interesting decisions are
 * about *this* site and a generator would hide them:
 *
 *  * **Never cache the API.** A catalog listing is edge-cached already, and a
 *    stale personal library is worse than no library. `/api/*` always goes to
 *    the network; when it fails the page's own error state handles it.
 *  * **Cache the shell and the built assets.** Vite fingerprints every file
 *    (`bootstrap-XzvWNXTQ.js`), so a hit can be served forever and a deploy
 *    simply asks for different names. Fonts, icons and CSS the same.
 *  * **Cache page shells as they are visited.** Every page is an empty shell
 *    that fetches its own data, so caching one offline costs a few kilobytes
 *    and makes the app open instantly on a second launch.
 *  * **Never cache a YouTube thumbnail.** They are cross-origin and opaque:
 *    the browser cannot tell us whether one succeeded, and storing failures
 *    would poison the cache. The browser's own HTTP cache handles them well.
 *
 * `CACHE_VERSION` is the only thing to change when the caching strategy
 * changes; a new version drops every old cache on activation.
 */

const CACHE_VERSION = 'v1';
const SHELL_CACHE = `cartiv-shell-${CACHE_VERSION}`;
const ASSET_CACHE = `cartiv-assets-${CACHE_VERSION}`;

/** What is fetched at install time, so the first offline launch works. */
const PRECACHE = ['/', '/offline.html', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      // `reload` skips the browser's HTTP cache: an install must fetch what is
      // actually deployed now, not what happened to be cached a week ago.
      .then((cache) => cache.addAll(PRECACHE.map((path) => new Request(path, { cache: 'reload' }))))
      // A failed precache must not leave the site with a half-installed worker.
      .catch(() => undefined),
  );

  // Deliberately NOT `skipWaiting()` here.
  //
  // It used to be, which quietly defeated the whole update flow: the module in
  // `src/features/pwa/service-worker.ts` waits for `registration.waiting`, shows
  // "a new version is ready" and activates only when the visitor presses
  // refresh. Skipping the wait at install meant the new worker took over
  // immediately, `waiting` was never observable, the toast almost never
  // appeared — and a page could be swapped underneath someone mid-interaction.
  //
  // The wait is released by the `skip-waiting` message below, which the page
  // sends when the visitor asks for it.
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter((name) => name.startsWith('cartiv-') && !name.endsWith(CACHE_VERSION))
            .map((name) => caches.delete(name)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  // The page asks for an update after telling the visitor one is ready.
  if (event.data === 'skip-waiting') void self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;

  // Only plain GETs are ever served from a cache. A POST is a change, and a
  // range request (video seeking) must not be answered from a whole-file entry.
  if (request.method !== 'GET' || request.headers.has('range')) return;

  const url = new URL(request.url);

  // Someone else's origin: leave it entirely to the browser.
  if (url.origin !== self.location.origin) return;

  // The API and the sitemaps are always live.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/sitemap')) return;

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(request));
    return;
  }

  if (isCacheableAsset(url)) {
    event.respondWith(cacheFirst(request));
  }
});

/**
 * Pages: network first, cache as a fallback.
 *
 * A page shell changes on every deploy and is tiny, so trying the network
 * first costs almost nothing and guarantees a visitor with a connection never
 * sees yesterday's HTML. Offline, the cached shell (or the offline page) keeps
 * the app usable — the personal library lives in local storage and renders
 * with no network at all.
 */
async function handleNavigation(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(SHELL_CACHE);
      await cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = (await caches.match(request)) ?? (await caches.match('/offline.html'));
    return (
      cached ??
      new Response('<!doctype html><title>אין חיבור</title><p>אין חיבור לאינטרנט.</p>', {
        status: 503,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    );
  }
}

/** Fingerprinted assets: serve from cache, fetch once, keep forever. */
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached != null) return cached;

  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(ASSET_CACHE);
    await cache.put(request, response.clone());
  }
  return response;
}

/** Which same-origin paths are worth keeping. */
function isCacheableAsset(url) {
  return (
    url.pathname.startsWith('/assets/') ||
    url.pathname === '/theme-bootstrap.js' ||
    url.pathname === '/manifest.webmanifest'
  );
}
