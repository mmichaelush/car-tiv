/**
 * Read-only catalog endpoints.
 *
 * Handlers here are thin on purpose: parse the query, call a repository or a
 * service, pick a cache policy. Anything longer than a dozen lines belongs in
 * `worker/services`.
 */

import { PAGINATION, RELATED, SEARCH, TAGS } from '@shared/constants.js';
import { clampLimit } from '@shared/core/pagination.js';
import { parseQuery } from '@shared/core/query.js';
import { extractVideoId, isVideoId } from '@shared/core/youtube.js';
import type { RequestContext } from '../context.js';
import { BadRequestError, NotFoundError } from '../lib/errors.js';
import { CACHE, ok, okList } from '../lib/response.js';
import { get, type RouteDefinition, type RouteParams } from '../router.js';
import { HomeService } from '../services/home-service.js';
import { SearchService } from '../services/search-service.js';
import { ERROR_CODES } from '@shared/constants.js';

/** `GET /api/videos` — the one listing endpoint every page uses. */
async function listVideos(context: RequestContext): Promise<Response> {
  const query = parseQuery(context.url.searchParams);
  const search = new SearchService(
    context.repositories.videos,
    context.repositories.catalog,
    context.repositories.search,
    context.logger,
  );

  const page = await search.search(query);

  // Logging the search is deliberately not awaited: it must not add latency,
  // and a failed write must not fail the request.
  if (query.q.trim().length >= SEARCH.minQueryLength) {
    context.waitUntil(search.record(query, page.meta.total));
  }

  return okList(page.items, page.meta, { cache: CACHE.catalog });
}

/**
 * `GET /api/videos/:id` — one video, optionally with everything its page needs.
 *
 * `?include=related,channel` is what makes a video page cost two Worker
 * requests instead of four.
 *
 * Cloudflare's free plan allows 100,000 Worker requests a day, and after the
 * D1 read work that is now the binding constraint rather than rows or storage.
 * The video page was the most expensive page on the site: the HTML, then
 * `/api/videos/:id`, then `/api/videos/:id/related`, then
 * `/api/channels/:slug`. Four requests, and unlike the reference endpoints none
 * of them is reusable on the next video — every one is a genuine miss.
 *
 * Folding them into one halves that. The three queries still run, but the
 * request, the routing, the account resolution and the cache lookup are paid
 * once instead of three times, and one cache entry now serves the whole page.
 *
 * The separate endpoints stay exactly as they were. `include` is opt-in, so
 * nothing that already calls them changes behaviour — this adds a cheaper path
 * rather than replacing the existing one.
 */
async function getVideo(context: RequestContext, params: RouteParams): Promise<Response> {
  const id = requireVideoId(params.id);
  const include = parseInclude(context.url.searchParams.get('include'));

  const video = await context.repositories.videos.findById(id);
  if (video == null) throw new NotFoundError('הסרטון לא נמצא', ERROR_CODES.videoNotFound);

  if (!include.related && !include.channel) {
    return ok(video, {}, { cache: CACHE.video });
  }

  // Both extras are independent of each other and of nothing else, so they run
  // together rather than one after the other.
  const [related, channelVideos] = await Promise.all([
    include.related
      ? context.repositories.videos.findRelated(id, RELATED.max)
      : Promise.resolve(null),
    include.channel && video.channel != null
      ? context.repositories.videos.findByChannel(video.channel.slug, id, CHANNEL_SIDEBAR_LIMIT)
      : Promise.resolve(null),
  ]);

  return ok({ ...video, related, channelVideos }, {}, { cache: CACHE.video });
}

/** How many of a channel's other videos the video page's sidebar shows. */
const CHANNEL_SIDEBAR_LIMIT = 6;

/**
 * Read `?include=`.
 *
 * An unknown name is ignored rather than rejected: this parameter exists to
 * save requests, and failing a video page because a caller asked for something
 * that does not exist would trade a saving for an outage.
 */
function parseInclude(raw: string | null): { related: boolean; channel: boolean } {
  const names = new Set((raw ?? '').split(',').map((name) => name.trim()));
  return { related: names.has('related'), channel: names.has('channel') };
}

/** `GET /api/videos/:id/related`. */
async function getRelated(context: RequestContext, params: RouteParams): Promise<Response> {
  const id = requireVideoId(params.id);
  const limit = clampLimit(context.url.searchParams.get('limit') ?? RELATED.max, RELATED.max);
  const videos = await context.repositories.videos.findRelated(id, limit);
  return ok(videos, { count: videos.length }, { cache: CACHE.video });
}

/** `GET /api/videos/exists?value=` — the duplicate check on the suggest form. */
async function videoExists(context: RequestContext): Promise<Response> {
  const raw = context.url.searchParams.get('value') ?? '';
  const id = extractVideoId(raw);
  if (id == null) {
    throw new BadRequestError('הקישור או המזהה אינם תקינים', ERROR_CODES.invalidVideoId);
  }

  const state = await context.repositories.videos.existsAnywhere(id);
  return ok({ id, exists: state.published || state.pending, ...state });
}

/** `GET /api/categories`. */
async function listCategories(context: RequestContext): Promise<Response> {
  const categories = await context.repositories.catalog.listCategories();
  return ok(categories, { count: categories.length }, { cache: CACHE.reference });
}

/** `GET /api/channels`. */
async function listChannels(context: RequestContext): Promise<Response> {
  const params = context.url.searchParams;
  const page = await context.repositories.catalog.listChannels({
    q: params.get('q') ?? undefined,
    // NetFree-open channels only, unless a caller explicitly asks for all.
    //
    // `is_featured` records that the channel's own YouTube page opens behind
    // the filter — see `toChannel`. The directory used to list all 416, most of
    // which are a dead end: their videos play, but the channel page they link
    // to does not open. `?all=1` is there for the admin and for anything that
    // legitimately wants the whole list.
    featuredOnly: params.get('all') !== '1',
    page: Number(params.get('page') ?? 1),
    limit: Number(params.get('limit') ?? PAGINATION.defaultLimit),
  });
  return okList(page.items, page.meta, { cache: CACHE.reference });
}

/** `GET /api/channels/:slug`, with that channel's newest videos. */
async function getChannel(context: RequestContext, params: RouteParams): Promise<Response> {
  const slug = params.slug ?? '';
  const channel = await context.repositories.catalog.findChannel(slug);
  if (channel == null) throw new NotFoundError('הערוץ לא נמצא');

  const videos = await context.repositories.videos.findByChannel(
    slug,
    null,
    PAGINATION.defaultLimit,
  );
  // `CACHE.catalog`, not `CACHE.reference`, even though a channel *is*
  // reference data: this response also carries that channel's newest videos,
  // and those are catalog rows. Under the reference TTL a video an editor had
  // just hidden stayed visible on its channel page for an hour, while the same
  // video vanished from every other listing in two minutes — which reads as
  // the admin having half-worked.
  return ok({ channel, videos }, {}, { cache: CACHE.catalog });
}

/** `GET /api/tags?category=` — the popular tags in the filter panel. */
async function listTags(context: RequestContext): Promise<Response> {
  const params = context.url.searchParams;
  const tags = await context.repositories.catalog.listPopularTags(
    params.get('category') ?? 'all',
    clampLimit(params.get('limit') ?? TAGS.maxPopular, TAGS.maxPopular),
  );
  return ok(tags, { count: tags.length }, { cache: CACHE.reference });
}

/** `GET /api/tags/search?q=` — "add another tag". */
async function searchTags(context: RequestContext): Promise<Response> {
  const params = context.url.searchParams;
  // Clamped for the same reason as `/api/search/suggestions` below: both
  // parameters are part of this route's cache key, so an unbounded value is an
  // unbounded key as well as an unbounded LIKE.
  const tags = await context.repositories.catalog.searchTags(
    (params.get('q') ?? '').slice(0, SEARCH.maxQueryLength),
    (params.get('category') ?? 'all').slice(0, SEARCH.maxQueryLength),
  );
  return ok(tags, { count: tags.length }, { cache: CACHE.catalog });
}

/** `GET /api/search/suggestions?q=`. */
async function suggestions(context: RequestContext): Promise<Response> {
  // Clamped, not rejected. This is the box someone is typing into, so an
  // over-long value is a paste or a probe, never a mistake worth a 400 —
  // but it must not reach the index or the cache key unbounded. `/api/videos`
  // has always clamped through `parseQuery`; this route read the parameter
  // raw, and `q` is part of its cache key, so an unbounded string was both an
  // unbounded FTS query and an unbounded key.
  const query = (context.url.searchParams.get('q') ?? '').slice(0, SEARCH.maxQueryLength);
  if (query.trim().length < SEARCH.minQueryLength) return ok([], { count: 0 });

  const search = new SearchService(
    context.repositories.videos,
    context.repositories.catalog,
    context.repositories.search,
    context.logger,
  );
  const rows = await search.suggest(query);
  return ok(rows, { count: rows.length }, { cache: CACHE.catalog });
}

/** `GET /api/home` — everything the home page needs, in one request. */
async function home(context: RequestContext): Promise<Response> {
  const service = new HomeService(
    context.repositories.videos,
    context.repositories.catalog,
    context.logger,
  );
  const payload = await service.build(context.flags.accounts || context.flags.myCar);
  return ok(payload, {}, { cache: CACHE.home });
}

/** `GET /api/stats` — the counters in the hero strip. */
async function stats(context: RequestContext): Promise<Response> {
  const value = await context.repositories.catalog.stats();
  return ok(value, {}, { cache: CACHE.reference });
}

/** Validate a path parameter that must be a YouTube id. */
function requireVideoId(value: string | undefined) {
  if (value == null || !isVideoId(value)) {
    throw new BadRequestError('מזהה הסרטון אינו תקין', ERROR_CODES.invalidVideoId);
  }
  return value;
}

/**
 * Route table.
 *
 * Order matters: `/api/videos/exists` must be registered before
 * `/api/videos/:id`, or the literal path would be captured as an id.
 */
export const catalogRoutes: RouteDefinition[] = [
  get('/api/videos', listVideos),
  get('/api/videos/exists', videoExists),
  get('/api/videos/:id', getVideo),
  get('/api/videos/:id/related', getRelated),

  get('/api/categories', listCategories),

  get('/api/channels', listChannels),
  get('/api/channels/:slug', getChannel),

  get('/api/tags', listTags),
  get('/api/tags/search', searchTags),

  get('/api/search/suggestions', suggestions),

  get('/api/home', home),
  get('/api/stats', stats),
];
