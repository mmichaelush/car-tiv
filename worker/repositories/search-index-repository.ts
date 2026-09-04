/**
 * Keeping `videos_fts` in step with the catalog.
 *
 * ## Why this file exists
 *
 * `migrations/0001_catalog.sql` used to say the search index was "maintained
 * explicitly by `worker/services/search-index.ts`, which every write path
 * calls." That file did not exist, and no admin write path called anything like
 * it. (The migration now names this file; the sentence is quoted here because
 * it is the reason this file exists.) So an editor could rename a video, change
 * its description, or add and
 * remove tags, and the site would show the new text while search kept matching
 * the old — indefinitely, because nothing else ever rewrites the row.
 *
 * The index is a standalone FTS5 table rather than an external-content one,
 * because the indexed document is a *join*: title, description, channel name,
 * tags and vehicle names. A SQLite trigger on `videos` alone cannot assemble
 * that, and — more importantly — a trigger could not call `indexText()`, the
 * Hebrew normaliser that folds niqqud, geresh and final letters. Index and
 * query have to agree on that or Hebrew search silently stops matching, so the
 * rebuild has to happen in application code. This is that code, in one place,
 * so there is exactly one answer to "what does the index contain?".
 *
 * ## The rule
 *
 * Any write that changes a video's title, description, channel, tags or
 * vehicles must call `reindex()` for that video. `tests/worker/search-index.test.ts`
 * fails if an admin path stops doing so.
 */

import { indexText } from '@shared/core/text.js';
import { BaseRepository, chunkForBindings, placeholders, type Binding } from './base.js';

/** Columns in one `videos_fts` row — the per-row binding cost of an insert. */
const INDEX_COLUMNS = 7;

/** The columns of the indexed document, already normalised. */
interface IndexRow {
  videoId: string;
  title: string;
  manufacturers: string;
  models: string;
  tags: string;
  description: string;
  channel: string;
}

export class SearchIndexRepository extends BaseRepository {
  /**
   * Rebuild the index rows for these videos from what the database now says.
   *
   * Reading the text back rather than taking it from the caller is deliberate:
   * a caller that passed a stale title would write a stale index and nothing
   * would notice. The database is the one thing that is definitely current.
   *
   * Deleting and re-inserting rather than updating, because FTS5 has no upsert
   * and a partial update would leave a document half in the old shape.
   *
   * ## How many ids may be passed
   *
   * This is the most statement-hungry write in the code base: about `n/80`
   * reads, `n/80` deletes and `n/12` inserts. D1 allows fifty queries in one
   * Worker invocation, so the caller's list size is a real constraint and not
   * a detail — `MAX_BULK_IDS` (200) is chosen so that this plus the write that
   * preceded it stays inside the limit, with `tests/worker/plan-limits.test.ts`
   * counting the statements rather than trusting this comment. A cron or a
   * queue that wants to reindex the whole catalog must call this once per
   * invocation-sized slice, not once with 7,876 ids.
   */
  async reindex(videoIds: readonly string[]): Promise<number> {
    if (videoIds.length === 0) return 0;

    const rows: IndexRow[] = [];
    for (const chunk of chunkForBindings(videoIds)) {
      rows.push(...(await this.#read(chunk)));
    }

    const statements: { sql: string; bindings: Binding[] }[] = [];

    // Every id is cleared, including ones the SELECT did not return — a video
    // that has been hard-deleted must lose its index row too, or it stays
    // findable by search forever. One `IN` per chunk, not one `DELETE` per id:
    // a bulk edit of 500 videos used to produce 500 delete statements and up
    // to 500 inserts in a single batch, which is both far past D1's
    // 50-queries-per-invocation limit and needless.
    for (const chunk of chunkForBindings(videoIds)) {
      statements.push({
        sql: `DELETE FROM videos_fts WHERE video_id IN (${placeholders(chunk.length)})`,
        bindings: [...chunk],
      });
    }

    // Seven bindings a row, so twelve rows fit inside a statement's budget.
    // That number is the expensive one on this path: the deletes and the reads
    // are one statement per eighty ids, while the inserts are one per twelve,
    // and it is the inserts that decide whether a bulk edit fits inside D1's
    // fifty queries per invocation. `MAX_BULK_IDS` is derived from it.
    for (const group of chunkForBindings(rows, { perItem: INDEX_COLUMNS })) {
      statements.push({
        sql: `INSERT INTO videos_fts
                (video_id, title, manufacturers, models, tags, description, channel)
              VALUES ${group.map(() => `(${placeholders(INDEX_COLUMNS)})`).join(', ')}`,
        bindings: group.flatMap((row) => [
          row.videoId,
          indexText(row.title),
          indexText(row.manufacturers.replaceAll(',', ' ')),
          indexText(row.models),
          indexText(row.tags),
          indexText(row.description),
          indexText(row.channel),
        ]),
      });
    }

    // Clearing the backlog flag is part of the same batch as the index write.
    //
    // A write that changes indexed text sets `needs_reindex = 1` alongside the
    // change itself, so the *intent* to index is as durable as the change. This
    // is where it is discharged — and only here, only if the index rows really
    // landed, because the two are in one transaction. A reindex that fails
    // leaves the flag set and the hourly maintenance run picks it up.
    //
    // See `migrations/0014_reindex_backlog.sql`: without it, an import whose
    // reindex failed left videos in the catalog and permanently absent from
    // search, because the import's own high-water mark had already advanced
    // past them.
    for (const chunk of chunkForBindings(videoIds)) {
      statements.push({
        sql: `UPDATE videos SET needs_reindex = 0
              WHERE id IN (${placeholders(chunk.length)}) AND needs_reindex = 1`,
        bindings: [...chunk],
      });
    }

    // One batch, so a video is never left with its old row deleted and its new
    // row not yet written — which would make it unfindable rather than stale.
    await this.batch(statements);
    return rows.length;
  }

  /**
   * Videos whose indexed text changed and whose reindex has not succeeded.
   *
   * Read by the hourly maintenance run. The partial index makes this a seek
   * over an almost-always-empty set rather than a scan of the whole catalog,
   * which matters on a plan metered by rows read: this question is asked every
   * hour and the answer is nearly always "none".
   */
  async backlog(limit: number): Promise<string[]> {
    const rows = await this.all<{ id: string }>(
      `SELECT id FROM videos WHERE needs_reindex = 1 ORDER BY id LIMIT ?`,
      [limit],
    );
    return rows.map((row) => row.id);
  }

  /**
   * Mark these videos as needing a reindex, as statements for the caller's own
   * batch.
   *
   * Returned rather than executed, because the whole point is that the flag
   * lands in the *same* transaction as the change that made it necessary. A
   * separate call could fail on its own and leave a changed video with no
   * record that its index is stale.
   */
  static markStatements(videoIds: readonly string[]): { sql: string; bindings: Binding[] }[] {
    return chunkForBindings(videoIds).map((chunk) => ({
      sql: `UPDATE videos SET needs_reindex = 1 WHERE id IN (${placeholders(chunk.length)})`,
      bindings: [...chunk] as Binding[],
    }));
  }

  /** The indexed document for one chunk of ids, read from the database. */
  async #read(videoIds: readonly string[]): Promise<IndexRow[]> {
    return this.all<IndexRow>(
      `SELECT
         v.id          AS videoId,
         v.title       AS title,
         v.description AS description,
         COALESCE(ch.name, '') AS channel,
         COALESCE((
           SELECT group_concat(t.name, ' ') FROM video_tags vt
           JOIN tags t ON t.id = vt.tag_id
           WHERE vt.video_id = v.id
         ), '') AS tags,
         COALESCE((
           SELECT group_concat(DISTINCT mk.name) FROM video_vehicle_models vvm
           JOIN vehicle_models m ON m.id = vvm.model_id
           JOIN manufacturers mk ON mk.id = m.manufacturer_id
           WHERE vvm.video_id = v.id
         ), '') AS manufacturers,
         COALESCE((
           SELECT group_concat(m.name, ' ') FROM video_vehicle_models vvm
           JOIN vehicle_models m ON m.id = vvm.model_id
           WHERE vvm.video_id = v.id
         ), '') AS models
       FROM videos v
       LEFT JOIN channels ch ON ch.id = v.channel_id
       WHERE v.id IN (${placeholders(videoIds.length)})`,
      [...videoIds],
    );
  }
}
