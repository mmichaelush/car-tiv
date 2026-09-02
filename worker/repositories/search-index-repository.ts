/**
 * Keeping `videos_fts` in step with the catalog.
 *
 * ## Why this file exists
 *
 * `migrations/0001_catalog.sql` says the search index "is therefore maintained
 * explicitly by `worker/services/search-index.ts`, which every write path
 * calls." That file did not exist, and no admin write path called anything like
 * it. So an editor could rename a video, change its description, or add and
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
import { BaseRepository, type Binding } from './base.js';

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
   */
  async reindex(videoIds: readonly string[]): Promise<number> {
    if (videoIds.length === 0) return 0;

    const placeholders = videoIds.map(() => '?').join(', ');
    const rows = await this.all<IndexRow>(
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
       WHERE v.id IN (${placeholders})`,
      [...videoIds],
    );

    const statements: { sql: string; bindings: Binding[] }[] = [];

    // Every id is cleared, including ones the SELECT did not return — a video
    // that has been hard-deleted must lose its index row too, or it stays
    // findable by search forever.
    for (const id of videoIds) {
      statements.push({ sql: `DELETE FROM videos_fts WHERE video_id = ?`, bindings: [id] });
    }

    for (const row of rows) {
      statements.push({
        sql: `INSERT INTO videos_fts
                (video_id, title, manufacturers, models, tags, description, channel)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        bindings: [
          row.videoId,
          indexText(row.title),
          indexText(row.manufacturers.replaceAll(',', ' ')),
          indexText(row.models),
          indexText(row.tags),
          indexText(row.description),
          indexText(row.channel),
        ],
      });
    }

    // One batch, so a video is never left with its old row deleted and its new
    // row not yet written — which would make it unfindable rather than stale.
    await this.batch(statements);
    return rows.length;
  }
}
