/**
 * `/api/me/*` — the signed-in visitor's own data.
 *
 * Every route here requires an account and operates only on that account's
 * rows; the user id comes from the session, never from the request, so there is
 * no parameter an attacker could change to read someone else's library.
 *
 * The shapes match the guest library in `src/data/library-repository.ts` field
 * for field. Signing in is then a merge rather than a translation, and a page
 * does not need to know which backend it is talking to.
 */

import { PAGINATION } from '@shared/constants.js';
import { parseQuery, serializeQuery } from '@shared/core/query.js';
import { isVideoId } from '@shared/core/youtube.js';
import type { VideoId, VideoSummary } from '@shared/types/catalog.js';
import type { RequestContext } from '../context.js';
import { BadRequestError } from '../lib/errors.js';
import { CACHE, ok } from '../lib/response.js';
import { get, patch, post, remove, type RouteDefinition, type RouteParams } from '../router.js';
import { requireAccount } from './auth-routes.js';
import { WATCH_LATER_KEY } from '../repositories/library-repository.js';

/** How many videos one merge request may carry. */
const MAX_MERGE_ITEMS = 1_000;

/** `GET /api/me/library` — everything, in one request. */
async function getLibrary(context: RequestContext): Promise<Response> {
  const account = requireAccount(context);
  const library = context.repositories.library;
  const userId = account.user.id;

  const [favorites, history, playlists, follows, searches] = await Promise.all([
    library.listFavorites(userId),
    library.listHistory(userId),
    library.listPlaylists(userId),
    library.listFollows(userId),
    library.listSavedSearches(userId),
  ]);

  const watchLater = playlists.find((list) => list.systemKey === WATCH_LATER_KEY);

  // One lookup for every video mentioned anywhere, so a library with a hundred
  // entries across five lists is still a single extra query.
  const ids = new Set<string>([
    ...favorites.map((item) => item.videoId),
    ...history.map((item) => item.videoId),
    ...playlists.flatMap((list) => [...list.videoIds]),
  ]);
  const summaries = await hydrate(context, ids);

  return ok(
    {
      favorites: favorites.map((item) => ({
        videoId: item.videoId,
        savedAt: item.savedAt,
        snapshot: summaries.get(item.videoId) ?? null,
      })),
      watchLater: (watchLater?.videoIds ?? []).map((videoId) => ({
        videoId,
        savedAt: watchLater?.updatedAt ?? '',
        snapshot: summaries.get(videoId) ?? null,
      })),
      history: history.map((item) => ({
        videoId: item.videoId,
        savedAt: item.savedAt,
        progressSeconds: item.progressSeconds,
        isCompleted: item.isCompleted,
        snapshot: summaries.get(item.videoId) ?? null,
      })),
      playlists: playlists
        .filter((list) => !list.isSystem)
        .map((list) => ({
          id: list.id,
          name: list.name,
          description: list.description,
          updatedAt: list.updatedAt,
          items: list.videoIds.map((videoId) => ({
            videoId,
            snapshot: summaries.get(videoId) ?? null,
          })),
        })),
      follows,
      savedSearches: searches,
    },
    {},
    { cache: CACHE.none },
  );
}

/** `POST /api/me/searches` — body `{ name, query }`. */
async function saveSearch(context: RequestContext): Promise<Response> {
  const account = requireAccount(context);
  const body = await context.readJson<{ name?: unknown; query?: unknown }>();

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (name.length === 0 || name.length > 80) {
    throw new BadRequestError('שם החיפוש חייב להיות בין תו אחד ל־80 תווים');
  }

  // Stored as a query string, and re-serialised through the shared parser so
  // a saved search can never carry a parameter the catalog does not accept.
  const raw = typeof body.query === 'string' ? body.query : '';
  const query = serializeQuery(parseQuery(new URLSearchParams(raw))).toString();

  const id = await context.repositories.library.saveSearch(account.user.id, name, query);
  return ok({ id, name, query }, {}, { status: 201, cache: CACHE.none });
}

/** `DELETE /api/me/searches/:id`. */
async function deleteSavedSearch(context: RequestContext, params: RouteParams): Promise<Response> {
  const account = requireAccount(context);
  await context.repositories.library.deleteSavedSearch(account.user.id, params.id ?? '');
  return ok({ id: params.id, deleted: true }, {}, { cache: CACHE.none });
}

/** `POST /api/me/favorites` — body `{ videoId }`. */
async function addFavorite(context: RequestContext): Promise<Response> {
  const account = requireAccount(context);
  const videoId = await readVideoId(context);
  await context.repositories.library.addFavorite(account.user.id, videoId);
  return ok({ videoId, saved: true }, {}, { status: 201, cache: CACHE.none });
}

/** `DELETE /api/me/favorites/:videoId`. */
async function removeFavorite(context: RequestContext, params: RouteParams): Promise<Response> {
  const account = requireAccount(context);
  const videoId = requireVideoIdParam(params.videoId);
  await context.repositories.library.removeFavorite(account.user.id, videoId);
  return ok({ videoId, saved: false }, {}, { cache: CACHE.none });
}

/** `POST /api/me/watch-later` — body `{ videoId }`. */
async function addWatchLater(context: RequestContext): Promise<Response> {
  const account = requireAccount(context);
  const videoId = await readVideoId(context);
  const library = context.repositories.library;

  const playlistId = await library.watchLaterId(account.user.id);
  await library.addToPlaylist(account.user.id, playlistId, videoId);

  return ok({ videoId, saved: true }, {}, { status: 201, cache: CACHE.none });
}

/** `DELETE /api/me/watch-later/:videoId`. */
async function removeWatchLater(context: RequestContext, params: RouteParams): Promise<Response> {
  const account = requireAccount(context);
  const videoId = requireVideoIdParam(params.videoId);
  const library = context.repositories.library;

  const playlistId = await library.watchLaterId(account.user.id);
  await library.removeFromPlaylist(account.user.id, playlistId, videoId);

  return ok({ videoId, saved: false }, {}, { cache: CACHE.none });
}

/** `POST /api/me/history` — body `{ videoId, progressSeconds?, isCompleted? }`. */
async function recordHistory(context: RequestContext): Promise<Response> {
  const account = requireAccount(context);
  const body = await context.readJson<{
    videoId?: unknown;
    progressSeconds?: unknown;
    isCompleted?: unknown;
  }>();

  const videoId = requireVideoIdParam(typeof body.videoId === 'string' ? body.videoId : undefined);
  const progress = typeof body.progressSeconds === 'number' ? body.progressSeconds : 0;

  await context.repositories.library.recordProgress(
    account.user.id,
    videoId,
    progress,
    body.isCompleted === true,
  );

  return ok({ videoId, recorded: true }, {}, { cache: CACHE.none });
}

/** `DELETE /api/me/history` — clear it all. */
async function clearHistory(context: RequestContext): Promise<Response> {
  const account = requireAccount(context);
  await context.repositories.library.clearHistory(account.user.id);
  return ok({ cleared: true }, {}, { cache: CACHE.none });
}

/** `DELETE /api/me/history/:videoId` — forget one video. */
async function forgetHistoryItem(context: RequestContext, params: RouteParams): Promise<Response> {
  const account = requireAccount(context);
  const videoId = requireVideoIdParam(params.videoId);
  await context.repositories.library.removeFromHistory(account.user.id, videoId);
  return ok({ videoId, removed: true }, {}, { cache: CACHE.none });
}

/** `POST /api/me/playlists` — body `{ name, description? }`. */
async function createPlaylist(context: RequestContext): Promise<Response> {
  const account = requireAccount(context);
  const body = await context.readJson<{ name?: unknown; description?: unknown }>();

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (name.length === 0 || name.length > 120) {
    throw new BadRequestError('שם הפלייליסט חייב להיות בין תו אחד ל־120 תווים');
  }

  const id = await context.repositories.library.createPlaylist(
    account.user.id,
    name,
    typeof body.description === 'string' ? body.description.slice(0, 500) : '',
  );

  return ok({ id, name }, {}, { status: 201, cache: CACHE.none });
}

/** `PATCH /api/me/playlists/:id` — rename. */
async function updatePlaylist(context: RequestContext, params: RouteParams): Promise<Response> {
  const account = requireAccount(context);
  const body = await context.readJson<{ name?: unknown; description?: unknown }>();

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (name.length === 0 || name.length > 120) {
    throw new BadRequestError('שם הפלייליסט חייב להיות בין תו אחד ל־120 תווים');
  }

  await context.repositories.library.renamePlaylist(
    account.user.id,
    params.id ?? '',
    name,
    typeof body.description === 'string' ? body.description.slice(0, 500) : '',
  );

  return ok({ id: params.id, name }, {}, { cache: CACHE.none });
}

/** `DELETE /api/me/playlists/:id`. */
async function deletePlaylist(context: RequestContext, params: RouteParams): Promise<Response> {
  const account = requireAccount(context);
  await context.repositories.library.deletePlaylist(account.user.id, params.id ?? '');
  return ok({ id: params.id, deleted: true }, {}, { cache: CACHE.none });
}

/** `POST /api/me/playlists/:id/items` — body `{ videoId }` or `{ videoIds }`. */
async function addPlaylistItem(context: RequestContext, params: RouteParams): Promise<Response> {
  const account = requireAccount(context);
  const body = await context.readJson<{ videoId?: unknown; videoIds?: unknown }>();
  const playlistId = params.id ?? '';

  // Reordering is the same endpoint with the full list, so a drag-and-drop is
  // one request rather than one per moved row.
  if (Array.isArray(body.videoIds)) {
    const ids = body.videoIds
      .filter((value): value is string => typeof value === 'string' && isVideoId(value))
      .slice(0, MAX_MERGE_ITEMS);
    await context.repositories.library.reorderPlaylist(account.user.id, playlistId, ids);
    return ok({ id: playlistId, count: ids.length }, {}, { cache: CACHE.none });
  }

  const videoId = requireVideoIdParam(typeof body.videoId === 'string' ? body.videoId : undefined);
  await context.repositories.library.addToPlaylist(account.user.id, playlistId, videoId);
  return ok({ id: playlistId, videoId }, {}, { status: 201, cache: CACHE.none });
}

/** `DELETE /api/me/playlists/:id/items/:videoId`. */
async function removePlaylistItem(context: RequestContext, params: RouteParams): Promise<Response> {
  const account = requireAccount(context);
  const videoId = requireVideoIdParam(params.videoId);
  await context.repositories.library.removeFromPlaylist(account.user.id, params.id ?? '', videoId);
  return ok({ id: params.id, videoId, removed: true }, {}, { cache: CACHE.none });
}

/** `POST /api/me/follows` — body `{ slug }`. */
async function follow(context: RequestContext): Promise<Response> {
  const account = requireAccount(context);
  const body = await context.readJson<{ slug?: unknown }>();
  const slug = typeof body.slug === 'string' ? body.slug.trim() : '';
  if (slug.length === 0) throw new BadRequestError('חסר מזהה ערוץ');

  await context.repositories.library.follow(account.user.id, slug);
  return ok({ slug, following: true }, {}, { status: 201, cache: CACHE.none });
}

/** `DELETE /api/me/follows/:slug`. */
async function unfollow(context: RequestContext, params: RouteParams): Promise<Response> {
  const account = requireAccount(context);
  await context.repositories.library.unfollow(account.user.id, params.slug ?? '');
  return ok({ slug: params.slug, following: false }, {}, { cache: CACHE.none });
}

/**
 * `POST /api/me/merge` — hand the device's guest library to the account.
 *
 * Runs at most once per (account, device): the browser sends a device id it
 * generated for itself, and a repeat call is answered without touching
 * anything. Without that, every sign-in would resurrect entries the visitor had
 * deleted from the account.
 */
async function mergeGuestLibrary(context: RequestContext): Promise<Response> {
  const account = requireAccount(context);
  const body = await context.readJson<{
    deviceId?: unknown;
    favorites?: unknown;
    watchLater?: unknown;
    history?: unknown;
  }>();

  const deviceId = typeof body.deviceId === 'string' ? body.deviceId.slice(0, 64) : '';
  if (deviceId.length === 0) throw new BadRequestError('חסר מזהה מכשיר');

  const accounts = context.repositories.accounts;
  if (await accounts.hasMergedDevice(account.user.id, deviceId)) {
    return ok({ merged: false, reason: 'already-merged' }, {}, { cache: CACHE.none });
  }

  const library = context.repositories.library;
  const userId = account.user.id;

  const favorites = readIdList(body.favorites);
  const watchLater = readIdList(body.watchLater);
  const history = readHistoryList(body.history);

  for (const videoId of favorites) await library.addFavorite(userId, videoId);

  if (watchLater.length > 0) {
    const playlistId = await library.watchLaterId(userId);
    for (const videoId of watchLater) await library.addToPlaylist(userId, playlistId, videoId);
  }

  for (const entry of history) {
    await library.recordProgress(userId, entry.videoId, entry.progressSeconds, entry.isCompleted);
  }

  const total = favorites.length + watchLater.length + history.length;
  await accounts.recordMerge(userId, deviceId, total);

  return ok(
    {
      merged: true,
      counts: {
        favorites: favorites.length,
        watchLater: watchLater.length,
        history: history.length,
      },
    },
    {},
    { cache: CACHE.none },
  );
}

// --- Helpers ---------------------------------------------------------------

/** Load summaries for a set of ids, in chunks the query planner is happy with. */
async function hydrate(
  context: RequestContext,
  ids: ReadonlySet<string>,
): Promise<Map<string, VideoSummary>> {
  const summaries = new Map<string, VideoSummary>();
  if (ids.size === 0) return summaries;

  const list = [...ids].map((id) => id as VideoId);
  for (let index = 0; index < list.length; index += PAGINATION.maxLimit) {
    const chunk = list.slice(index, index + PAGINATION.maxLimit);
    for (const video of await context.repositories.videos.findManyByIds(chunk)) {
      summaries.set(video.id, video);
    }
  }
  return summaries;
}

async function readVideoId(context: RequestContext): Promise<string> {
  const body = await context.readJson<{ videoId?: unknown }>();
  return requireVideoIdParam(typeof body.videoId === 'string' ? body.videoId : undefined);
}

function requireVideoIdParam(value: string | undefined): string {
  if (value == null || !isVideoId(value)) throw new BadRequestError('מזהה הסרטון אינו תקין');
  return value;
}

function readIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === 'string' && isVideoId(entry))
    .slice(0, MAX_MERGE_ITEMS);
}

function readHistoryList(
  value: unknown,
): { videoId: string; progressSeconds: number; isCompleted: boolean }[] {
  if (!Array.isArray(value)) return [];

  return value
    .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry != null)
    .filter((entry) => typeof entry.videoId === 'string' && isVideoId(entry.videoId))
    .slice(0, MAX_MERGE_ITEMS)
    .map((entry) => ({
      videoId: entry.videoId as string,
      progressSeconds: typeof entry.progressSeconds === 'number' ? entry.progressSeconds : 0,
      isCompleted: entry.isCompleted === true,
    }));
}

export const accountRoutes: RouteDefinition[] = [
  get('/api/me/library', getLibrary),

  post('/api/me/favorites', addFavorite),
  remove('/api/me/favorites/:videoId', removeFavorite),

  post('/api/me/watch-later', addWatchLater),
  remove('/api/me/watch-later/:videoId', removeWatchLater),

  post('/api/me/history', recordHistory),
  remove('/api/me/history', clearHistory),
  remove('/api/me/history/:videoId', forgetHistoryItem),

  post('/api/me/playlists', createPlaylist),
  patch('/api/me/playlists/:id', updatePlaylist),
  remove('/api/me/playlists/:id', deletePlaylist),
  post('/api/me/playlists/:id/items', addPlaylistItem),
  remove('/api/me/playlists/:id/items/:videoId', removePlaylistItem),

  post('/api/me/searches', saveSearch),
  remove('/api/me/searches/:id', deleteSavedSearch),

  post('/api/me/follows', follow),
  remove('/api/me/follows/:slug', unfollow),

  post('/api/me/merge', mergeGuestLibrary),
];
