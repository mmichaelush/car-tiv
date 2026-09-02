/**
 * Signing in, and keeping the personal library in step with the account.
 *
 * The design in one sentence: **local storage stays the thing the page reads,
 * and the account is the copy that outlives the device.**
 *
 * That gives instant, offline-tolerant behaviour — a heart fills the moment it
 * is pressed, with no round trip and no spinner — while a second device still
 * sees the same library. Concretely, on a page with an account:
 *
 *  1. the guest library is handed over once per device (the server refuses a
 *     second merge, so entries the visitor deleted do not come back);
 *  2. the account's copy is pulled down and replaces the local lists;
 *  3. every later change is written locally *and* mirrored to the account,
 *     fire-and-forget — a failed mirror never undoes what the visitor did, and
 *     the next page load reconciles from the server.
 *
 * Signed out, none of this runs and the site behaves exactly as before.
 */

import type {
  HistoryEntry,
  LibraryEntry,
  Playlist,
  PlaylistItem,
  SavedSearch,
} from '@shared/types/user.js';
import type { VideoId, VideoSummary } from '@shared/types/catalog.js';
import {
  account,
  type RemoteEntry,
  type RemoteLibrary,
  type SessionInfo,
} from '../../data/account-repository.js';
import { library, setLibraryMirror } from '../../data/library-repository.js';
import { ApiError } from '../../data/http-client.js';
import { LocalStore } from '../../data/local-store.js';
import { toastError, toastSuccess } from '../../ui/components/toast.js';
import { clearSessionHint, readSessionHint } from './session-hint.js';

/** A random id for this browser, so the merge can run exactly once per device. */
const deviceStore = new LocalStore<{ id: string }>('device', { id: '' });

/** The session, once resolved. `undefined` means "not asked yet". */
let current: SessionInfo | undefined;

/** Anyone who wants to re-render when the session resolves. */
const listeners = new Set<(session: SessionInfo) => void>();

export function onSessionChange(listener: (session: SessionInfo) => void): () => void {
  if (current != null) listener(current);
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The session as last resolved, or `null` while the request is in flight. */
export function currentSession(): SessionInfo | null {
  return current ?? null;
}

export function isSignedIn(): boolean {
  return current?.user != null;
}

export function signInHref(returnPath?: string): string {
  return account.signInHref(returnPath);
}

export async function signOut(): Promise<void> {
  try {
    await account.logout();
  } catch {
    // Even if the request failed, the visitor asked to leave — reloading with
    // a dead cookie lands them signed out either way.
  }
  setLibraryMirror(null);
  window.location.reload();
}

/**
 * Resolve the session and, if there is one, sync the library.
 *
 * Never throws: an account problem must not stop the catalog from rendering.
 */
export async function initAccount(): Promise<SessionInfo> {
  const session = await resolveSession();

  current = session;
  for (const listener of listeners) listener(session);

  reportSignInOutcome();

  if (session.user != null) {
    installMirror();
    // Not awaited by the caller's page render: syncing is a background task,
    // and the local copy is already on screen.
    void syncLibrary();
  }

  return session;
}

/**
 * Who is signed in — asking the server only when that could possibly matter.
 *
 * A visitor who has never signed in has a hint cookie saying so, and there is
 * nothing the server could add: there is no name to show and no library to
 * sync, only a sign-in button whose presence the same cookie already reports.
 * Skipping the request here is what takes a page load from three Worker
 * requests to two, for the overwhelming majority of traffic.
 *
 * The request is still made whenever the hint says there *is* a session (the
 * name and avatar in the menu can only come from the server), and whenever
 * there is no hint at all — a first visit, a cleared cookie jar, a browser that
 * refuses cookie access. In those cases the behaviour is exactly what it was
 * before this optimisation existed.
 */
async function resolveSession(): Promise<SessionInfo> {
  const hint = readSessionHint();

  if (hint != null && !hint.signedIn) {
    return { user: null, roles: [], signInAvailable: hint.signInAvailable };
  }

  return account
    .session()
    .catch((): SessionInfo => ({ user: null, roles: [], signInAvailable: false }));
}

/**
 * Re-ask the server, ignoring the hint.
 *
 * Called when an account endpoint answers 401: the session ended somewhere else
 * — signed out on another device, or revoked — while this browser was still
 * showing a signed-in menu.
 */
export async function refreshSession(): Promise<SessionInfo> {
  clearSessionHint();
  const session = await account
    .session()
    .catch((): SessionInfo => ({ user: null, roles: [], signInAvailable: false }));

  current = session;
  for (const listener of listeners) listener(session);
  if (session.user == null) setLibraryMirror(null);
  return session;
}

/** `?auth=failed` comes back from the OAuth callback when something went wrong. */
function reportSignInOutcome(): void {
  const url = new URL(window.location.href);
  const outcome = url.searchParams.get('auth');
  if (outcome == null) return;

  if (outcome === 'failed' || outcome === 'error') toastError('ההתחברות לא הושלמה. אפשר לנסות שוב');

  // Take the marker out of the address bar, so a refresh does not repeat it.
  url.searchParams.delete('auth');
  window.history.replaceState(null, '', url.pathname + url.search + url.hash);
}

/** Hand the guest library over, then adopt the account's copy. */
async function syncLibrary(): Promise<void> {
  try {
    await mergeOnce();
    const remote = await account.library();
    await library.replaceLists(fromRemote(remote));
  } catch (cause) {
    // A 401 means the hint cookie is stale — the session ended elsewhere. Put
    // the menu right rather than leaving it claiming a session that is gone.
    if (cause instanceof ApiError && cause.status === 401) {
      void refreshSession();
      return;
    }
    // Otherwise: offline, or the account API is unavailable. The local library
    // is intact and every change made meanwhile is still queued in it; the next
    // load tries again.
  }
}

/** Push this device's guest library up. The server ignores a repeat. */
async function mergeOnce(): Promise<void> {
  const data = await library.exportAll();

  const payload = {
    deviceId: deviceId(),
    favorites: data.favorites.map((entry) => entry.videoId),
    watchLater: data.watchLater.map((entry) => entry.videoId),
    history: data.history.map((entry) => ({
      videoId: entry.videoId,
      progressSeconds: entry.progressSeconds,
      isCompleted: entry.completed,
    })),
  };

  const total = payload.favorites.length + payload.watchLater.length + payload.history.length;
  if (total === 0) return;

  const result = await account.mergeDeviceLibrary(payload);
  if (result.merged) toastSuccess('הספרייה שלכם מהמכשיר הזה נשמרה בחשבון');
}

function deviceId(): string {
  const stored = deviceStore.read().id;
  if (stored.length > 0) return stored;

  const id = crypto.randomUUID();
  deviceStore.write({ id });
  return id;
}

/**
 * Mirror local changes to the account.
 *
 * Every call is fire-and-forget: `void` plus a swallowed rejection. A failed
 * mirror is not shown to the visitor, because there is nothing for them to do
 * about it and the change they made is safe locally.
 */
function installMirror(): void {
  const quiet = (work: Promise<unknown>): void => {
    void work.catch((cause: unknown) => {
      // One failure is worth reacting to. A 401 means this browser is showing a
      // signed-in menu for a session that has ended — revoked, or signed out on
      // another device — so the hint cookie is now a lie. Clearing it and
      // re-asking puts the menu right and stops every later mirror from failing
      // the same way.
      if (cause instanceof ApiError && cause.status === 401) void refreshSession();
    });
  };

  setLibraryMirror({
    favorite: (videoId, added) =>
      quiet(added ? account.addFavorite(videoId) : account.removeFavorite(videoId)),
    watchLater: (videoId, added) =>
      quiet(added ? account.addWatchLater(videoId) : account.removeWatchLater(videoId)),
    progress: (videoId, seconds, completed) =>
      quiet(account.recordProgress(videoId, seconds, completed)),
    clearList: (name) => {
      if (name === 'history') quiet(account.clearHistory());
    },
    // Playlists are created locally first, so the local id is what the rest of
    // the page uses. The server id is remembered here, and every later call
    // translates through it.
    createPlaylist: (localId, name, description) =>
      quiet(
        account.createPlaylist(name, description).then((created) => {
          playlistIds.set(localId, created.id);
          // Persisted here, not on the next mirrored action. The mapping used
          // to live in memory until some *other* playlist action happened to
          // run `withRemoteId`; a reload before that lost it, and every later
          // change to this playlist then silently failed to reach the server.
          persistPlaylistIds();
        }),
      ),
    renamePlaylist: (localId, name, description) =>
      withRemoteId(localId, (id) => quiet(account.renamePlaylist(id, name, description))),
    deletePlaylist: (localId) =>
      withRemoteId(localId, (id) => {
        quiet(account.deletePlaylist(id));
        playlistIds.delete(localId);
      }),
    addToPlaylist: (localId, videoId) =>
      withRemoteId(localId, (id) => quiet(account.addToPlaylist(id, videoId))),
    removeFromPlaylist: (localId, videoId) =>
      withRemoteId(localId, (id) => quiet(account.removeFromPlaylist(id, videoId))),
    reorderPlaylist: (localId, videoIds) =>
      withRemoteId(localId, (id) => quiet(account.reorderPlaylist(id, videoIds))),

    // A saved search is addressed by name on the way up — the server replaces
    // a same-named entry — but the id it answers with is what every later
    // action needs. Discarding it meant `withSavedSearchId` fell through to the
    // local UUID, so deleting a search created in this session sent an id the
    // server had never seen: the delete did nothing and the search came back on
    // the next sync. The response is now recorded against the local id.
    saveSearch: (localId, name, query) => {
      void account
        .saveSearch(name, query)
        .then((result) => {
          savedSearchIds.set(localId, result.id);
          persistSavedSearchIds();
        })
        .catch((cause: unknown) => {
          if (cause instanceof ApiError && cause.status === 401) void refreshSession();
        });
    },

    // Deleting one needs the server's id, and that used to be looked up in
    // `playlistIds` — the *playlist* map, which saved searches are never added
    // to. So `withRemoteId` always found nothing, the delete never reached the
    // server, and the search reappeared on the next sync. Saved searches have
    // their own map now, filled by `fromRemote` like the playlists' is.
    deleteSearch: (localId) =>
      withSavedSearchId(localId, (id) => {
        quiet(account.deleteSavedSearch(id));
        savedSearchIds.delete(localId);
        persistSavedSearchIds();
      }),
  });
}

/**
 * Local playlist id -> the id the server gave it.
 *
 * Kept in local storage rather than memory: a playlist created on one page load
 * has to still be mappable on the next one.
 */
const playlistIdStore = new LocalStore<Record<string, string>>('playlist-ids', {});
const playlistIds = new Map<string, string>(Object.entries(playlistIdStore.read()));

/** Persist the map whenever it changes, so a reload keeps the mapping. */
function persistPlaylistIds(): void {
  playlistIdStore.write(Object.fromEntries(playlistIds));
}

/**
 * Local saved-search id -> the id the server gave it.
 *
 * Separate from `playlistIds` because they are separate namespaces; sharing one
 * map is exactly the bug this replaced.
 */
const savedSearchIdStore = new LocalStore<Record<string, string>>('saved-search-ids', {});
const savedSearchIds = new Map<string, string>(Object.entries(savedSearchIdStore.read()));

function persistSavedSearchIds(): void {
  savedSearchIdStore.write(Object.fromEntries(savedSearchIds));
}

function withSavedSearchId(localId: string, use: (remoteId: string) => void): void {
  // The mapping is filled by `fromRemote` on a sync and by `saveSearch` as soon
  // as the server answers, so it is present for anything the server knows about.
  // The fallback covers the narrow window where the creation request has not
  // come back yet: sending the local id is a harmless 404, and the local entry
  // is removed either way rather than being left behind by a failed lookup.
  const remoteId = savedSearchIds.get(localId) ?? localId;
  use(remoteId);
}

function withRemoteId(localId: string, use: (remoteId: string) => void): void {
  const remoteId = playlistIds.get(localId);
  // A playlist whose creation has not landed yet simply is not mirrored for
  // this action; the next full sync brings the two sides back together.
  if (remoteId != null) use(remoteId);
  persistPlaylistIds();
}

/** Translate the server's library into the local shapes. */
function fromRemote(remote: RemoteLibrary): {
  favorites: LibraryEntry[];
  watchLater: LibraryEntry[];
  history: HistoryEntry[];
  playlists: Playlist[];
  playlistItems: Record<string, PlaylistItem[]>;
  savedSearches: SavedSearch[];
} {
  const playlists: Playlist[] = [];
  const playlistItems: Record<string, PlaylistItem[]> = {};

  for (const list of remote.playlists) {
    playlists.push({
      id: list.id,
      name: list.name,
      description: list.description,
      visibility: 'private',
      itemCount: list.items.length,
      createdAt: list.updatedAt,
      updatedAt: list.updatedAt,
      isSystem: false,
    });
    playlistItems[list.id] = list.items.map((item, index) => ({
      videoId: item.videoId as VideoId,
      position: (index + 1) * 10,
      addedAt: list.updatedAt,
      snapshot: item.snapshot as VideoSummary | null,
    }));

    // The server's id is now also the local id, so the mapping is the identity.
    playlistIds.set(list.id, list.id);
  }
  persistPlaylistIds();

  for (const search of remote.savedSearches) savedSearchIds.set(search.id, search.id);
  persistSavedSearchIds();

  return {
    favorites: remote.favorites.map(toLocalEntry),
    watchLater: remote.watchLater.map(toLocalEntry),
    history: remote.history.map((entry) => ({
      ...toLocalEntry(entry),
      progressSeconds: entry.progressSeconds ?? 0,
      completed: entry.isCompleted ?? false,
    })),
    playlists,
    playlistItems,
    savedSearches: remote.savedSearches.map((entry) => ({
      id: entry.id,
      name: entry.name,
      query: entry.query,
      createdAt: entry.createdAt,
    })),
  };
}

function toLocalEntry(entry: RemoteEntry): LibraryEntry {
  return {
    videoId: entry.videoId as VideoId,
    savedAt: entry.savedAt,
    snapshot: entry.snapshot as VideoSummary | null,
  };
}
