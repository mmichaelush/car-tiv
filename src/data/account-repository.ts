/**
 * The account API, from the browser's side.
 *
 * Sign-in is a full-page navigation to `/api/auth/google/start`, not a fetch:
 * the visitor has to end up on Google's own domain, see the address bar, and
 * come back. Everything after that is ordinary JSON.
 *
 * The session lives in an HttpOnly cookie, so there is no token to hold here
 * and nothing for a script on the page to steal. "Am I signed in?" is a
 * question only the server can answer, which is what `session()` is for.
 */

import type { Role } from '@shared/constants.js';
import type { User } from '@shared/types/user.js';
import { httpClient, type HttpClient } from './http-client.js';

export interface SessionInfo {
  readonly user: User | null;
  readonly roles: readonly Role[];
  /** `false` when the deployment has no OAuth client configured. */
  readonly signInAvailable: boolean;
}

/** One entry of the library as the server returns it. */
export interface RemoteEntry {
  readonly videoId: string;
  readonly savedAt: string;
  readonly progressSeconds?: number;
  readonly isCompleted?: boolean;
  readonly snapshot: unknown;
}

export interface RemoteLibrary {
  readonly favorites: readonly RemoteEntry[];
  readonly watchLater: readonly RemoteEntry[];
  readonly history: readonly RemoteEntry[];
  readonly playlists: readonly {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly updatedAt: string;
    readonly items: readonly { readonly videoId: string; readonly snapshot: unknown }[];
  }[];
  readonly follows: readonly string[];
  readonly savedSearches: readonly {
    readonly id: string;
    readonly name: string;
    readonly query: string;
    readonly createdAt: string;
  }[];
}

export class AccountRepository {
  readonly #http: HttpClient;

  constructor(http: HttpClient = httpClient) {
    this.#http = http;
  }

  /** Where to send the browser to start a sign-in. */
  signInHref(returnPath = window.location.pathname + window.location.search): string {
    return `/api/auth/google/start?return=${encodeURIComponent(returnPath)}`;
  }

  session(signal?: AbortSignal): Promise<SessionInfo> {
    return this.#http.get<SessionInfo>('/auth/session', { signal });
  }

  logout(): Promise<{ signedOut: boolean }> {
    return this.#http.post<{ signedOut: boolean }>('/auth/logout', {});
  }

  logoutEverywhere(): Promise<{ signedOut: boolean }> {
    return this.#http.post<{ signedOut: boolean }>('/auth/logout-everywhere', {});
  }

  library(signal?: AbortSignal): Promise<RemoteLibrary> {
    return this.#http.get<RemoteLibrary>('/me/library', { signal });
  }

  addFavorite(videoId: string): Promise<unknown> {
    return this.#http.post('/me/favorites', { videoId });
  }

  removeFavorite(videoId: string): Promise<unknown> {
    return this.#http.request('DELETE', `/me/favorites/${encodeURIComponent(videoId)}`);
  }

  addWatchLater(videoId: string): Promise<unknown> {
    return this.#http.post('/me/watch-later', { videoId });
  }

  removeWatchLater(videoId: string): Promise<unknown> {
    return this.#http.request('DELETE', `/me/watch-later/${encodeURIComponent(videoId)}`);
  }

  recordProgress(videoId: string, progressSeconds: number, isCompleted: boolean): Promise<unknown> {
    return this.#http.post('/me/history', { videoId, progressSeconds, isCompleted });
  }

  clearHistory(): Promise<unknown> {
    return this.#http.request('DELETE', '/me/history');
  }

  createPlaylist(name: string, description = ''): Promise<{ id: string }> {
    return this.#http.post<{ id: string }>('/me/playlists', { name, description });
  }

  renamePlaylist(id: string, name: string, description = ''): Promise<unknown> {
    return this.#http.request('PATCH', `/me/playlists/${encodeURIComponent(id)}`, {
      name,
      description,
    });
  }

  deletePlaylist(id: string): Promise<unknown> {
    return this.#http.request('DELETE', `/me/playlists/${encodeURIComponent(id)}`);
  }

  addToPlaylist(id: string, videoId: string): Promise<unknown> {
    return this.#http.post(`/me/playlists/${encodeURIComponent(id)}/items`, { videoId });
  }

  removeFromPlaylist(id: string, videoId: string): Promise<unknown> {
    return this.#http.request(
      'DELETE',
      `/me/playlists/${encodeURIComponent(id)}/items/${encodeURIComponent(videoId)}`,
    );
  }

  reorderPlaylist(id: string, videoIds: readonly string[]): Promise<unknown> {
    return this.#http.post(`/me/playlists/${encodeURIComponent(id)}/items`, { videoIds });
  }

  saveSearch(name: string, query: string): Promise<{ id: string }> {
    return this.#http.post<{ id: string }>('/me/searches', { name, query });
  }

  deleteSavedSearch(id: string): Promise<unknown> {
    return this.#http.request('DELETE', `/me/searches/${encodeURIComponent(id)}`);
  }

  follow(slug: string): Promise<unknown> {
    return this.#http.post('/me/follows', { slug });
  }

  unfollow(slug: string): Promise<unknown> {
    return this.#http.request('DELETE', `/me/follows/${encodeURIComponent(slug)}`);
  }

  /** Hand this device's guest library to the account. Runs once per device. */
  mergeDeviceLibrary(payload: {
    deviceId: string;
    favorites: readonly string[];
    watchLater: readonly string[];
    history: readonly { videoId: string; progressSeconds: number; isCompleted: boolean }[];
  }): Promise<{ merged: boolean }> {
    return this.#http.post<{ merged: boolean }>('/me/merge', payload);
  }
}

/** The instance pages use. */
export const account = new AccountRepository();
