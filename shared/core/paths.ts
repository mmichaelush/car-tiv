/**
 * Canonical URL builders.
 *
 * Every link in the product is produced here, so a route change is a one-file
 * change and `<link rel="canonical">`, the sitemap, the Worker redirects and
 * the UI can never disagree.
 */

import type { CategoryId, ChannelSlug, VideoId } from '../types/catalog.js';

export const ROUTES = {
  home: '/',
  search: '/search',
  channels: '/channels/',
  library: '/library/',
  playlists: '/playlists/',
  settings: '/settings/',
  addVideo: '/add-video/',
  about: '/about/',
  contact: '/contact/',
  privacy: '/privacy/',
  terms: '/terms/',
  admin: '/admin/',
} as const;

export const videoPath = (id: VideoId | string): string => `/video/${encodeURIComponent(id)}`;

export const categoryPath = (id: CategoryId): string => `/category/${encodeURIComponent(id)}`;

export const channelPath = (slug: ChannelSlug): string => `/channel/${encodeURIComponent(slug)}`;

/** `/search?q=...`, with the query already encoded. */
export const searchPath = (query: string): string =>
  query.trim().length === 0
    ? ROUTES.search
    : `${ROUTES.search}?q=${encodeURIComponent(query.trim())}`;

/** Absolute URL for canonical tags, Open Graph and share links. */
export function absoluteUrl(path: string, origin: string): string {
  return new URL(path, origin).toString();
}

/**
 * Legacy query-string URLs from the Netlify site, mapped to their replacement.
 * Returns `null` when the URL is already in the new shape.
 *
 * The Worker uses this to answer old links with a 301 instead of a 404, so
 * bookmarks and search-engine results keep working after the migration.
 */
export function legacyRedirect(pathname: string, params: URLSearchParams): string | null {
  if (pathname === '/privacy.html') return ROUTES.privacy;
  if (pathname === '/terms.html') return ROUTES.terms;
  if (pathname === '/add-video.html') return ROUTES.addVideo;

  if (pathname !== '/' && pathname !== '/index.html') return null;

  const videoId = params.get('v') ?? params.get('video');
  if (videoId != null && videoId.length > 0) return videoPath(videoId);

  const page = params.get('page') ?? params.get('view');
  if (page === 'channels') return ROUTES.channels;

  // The filters the old site put on the home page. `name` is the one that
  // matters most: it is what every category link, every footer link and every
  // indexed category URL used, e.g. `/?name=maintenance&tags=שמן&hebrew=true`.
  const category = params.get('name') ?? params.get('category');
  const filters = legacyFilters(params);

  if (category != null && category.length > 0 && category !== 'all') {
    return withQuery(categoryPath(category), filters);
  }
  if (filters.size > 0) return withQuery(ROUTES.search, filters);

  return null;
}

/**
 * The old filter parameters, translated to the new names.
 *
 * `search` -> `q`, `hebrew=true` -> `hebrew=1`; `tags` and `sort` keep their
 * names and values. Anything unrecognised is dropped rather than passed
 * through, so a stale bookmark cannot inject a parameter the parser does not
 * expect.
 */
function legacyFilters(params: URLSearchParams): URLSearchParams {
  const result = new URLSearchParams();

  const search = params.get('search');
  if (search != null && search.trim().length > 0) result.set('q', search.trim());

  const tags = params.get('tags');
  if (tags != null && tags.trim().length > 0) result.set('tags', tags.trim());

  if (params.get('hebrew') === 'true' || params.get('hebrew') === '1') result.set('hebrew', '1');

  const sort = params.get('sort');
  if (sort != null && sort.length > 0 && sort !== 'date-desc') result.set('sort', sort);

  return result;
}

function withQuery(path: string, params: URLSearchParams): string {
  const query = params.toString();
  return query.length === 0 ? path : `${path}?${query}`;
}
