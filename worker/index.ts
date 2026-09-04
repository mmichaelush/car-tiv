/**
 * CAR-טיב Worker — the single entry point.
 *
 * Three responsibilities, in this order:
 *   1. `/api/*` — the JSON API, dispatched through `worker/routes`.
 *   2. Legacy URLs — the query-string links the Netlify site handed out get a
 *      301 to their replacement, so bookmarks and search results keep working.
 *   3. Everything else — served from the built front-end in `dist/`, with the
 *      dynamic `/video/:id`, `/category/:id` and `/channel/:slug` routes
 *      rewritten to their page shell.
 *
 * The handler itself stays short: anything that needs more than a few lines
 * lives in `routes`, `services` or `middleware`.
 */

import type { ExecutionContext, ScheduledController } from '@cloudflare/workers-types';
import { ERROR_CODES } from '@shared/constants.js';
import { legacyRedirect } from '@shared/core/paths.js';
import { isVideoId } from '@shared/core/youtube.js';
import { createContext, resolveAccount } from './context.js';
import type { Env } from './env.js';
import { appOrigin } from './env.js';
import { handleErrors } from './middleware/error-handler.js';
import { withSecurityHeaders } from './middleware/security-headers.js';
import { withEdgeCache } from './middleware/edge-cache.js';
import { fail, permanentRedirect } from './lib/response.js';
import { router } from './routes/index.js';
import { MaintenanceService } from './services/maintenance-service.js';
import { sitemapRoutes } from './routes/sitemap.js';
import { Router } from './router.js';

/** Sitemaps live outside `/api`, so they get their own tiny router. */
const sitemapRouter = new Router().add(...sitemapRoutes);

/**
 * Dynamic routes and the static page that renders them.
 *
 * Workers Static Assets cannot serve `/video/dQw4w9WgXcQ` from
 * `video/index.html` on its own, so the Worker rewrites the request. The page
 * reads the id from its own URL — the rewrite is invisible to the browser, and
 * the URL stays shareable.
 */
const DYNAMIC_PAGES: readonly { pattern: RegExp; page: string }[] = [
  { pattern: /^\/video\/([^/]+)\/?$/, page: '/video/index.html' },
  { pattern: /^\/category\/([^/]+)\/?$/, page: '/category/index.html' },
  { pattern: /^\/channel\/([^/]+)\/?$/, page: '/channel/index.html' },
];

const handler = {
  /**
   * Cron Trigger. Runs the maintenance jobs — see
   * `worker/services/maintenance-service.ts` for what they are and why.
   *
   * `waitUntil` is what keeps the invocation alive: without it, the runtime is
   * free to tear the isolate down the moment this function returns, and the
   * work would be cut off mid-batch.
   */
  scheduled(event: ScheduledController, env: Env, executionContext: ExecutionContext): void {
    const context = createContext(
      new Request(appOrigin(env, 'https://car-tiv.local')),
      env,
      executionContext,
    );

    executionContext.waitUntil(
      new MaintenanceService(
        context.repositories.maintenance,
        context.repositories.counters,
        context.repositories.searchIndex,
        context.logger,
      )
        .run(env)
        .then(() => undefined)
        .catch((cause: unknown) => {
          context.logger.error('Scheduled maintenance failed', {
            cron: event.cron,
            error: cause instanceof Error ? cause.message : String(cause),
          });
        }),
    );
  },

  async fetch(request: Request, env: Env, executionContext: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const context = createContext(request, env, executionContext);
    const started = Date.now();

    // --- 1. API -----------------------------------------------------------
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      // A cache hit answers without touching D1 at all. This is the difference
      // between a page view costing thousands of rows read and costing none;
      // see `worker/middleware/edge-cache.ts` for why `s-maxage` alone was not
      // doing it.
      const { response, hit } = await withEdgeCache(
        request,
        url,
        env.CACHE_VERSION ?? '1',
        (work) => {
          executionContext.waitUntil(work);
        },
        () =>
          handleErrors(async () => {
            // Who is calling, before any route runs. Costs nothing without a
            // session cookie, which is the overwhelming majority of requests.
            await resolveAccount(context);

            const match = router.match(request.method, url.pathname);

            if (!('handler' in match)) {
              return match.pathMatched
                ? fail(405, ERROR_CODES.badRequest, 'הפעולה אינה נתמכת בנתיב זה', {
                    headers: { allow: allowedMethods(url.pathname) },
                  })
                : fail(404, ERROR_CODES.notFound, 'הנתיב לא נמצא');
            }

            return match.handler(context, match.params);
          }, context.logger),
      );

      context.logger.info('api', {
        status: response.status,
        cache: hit ? 'hit' : 'miss',
        durationMs: Date.now() - started,
      });

      const headers = new Headers(response.headers);
      headers.set('x-request-id', context.requestId);
      // Useful in the browser's network panel and in a `curl -I`, and the only
      // way to tell a served-from-cache response from a fresh one.
      headers.set('x-cache', hit ? 'HIT' : 'MISS');

      // `new Headers(other)` folds several `Set-Cookie` values into one
      // comma-joined string, and browsers do not split that back apart — the
      // sign-in callback sets two cookies at once, so they are re-applied
      // individually here.
      const cookies = response.headers.getSetCookie();
      if (cookies.length > 1) {
        headers.delete('set-cookie');
        for (const cookie of cookies) headers.append('set-cookie', cookie);
      }

      return new Response(response.body, { status: response.status, headers });
    }

    // --- 2. Sitemaps ------------------------------------------------------
    // Generated from D1 rather than shipped as a file, so they cannot go stale.
    //
    // Through the same cache as the API. These carry `s-maxage=86400` and a
    // comment claiming one query a day, which was not true: `s-maxage` alone
    // caches nothing for a Worker response, so every crawler hit — and a
    // crawler hits every page of the index — went to D1. A sitemap page is
    // 5,000 rows, so this was the single most expensive request on the site.
    // `/robots.txt` rides with them: it names the sitemap by absolute URL,
    // which means it needs `APP_URL`, which means it cannot be a static file.
    if (url.pathname.startsWith('/sitemap') || url.pathname === '/robots.txt') {
      const match = sitemapRouter.match(request.method, url.pathname);
      if ('handler' in match) {
        const { response, hit } = await withEdgeCache(
          request,
          url,
          env.CACHE_VERSION ?? '1',
          (work) => {
            executionContext.waitUntil(work);
          },
          () => handleErrors(async () => match.handler(context, match.params), context.logger),
        );

        const headers = new Headers(response.headers);
        headers.set('x-cache', hit ? 'HIT' : 'MISS');
        return new Response(response.body, { status: response.status, headers });
      }
    }

    // --- 3. Legacy URLs ---------------------------------------------------
    const redirect = legacyRedirect(url.pathname, url.searchParams);
    if (redirect != null) return permanentRedirect(new URL(redirect, url.origin).toString());

    // --- 4. Pages ---------------------------------------------------------
    return withSecurityHeaders(await servePage(request, env, url), env);
  },
};

export default handler;

/** Serve a page from the built assets, rewriting the dynamic routes. */
async function servePage(request: Request, env: Env, url: URL): Promise<Response> {
  for (const route of DYNAMIC_PAGES) {
    const match = route.pattern.exec(url.pathname);
    if (match == null) continue;

    // A malformed video id should be a 404 page, not a shell that then fails
    // to load anything.
    if (route.page === '/video/index.html' && !isVideoId(match[1] ?? '')) break;

    const assetUrl = new URL(route.page, url.origin);
    return env.ASSETS.fetch(new Request(assetUrl, request));
  }

  return env.ASSETS.fetch(request);
}

/** `Allow` header for a 405, derived from the route table. */
function allowedMethods(pathname: string): string {
  const methods = router
    .list()
    .filter((route) => matchesPattern(route.path, pathname))
    .map((route) => route.method);
  return [...new Set(methods)].join(', ');
}

function matchesPattern(pattern: string, pathname: string): boolean {
  const source = pattern
    .split('/')
    .map((segment) => (segment.startsWith(':') ? '[^/]+' : escapeRegex(segment)))
    .join('/');
  return new RegExp(`^${source}/?$`).test(pathname);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
