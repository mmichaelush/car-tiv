/**
 * The personal library, server side.
 *
 * Everything here is scoped to one `user_id`, and every method takes it as its
 * first argument rather than reading it from ambient state — so a query that
 * forgets to scope itself does not compile.
 *
 * "Watch later" is a playlist with `system_key = 'watch-later'`, not its own
 * table (see migrations/0003). One list implementation covers reordering,
 * removal and moving items, and the two lists cannot drift apart.
 *
 * The methods return ids and positions, never video rows: hydrating a summary
 * is `VideoRepository.findManyByIds`, and doing it here would mean two places
 * that know how to build a `VideoSummary`.
 */

import type { D1Database } from '@cloudflare/workers-types';
import { newId } from '../lib/crypto.js';
import { NotFoundError } from '../lib/errors.js';
import { BaseRepository } from './base.js';

/** The system playlist every account has. */
export const WATCH_LATER_KEY = 'watch-later';

export interface SavedItem {
  readonly videoId: string;
  readonly savedAt: string;
}

export interface HistoryItem extends SavedItem {
  readonly progressSeconds: number;
  readonly isCompleted: boolean;
}

export interface SavedSearchRecord {
  readonly id: string;
  readonly name: string;
  readonly query: string;
  readonly createdAt: string;
}

export interface PlaylistRecord {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly isSystem: boolean;
  readonly systemKey: string | null;
  readonly updatedAt: string;
  readonly videoIds: readonly string[];
}

/** How many rows a single list returns. Beyond this the UI paginates. */
const LIST_LIMIT = 500;

export class LibraryRepository extends BaseRepository {
  constructor(db: D1Database) {
    super(db);
  }

  // --- Favourites ---------------------------------------------------------

  async listFavorites(userId: string): Promise<SavedItem[]> {
    return this.all<SavedItem>(
      `SELECT video_id AS videoId, created_at AS savedAt
       FROM favorites WHERE user_id = ?
       ORDER BY created_at DESC LIMIT ${String(LIST_LIMIT)}`,
      [userId],
    );
  }

  /**
   * Add a favourite.
   *
   * The `WHERE EXISTS` makes an unknown video a silent no-op rather than a
   * foreign-key error. That matters for the merge on first sign-in, which
   * replays a device library that may contain videos since removed from the
   * catalog — one stale id must not fail the whole import.
   */
  async addFavorite(userId: string, videoId: string): Promise<void> {
    await this.run(
      `INSERT OR IGNORE INTO favorites (user_id, video_id)
       SELECT ?, ? WHERE EXISTS (SELECT 1 FROM videos WHERE id = ?)`,
      [userId, videoId, videoId],
    );
  }

  async removeFavorite(userId: string, videoId: string): Promise<void> {
    await this.run(`DELETE FROM favorites WHERE user_id = ? AND video_id = ?`, [userId, videoId]);
  }

  // --- Watch history ------------------------------------------------------

  async listHistory(userId: string): Promise<HistoryItem[]> {
    const rows = await this.all<{
      videoId: string;
      savedAt: string;
      progressSeconds: number;
      isCompleted: number;
    }>(
      `SELECT video_id AS videoId, last_watched_at AS savedAt,
              progress_seconds AS progressSeconds, is_completed AS isCompleted
       FROM watch_history WHERE user_id = ?
       ORDER BY last_watched_at DESC LIMIT ${String(LIST_LIMIT)}`,
      [userId],
    );

    return rows.map((row) => ({
      videoId: row.videoId,
      savedAt: row.savedAt,
      progressSeconds: row.progressSeconds,
      isCompleted: row.isCompleted === 1,
    }));
  }

  /**
   * Record or update playback position.
   *
   * `watch_count` only advances when the video is reported as completed, so
   * scrubbing back and forth does not inflate it. `progress_seconds` never goes
   * backwards on its own — a later, smaller value is a legitimate rewind and is
   * stored, but a zero is not, because that is what a fresh player reports
   * before it has loaded.
   */
  async recordProgress(
    userId: string,
    videoId: string,
    progressSeconds: number,
    isCompleted: boolean,
  ): Promise<void> {
    await this.run(
      `INSERT INTO watch_history (user_id, video_id, progress_seconds, is_completed, watch_count, last_watched_at)
       SELECT ?, ?, ?, ?, 1, CURRENT_TIMESTAMP WHERE EXISTS (SELECT 1 FROM videos WHERE id = ?)
       ON CONFLICT (user_id, video_id) DO UPDATE SET
         progress_seconds = CASE WHEN excluded.progress_seconds > 0
                                 THEN excluded.progress_seconds
                                 ELSE watch_history.progress_seconds END,
         is_completed     = MAX(watch_history.is_completed, excluded.is_completed),
         watch_count      = watch_history.watch_count + excluded.is_completed,
         last_watched_at  = CURRENT_TIMESTAMP`,
      [userId, videoId, Math.max(0, Math.floor(progressSeconds)), isCompleted ? 1 : 0, videoId],
    );
  }

  async clearHistory(userId: string): Promise<void> {
    await this.run(`DELETE FROM watch_history WHERE user_id = ?`, [userId]);
  }

  async removeFromHistory(userId: string, videoId: string): Promise<void> {
    await this.run(`DELETE FROM watch_history WHERE user_id = ? AND video_id = ?`, [
      userId,
      videoId,
    ]);
  }

  // --- Playlists ----------------------------------------------------------

  /** Every playlist with its items, in display order. */
  async listPlaylists(userId: string): Promise<PlaylistRecord[]> {
    const lists = await this.all<{
      id: string;
      name: string;
      description: string;
      isSystem: number;
      systemKey: string | null;
      updatedAt: string;
    }>(
      `SELECT id, name, description, is_system AS isSystem,
              system_key AS systemKey, updated_at AS updatedAt
       FROM playlists WHERE user_id = ?
       ORDER BY is_system DESC, updated_at DESC`,
      [userId],
    );

    if (lists.length === 0) return [];

    // One query for every item of every list, rather than one per list: a
    // visitor with twenty playlists should still cost a single round trip.
    const items = await this.all<{ playlistId: string; videoId: string }>(
      `SELECT pi.playlist_id AS playlistId, pi.video_id AS videoId
       FROM playlist_items pi
       JOIN playlists p ON p.id = pi.playlist_id
       WHERE p.user_id = ?
       ORDER BY pi.playlist_id, pi.position`,
      [userId],
    );

    const byList = new Map<string, string[]>();
    for (const item of items) {
      const bucket = byList.get(item.playlistId);
      if (bucket == null) byList.set(item.playlistId, [item.videoId]);
      else bucket.push(item.videoId);
    }

    return lists.map((list) => ({
      id: list.id,
      name: list.name,
      description: list.description,
      isSystem: list.isSystem === 1,
      systemKey: list.systemKey,
      updatedAt: list.updatedAt,
      videoIds: byList.get(list.id) ?? [],
    }));
  }

  async createPlaylist(userId: string, name: string, description = ''): Promise<string> {
    const id = newId();
    await this.run(`INSERT INTO playlists (id, user_id, name, description) VALUES (?, ?, ?, ?)`, [
      id,
      userId,
      name,
      description,
    ]);
    return id;
  }

  /**
   * The visitor's "watch later" list, created on first use.
   * Every account gets one lazily rather than at sign-up, so an account that
   * never saves anything carries no rows.
   */
  async watchLaterId(userId: string): Promise<string> {
    const existing = await this.first<{ id: string }>(
      `SELECT id FROM playlists WHERE user_id = ? AND system_key = ?`,
      [userId, WATCH_LATER_KEY],
    );
    if (existing != null) return existing.id;

    // `INSERT OR IGNORE`, then read back what is actually there.
    //
    // A plain INSERT loses the race badly: two first-time saves arriving
    // together both see no row, both insert, and the second violates the unique
    // index on `(user_id, system_key)` — so the visitor gets a 500 the first
    // time they use the feature, on a request that should simply have found the
    // list the other one just made. Ignoring the conflict and re-reading turns a
    // lost race into the correct answer.
    const id = newId();
    await this.run(
      `INSERT OR IGNORE INTO playlists (id, user_id, name, is_system, system_key)
       VALUES (?, ?, 'צפייה מאוחר יותר', 1, ?)`,
      [id, userId, WATCH_LATER_KEY],
    );

    const row = await this.first<{ id: string }>(
      `SELECT id FROM playlists WHERE user_id = ? AND system_key = ?`,
      [userId, WATCH_LATER_KEY],
    );
    return row?.id ?? id;
  }

  async renamePlaylist(
    userId: string,
    playlistId: string,
    name: string,
    description: string,
  ): Promise<void> {
    const result = await this.run(
      `UPDATE playlists SET name = ?, description = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND user_id = ? AND is_system = 0`,
      [name, description, playlistId, userId],
    );
    if (result.meta.changes === 0) throw new NotFoundError('הפלייליסט לא נמצא');
  }

  async deletePlaylist(userId: string, playlistId: string): Promise<void> {
    const result = await this.run(
      `DELETE FROM playlists WHERE id = ? AND user_id = ? AND is_system = 0`,
      [playlistId, userId],
    );
    if (result.meta.changes === 0) throw new NotFoundError('הפלייליסט לא נמצא');
  }

  /**
   * Append a video to a playlist.
   *
   * Positions are sparse (10, 20, 30…) so a later drag-and-drop reorder
   * rewrites one row instead of renumbering the whole list.
   */
  async addToPlaylist(userId: string, playlistId: string, videoId: string): Promise<void> {
    await this.#assertOwnership(userId, playlistId);

    const last = await this.count(
      `SELECT COALESCE(MAX(position), 0) AS value FROM playlist_items WHERE playlist_id = ?`,
      [playlistId],
    );

    await this.run(
      `INSERT OR IGNORE INTO playlist_items (playlist_id, video_id, position)
       SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM videos WHERE id = ?)`,
      [playlistId, videoId, last + 10, videoId],
    );
    await this.#touch(playlistId);
  }

  async removeFromPlaylist(userId: string, playlistId: string, videoId: string): Promise<void> {
    await this.#assertOwnership(userId, playlistId);
    await this.run(`DELETE FROM playlist_items WHERE playlist_id = ? AND video_id = ?`, [
      playlistId,
      videoId,
    ]);
    await this.#touch(playlistId);
  }

  /** Rewrite the whole order of a list, after a drag-and-drop. */
  async reorderPlaylist(
    userId: string,
    playlistId: string,
    videoIds: readonly string[],
  ): Promise<void> {
    await this.#assertOwnership(userId, playlistId);

    await this.batch(
      videoIds.map((videoId, index) => ({
        sql: `UPDATE playlist_items SET position = ? WHERE playlist_id = ? AND video_id = ?`,
        bindings: [(index + 1) * 10, playlistId, videoId],
      })),
    );
    await this.#touch(playlistId);
  }

  // --- Saved searches -----------------------------------------------------

  async listSavedSearches(userId: string): Promise<SavedSearchRecord[]> {
    return this.all<SavedSearchRecord>(
      `SELECT id, name, query_json AS query, created_at AS createdAt
       FROM saved_searches WHERE user_id = ?
       ORDER BY created_at DESC LIMIT 50`,
      [userId],
    );
  }

  /**
   * Save a filter set under a name.
   *
   * Re-saving the same name replaces it rather than adding a second entry:
   * "עדכנתי את החיפוש השמור שלי" is what a person means by pressing save
   * twice, not "give me two of them".
   */
  async saveSearch(userId: string, name: string, query: string): Promise<string> {
    await this.run(`DELETE FROM saved_searches WHERE user_id = ? AND name = ?`, [userId, name]);

    const id = newId();
    await this.run(
      `INSERT INTO saved_searches (id, user_id, name, query_json) VALUES (?, ?, ?, ?)`,
      [id, userId, name, query],
    );
    return id;
  }

  async deleteSavedSearch(userId: string, id: string): Promise<void> {
    await this.run(`DELETE FROM saved_searches WHERE id = ? AND user_id = ?`, [id, userId]);
  }

  // --- Followed channels --------------------------------------------------

  async listFollows(userId: string): Promise<string[]> {
    const rows = await this.all<{ slug: string }>(
      `SELECT c.slug FROM channel_follows f
       JOIN channels c ON c.id = f.channel_id
       WHERE f.user_id = ?
       ORDER BY f.created_at DESC`,
      [userId],
    );
    return rows.map((row) => row.slug);
  }

  async follow(userId: string, slug: string): Promise<void> {
    const channel = await this.first<{ id: number }>(`SELECT id FROM channels WHERE slug = ?`, [
      slug,
    ]);
    if (channel == null) throw new NotFoundError('הערוץ לא נמצא');

    await this.run(`INSERT OR IGNORE INTO channel_follows (user_id, channel_id) VALUES (?, ?)`, [
      userId,
      channel.id,
    ]);
  }

  async unfollow(userId: string, slug: string): Promise<void> {
    await this.run(
      `DELETE FROM channel_follows
       WHERE user_id = ? AND channel_id = (SELECT id FROM channels WHERE slug = ?)`,
      [userId, slug],
    );
  }

  // --- Internals ----------------------------------------------------------

  async #assertOwnership(userId: string, playlistId: string): Promise<void> {
    const row = await this.first<{ one: number }>(
      `SELECT 1 AS one FROM playlists WHERE id = ? AND user_id = ?`,
      [playlistId, userId],
    );
    if (row == null) throw new NotFoundError('הפלייליסט לא נמצא');
  }

  async #touch(playlistId: string): Promise<void> {
    await this.run(`UPDATE playlists SET updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [
      playlistId,
    ]);
  }
}
