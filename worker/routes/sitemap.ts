/**
 * `/sitemap.xml` — generated from the catalog.
 *
 * A static file would go stale the moment an editor publishes a video, and a
 * 7,900-entry file is not something to keep in the repository. Generating it
 * from D1 and caching it at the edge for a day costs one query per day and is
 * always correct.
 *
 * The sitemap index splits video URLs into pages of 5,000, comfortably under
 * the 50,000-URL / 50 MB limits search engines impose.
 */

import { categoryPath, channelPath, ROUTES, videoPath } from '@shared/core/paths.js';
import type { RequestContext } from '../context.js';
import { appOrigin } from '../env.js';
import { get, type RouteDefinition, type RouteParams } from '../router.js';

const PAGE_SIZE = 5_000;
const CACHE_HEADER = 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400';

/** Static pages, with how important and how often they change. */
const STATIC_PAGES: readonly { path: string; changefreq: string; priority: string }[] = [
  { path: ROUTES.home, changefreq: 'daily', priority: '1.0' },
  { path: ROUTES.channels, changefreq: 'weekly', priority: '0.7' },
  { path: ROUTES.addVideo, changefreq: 'monthly', priority: '0.5' },
  { path: ROUTES.about, changefreq: 'monthly', priority: '0.4' },
  { path: ROUTES.contact, changefreq: 'monthly', priority: '0.4' },
  { path: ROUTES.privacy, changefreq: 'yearly', priority: '0.2' },
  { path: ROUTES.terms, changefreq: 'yearly', priority: '0.2' },
];

/** `GET /sitemap.xml` — the index. */
async function sitemapIndex(context: RequestContext): Promise<Response> {
  const origin = appOrigin(context.env, context.url.origin);
  const total = await countPublishedVideos(context);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const entries = [
    `${origin}/sitemap-pages.xml`,
    ...Array.from(
      { length: pages },
      (_unused, index) => `${origin}/sitemap-videos-${String(index + 1)}.xml`,
    ),
  ];

  return xml(
    `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries.map((location) => `  <sitemap><loc>${escapeXml(location)}</loc></sitemap>`).join('\n')}
</sitemapindex>`,
  );
}

/** `GET /sitemap-pages.xml` — static pages, categories and channels. */
async function sitemapPages(context: RequestContext): Promise<Response> {
  const origin = appOrigin(context.env, context.url.origin);

  const [categories, channels] = await Promise.all([
    context.repositories.catalog.listCategories(),
    context.repositories.catalog.listChannels({ limit: 60, page: 1 }),
  ]);

  const urls = [
    ...STATIC_PAGES.map((page) => ({ loc: origin + page.path, ...page })),
    ...categories.map((category) => ({
      loc: origin + categoryPath(category.id),
      changefreq: 'daily',
      priority: '0.8',
    })),
    ...channels.items.map((channel) => ({
      loc: origin + channelPath(channel.slug),
      changefreq: 'weekly',
      priority: '0.6',
    })),
  ];

  return xml(urlset(urls));
}

/** `GET /sitemap-videos-:page.xml`. */
async function sitemapVideos(context: RequestContext, params: RouteParams): Promise<Response> {
  const origin = appOrigin(context.env, context.url.origin);

  // `Math.max(1, Number('abc'))` is `NaN`, which would reach the query as the
  // OFFSET. Anything that is not a whole number is page one — a crawler asking
  // for nonsense gets the first page rather than a 500.
  const raw = Number(params.page ?? 1);
  const page = Number.isInteger(raw) && raw >= 1 ? raw : 1;

  const rows = await context.repositories.videos.listForSitemap((page - 1) * PAGE_SIZE, PAGE_SIZE);

  return xml(
    urlset(
      rows.map((video) => ({
        loc: origin + videoPath(video.id),
        lastmod: video.addedAt.slice(0, 10),
        changefreq: 'monthly',
        priority: '0.6',
      })),
    ),
  );
}

async function countPublishedVideos(context: RequestContext): Promise<number> {
  const stats = await context.repositories.catalog.stats();
  return stats.videos;
}

function urlset(
  urls: readonly { loc: string; lastmod?: string; changefreq?: string; priority?: string }[],
): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls
  .map(
    (url) =>
      `  <url><loc>${escapeXml(url.loc)}</loc>` +
      (url.lastmod == null ? '' : `<lastmod>${url.lastmod}</lastmod>`) +
      (url.changefreq == null ? '' : `<changefreq>${url.changefreq}</changefreq>`) +
      (url.priority == null ? '' : `<priority>${url.priority}</priority>`) +
      `</url>`,
  )
  .join('\n')}
</urlset>`;
}

function xml(body: string): Response {
  return new Response(body, {
    headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': CACHE_HEADER },
  });
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export const sitemapRoutes: RouteDefinition[] = [
  get('/sitemap.xml', sitemapIndex),
  get('/sitemap-pages.xml', sitemapPages),
  get('/sitemap-videos-:page.xml', sitemapVideos),
];
