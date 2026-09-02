/**
 * The personal library: favourites, "watch later", history, playlists and the
 * visitor's own cars.
 *
 * Everything works signed out. The interface is asynchronous even though the
 * current implementation is synchronous local storage, because that is what
 * lets the same pages work later against an account API or IndexedDB without a
 * single change above this layer.
 *
 * Entries store a *snapshot* of the video alongside its id, so the library
 * renders instantly and still works with no network — and so a video removed
 * from the catalog still shows a title rather than a blank row.
 */

import type {
  HistoryEntry,
  LibraryEntry,
  LibraryListName,
  Playlist,
  PlaylistItem,
  SavedSearch,
  UserVehicle,
} from '@shared/types/user.js';
import type { VideoId, VideoSummary } from '@shared/types/catalog.js';
import { LocalStore } from './local-store.js';

/** How many entries each list keeps before the oldest are dropped. */
const LIMITS = { favorites: 500, watchLater: 300, history: 300 } as const;

/** The whole library in one record, so a single read loads everything. */
interface LibraryData {
  favorites: LibraryEntry[];
  watchLater: LibraryEntry[];
  history: HistoryEntry[];
  playlists: Playlist[];
  playlistItems: Record<string, PlaylistItem[]>;
  vehicles: UserVehicle[];
  savedSearches: SavedSearch[];
}

const EMPTY: LibraryData = {
  favorites: [],
  watchLater: [],
  history: [],
  playlists: [],
  playlistItems: {},
  vehicles: [],
  savedSearches: [],
};

const store = new LocalStore<LibraryData>('library', EMPTY);

/**
 * A sink for changes, installed when the visitor is signed in.
 *
 * The local copy stays the source of truth for what the page shows: it is
 * synchronous, it survives a dropped connection, and it means a heart fills in
 * instantly rather than after a round trip. The mirror is how that same change
 * reaches the account, so another device sees it — fire-and-forget, because a
 * failed mirror must never undo something the visitor just did. The next page
 * load pulls the account's copy back down and the two agree again.
 */
export interface LibraryMirror {
  favorite(videoId: string, added: boolean): void;
  watchLater(videoId: string, added: boolean): void;
  progress(videoId: string, progressSeconds: number, completed: boolean): void;
  clearList(name: LibraryListName): void;
  createPlaylist(localId: string, name: string, description: string): void;
  renamePlaylist(localId: string, name: string, description: string): void;
  deletePlaylist(localId: string): void;
  /**
   * `localId` is passed so the caller can record the server's id against it.
   * Without it the account layer had nothing to key the mapping on, and a
   * later delete fell back to sending the local UUID — an id the server has
   * never seen.
   */
  saveSearch(localId: string, name: string, query: string): void;
  deleteSearch(id: string, name: string): void;
  addToPlaylist(localId: string, videoId: string): void;
  removeFromPlaylist(localId: string, videoId: string): void;
  reorderPlaylist(localId: string, videoIds: readonly string[]): void;
}

let mirror: LibraryMirror | null = null;

/** Install (or remove, with `null`) the account mirror. */
export function setLibraryMirror(next: LibraryMirror | null): void {
  mirror = next;
}

type Listener = () => void;
const listeners = new Set<Listener>();

function read(): LibraryData {
  return { ...EMPTY, ...store.read() };
}

/**
 * Told when the browser refuses to store the library.
 *
 * `LocalStore.write` returns `false` when storage refuses — a full quota, or
 * Safari's private mode, where `localStorage` exists and throws on every
 * `setItem`. That return value was discarded here, so the interface showed a
 * filled-in heart, the listeners fired, the card moved, and none of it survived
 * a reload. A visitor building a watch-later list in private mode lost the lot
 * with no indication anything was wrong.
 *
 * Injected rather than imported, like `LibraryMirror` above, because nothing in
 * `src/data/` imports from `src/ui/` — a repository that reached for a toast
 * would be a repository that cannot be tested without a DOM.
 */
export type StorageFailureReporter = () => void;

let reportStorageFailure: StorageFailureReporter | null = null;

/** Install (or remove, with `null`) the handler for a refused write. */
export function setStorageFailureReporter(next: StorageFailureReporter | null): void {
  reportStorageFailure = next;
}

/**
 * Consecutive refused writes.
 *
 * The visitor is told once, not once per click: someone adding six videos in a
 * row should see one explanation, not six. Reset by the first write that
 * succeeds, so a genuinely transient failure never nags.
 */
let failedWrites = 0;

function write(data: LibraryData): void {
  if (store.write(data)) {
    failedWrites = 0;
  } else {
    failedWrites += 1;
    if (failedWrites === 1) reportStorageFailure?.();
  }

  // The listeners run either way. The in-memory value is still what the visitor
  // asked for, and an interface that ignored its own click would be a second
  // bug on top of the storage one.
  for (const listener of listeners) listener();
}

function nowIso(): string {
  return new Date().toISOString();
}

function toEntry(video: VideoSummary): LibraryEntry {
  return { videoId: video.id, savedAt: nowIso(), snapshot: video };
}

/** Send a favourites / watch-later change to the account, if there is one. */
function mirrorList(name: LibraryListName, videoId: string, added: boolean): void {
  if (name === 'favorites') mirror?.favorite(videoId, added);
  else if (name === 'watchLater') mirror?.watchLater(videoId, added);
}

/**
 * The guest implementation of the personal library.
 *
 * Every method is async on purpose — see the note at the top of the file.
 */
export class LocalLibraryRepository {
  /** Subscribe to any change. Returns an unsubscribe function. */
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  // ------------------------------------------------------------- Lists

  list(name: LibraryListName): Promise<readonly LibraryEntry[]> {
    return Promise.resolve(read()[name]);
  }

  counts(): Promise<Record<LibraryListName, number>> {
    const data = read();
    return Promise.resolve({
      favorites: data.favorites.length,
      watchLater: data.watchLater.length,
      history: data.history.length,
    });
  }

  has(name: LibraryListName, videoId: VideoId | string): Promise<boolean> {
    return Promise.resolve(read()[name].some((entry) => entry.videoId === videoId));
  }

  /** The ids in a list, for marking cards without loading the snapshots. */
  ids(name: LibraryListName): Promise<Set<string>> {
    return Promise.resolve(new Set(read()[name].map((entry) => entry.videoId)));
  }

  /**
   * Add to a list, or remove it if it is already there.
   * @returns `true` when the video is now in the list.
   */
  toggle(name: 'favorites' | 'watchLater', video: VideoSummary): Promise<boolean> {
    const data = read();
    const list = data[name];
    const index = list.findIndex((entry) => entry.videoId === video.id);

    if (index >= 0) {
      list.splice(index, 1);
      write(data);
      mirrorList(name, video.id, false);
      return Promise.resolve(false);
    }

    list.unshift(toEntry(video));
    data[name] = list.slice(0, LIMITS[name]);
    write(data);
    mirrorList(name, video.id, true);
    return Promise.resolve(true);
  }

  remove(name: LibraryListName, videoId: VideoId | string): Promise<void> {
    const data = read();
    data[name] = data[name].filter((entry) => entry.videoId !== videoId) as never;
    write(data);
    if (name !== 'history') mirrorList(name, String(videoId), false);
    return Promise.resolve();
  }

  clear(name: LibraryListName): Promise<void> {
    const previous = read()[name].map((entry) => entry.videoId);
    const data = read();
    data[name] = [];
    write(data);

    if (name === 'history') mirror?.clearList('history');
    else for (const videoId of previous) mirrorList(name, videoId, false);

    return Promise.resolve();
  }

  // ----------------------------------------------------------- History

  /**
   * Record playback progress.
   *
   * Called from a debounced timer in the player, never on every tick: the
   * point of storing progress is "continue watching", not analytics.
   */
  recordProgress(video: VideoSummary, progressSeconds: number, completed: boolean): Promise<void> {
    const data = read();
    const existing = data.history.find((entry) => entry.videoId === video.id);

    const entry: HistoryEntry = {
      videoId: video.id,
      savedAt: nowIso(),
      snapshot: video,
      progressSeconds: Math.max(0, Math.round(progressSeconds)),
      completed: completed || (existing?.completed ?? false),
    };

    data.history = [entry, ...data.history.filter((item) => item.videoId !== video.id)].slice(
      0,
      LIMITS.history,
    );
    write(data);
    mirror?.progress(video.id, entry.progressSeconds, entry.completed);
    return Promise.resolve();
  }

  /** Videos started but not finished, newest first. */
  continueWatching(limit = 8): Promise<readonly HistoryEntry[]> {
    const unfinished = read()
      .history.filter((entry) => !entry.completed && entry.progressSeconds > 30)
      .slice(0, limit);
    return Promise.resolve(unfinished);
  }

  /** Mark as watched without storing a position. */
  markWatched(video: VideoSummary): Promise<void> {
    return this.recordProgress(video, 0, true);
  }

  // --------------------------------------------------------- Playlists

  playlists(): Promise<readonly Playlist[]> {
    return Promise.resolve(read().playlists);
  }

  createPlaylist(name: string, description = ''): Promise<Playlist> {
    const data = read();
    const playlist: Playlist = {
      id: crypto.randomUUID(),
      name: name.trim(),
      description,
      visibility: 'private',
      itemCount: 0,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      isSystem: false,
    };
    data.playlists = [playlist, ...data.playlists];
    data.playlistItems[playlist.id] = [];
    write(data);
    mirror?.createPlaylist(playlist.id, playlist.name, playlist.description);
    return Promise.resolve(playlist);
  }

  renamePlaylist(id: string, name: string, description?: string): Promise<void> {
    const data = read();
    data.playlists = data.playlists.map((playlist) =>
      playlist.id === id
        ? {
            ...playlist,
            name,
            description: description ?? playlist.description,
            updatedAt: nowIso(),
          }
        : playlist,
    );
    write(data);
    mirror?.renamePlaylist(id, name, description ?? '');
    return Promise.resolve();
  }

  deletePlaylist(id: string): Promise<void> {
    const data = read();
    data.playlists = data.playlists.filter((playlist) => playlist.id !== id && !playlist.isSystem);
    delete data.playlistItems[id];
    write(data);
    mirror?.deletePlaylist(id);
    return Promise.resolve();
  }

  playlistItems(id: string): Promise<readonly PlaylistItem[]> {
    return Promise.resolve(
      [...(read().playlistItems[id] ?? [])].sort((a, b) => a.position - b.position),
    );
  }

  /** Add a video to a playlist. Adding a duplicate is a no-op, not an error. */
  addToPlaylist(playlistId: string, video: VideoSummary): Promise<boolean> {
    const data = read();
    const items = data.playlistItems[playlistId] ?? [];
    if (items.some((item) => item.videoId === video.id)) return Promise.resolve(false);

    const position = items.reduce((max, item) => Math.max(max, item.position), 0) + 10;
    data.playlistItems[playlistId] = [
      ...items,
      { videoId: video.id, position, addedAt: nowIso(), snapshot: video },
    ];
    data.playlists = data.playlists.map((playlist) =>
      playlist.id === playlistId
        ? { ...playlist, itemCount: items.length + 1, updatedAt: nowIso() }
        : playlist,
    );
    write(data);
    mirror?.addToPlaylist(playlistId, video.id);
    return Promise.resolve(true);
  }

  removeFromPlaylist(playlistId: string, videoId: string): Promise<void> {
    const data = read();
    const items = (data.playlistItems[playlistId] ?? []).filter((item) => item.videoId !== videoId);
    data.playlistItems[playlistId] = items;
    data.playlists = data.playlists.map((playlist) =>
      playlist.id === playlistId
        ? { ...playlist, itemCount: items.length, updatedAt: nowIso() }
        : playlist,
    );
    write(data);
    mirror?.removeFromPlaylist(playlistId, videoId);
    return Promise.resolve();
  }

  /** Reorder by writing new positions, sparse so a later move is one write. */
  reorderPlaylist(playlistId: string, orderedVideoIds: readonly string[]): Promise<void> {
    const data = read();
    const items = data.playlistItems[playlistId] ?? [];
    data.playlistItems[playlistId] = items.map((item) => {
      const index = orderedVideoIds.indexOf(item.videoId);
      return index === -1 ? item : { ...item, position: (index + 1) * 10 };
    });
    write(data);
    mirror?.reorderPlaylist(playlistId, orderedVideoIds);
    return Promise.resolve();
  }

  // ---------------------------------------------------- Saved searches

  savedSearches(): Promise<readonly SavedSearch[]> {
    return Promise.resolve(read().savedSearches);
  }

  /**
   * Keep a named filter set.
   *
   * Saving the same name twice replaces it: pressing save again after changing
   * a filter means "update mine", not "make me a second one with the same
   * name". The server does the same, so the two agree without negotiating.
   */
  saveSearch(name: string, query: string): Promise<SavedSearch> {
    const trimmed = name.trim();
    const data = read();

    const saved: SavedSearch = {
      id: crypto.randomUUID(),
      name: trimmed,
      query,
      createdAt: nowIso(),
    };

    data.savedSearches = [
      saved,
      ...data.savedSearches.filter((entry) => entry.name !== trimmed),
    ].slice(0, 50);

    write(data);
    mirror?.saveSearch(saved.id, trimmed, query);
    return Promise.resolve(saved);
  }

  deleteSavedSearch(id: string): Promise<void> {
    const data = read();
    const removed = data.savedSearches.find((entry) => entry.id === id);

    data.savedSearches = data.savedSearches.filter((entry) => entry.id !== id);
    write(data);

    if (removed != null) mirror?.deleteSearch(id, removed.name);
    return Promise.resolve();
  }

  // ---------------------------------------------------------- Vehicles

  vehicles(): Promise<readonly UserVehicle[]> {
    return Promise.resolve(read().vehicles);
  }

  primaryVehicle(): Promise<UserVehicle | null> {
    const vehicles = read().vehicles;
    return Promise.resolve(vehicles.find((vehicle) => vehicle.isPrimary) ?? vehicles[0] ?? null);
  }

  saveVehicle(vehicle: Omit<UserVehicle, 'id'> & { id?: string }): Promise<UserVehicle> {
    const data = read();
    const saved: UserVehicle = { ...vehicle, id: vehicle.id ?? crypto.randomUUID() };

    const others = data.vehicles
      .filter((item) => item.id !== saved.id)
      // Only one vehicle can be primary.
      .map((item) => (saved.isPrimary ? { ...item, isPrimary: false } : item));

    data.vehicles = [...others, saved];
    write(data);
    return Promise.resolve(saved);
  }

  deleteVehicle(id: string): Promise<void> {
    const data = read();
    data.vehicles = data.vehicles.filter((vehicle) => vehicle.id !== id);
    write(data);
    return Promise.resolve();
  }

  // ------------------------------------------------------------ Export

  /**
   * The whole library as a plain object.
   * Used by the settings page's "export my data" button, and by the future
   * merge-into-account step on first sign-in.
   */
  exportAll(): Promise<LibraryData> {
    return Promise.resolve(read());
  }

  /**
   * Overwrite the lists with the account's copy.
   *
   * Called once after signing in, with what the server returned. The account is
   * authoritative at that moment: this device already handed its guest library
   * over (see the merge step), so anything here that the server does not have
   * was deliberately deleted somewhere else.
   *
   * `vehicles` are deliberately not touched — they are still device-local.
   */
  replaceLists(next: {
    favorites: LibraryEntry[];
    watchLater: LibraryEntry[];
    history: HistoryEntry[];
    playlists: Playlist[];
    playlistItems: Record<string, PlaylistItem[]>;
    savedSearches: SavedSearch[];
  }): Promise<void> {
    const data = read();
    // Written without the mirror installed, so restoring what the server just
    // sent does not immediately echo back to it.
    const previous = mirror;
    mirror = null;
    try {
      write({ ...data, ...next });
    } finally {
      mirror = previous;
    }
    return Promise.resolve();
  }

  clearAll(): Promise<void> {
    write({ ...EMPTY });
    return Promise.resolve();
  }
}

/** The instance the pages use. */
export const library = new LocalLibraryRepository();
