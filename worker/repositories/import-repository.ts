/**
 * Bulk import of videos from a spreadsheet.
 *
 * The file itself never reaches the Worker. The admin page parses it in the
 * browser, shows the editor a preview, and then sends validated rows in
 * batches — which keeps a 5,000-row XLSX out of a Worker's memory and request
 * size limits entirely, and means a slow import shows real progress instead of
 * one long silence.
 *
 * A job is therefore three things: a row in `import_jobs`, a series of batch
 * calls that each write some videos and record their failures in
 * `import_job_errors`, and a completion call. Every batch is idempotent per
 * video id, so retrying one after a dropped connection cannot duplicate a row.
 */

import type { D1Database } from '@cloudflare/workers-types';
import type { ImportDraft } from '@shared/core/import-mapping.js';
import { slugify } from '@shared/core/text.js';
import { newId } from '../lib/crypto.js';
import { BaseRepository } from './base.js';
import { SearchIndexRepository } from './search-index-repository.js';

export type ImportFormat = 'json' | 'csv' | 'xlsx' | 'youtube-urls';

export interface ImportJob {
  readonly id: string;
  readonly filename: string;
  readonly sourceFormat: ImportFormat;
  readonly status: string;
  readonly totalRows: number;
  readonly importedRows: number;
  readonly duplicateRows: number;
  readonly invalidRows: number;
  readonly createdAt: string;
  readonly completedAt: string | null;
  readonly errorMessage: string;
}

export interface ImportRowError {
  readonly rowNumber: number;
  readonly field: string;
  readonly errorCode: string;
  readonly message: string;
}

/** What one batch did. */
export interface BatchOutcome {
  readonly imported: number;
  readonly updated: number;
  readonly duplicates: number;
  readonly failed: number;
}

/** One row to write, with the spreadsheet line it came from. */
export interface ImportRow {
  readonly rowNumber: number;
  readonly draft: ImportDraft;
}

export interface BatchOptions {
  /** Overwrite the title, description and tags of a video already present. */
  readonly updateExisting: boolean;
  /** Publish immediately, or leave for review. */
  readonly status: 'published' | 'pending';
  /**
   * Where a row goes when its category cell is blank or names a category we do
   * not have. `videos.category_id` is `NOT NULL`, and an import must not be
   * able to invent an eleventh category from a typo — so the editor picks the
   * fallback up front and every row lands somewhere real.
   */
  readonly defaultCategoryId: string;
}

export class ImportRepository extends BaseRepository {
  constructor(db: D1Database) {
    super(db);
  }

  async createJob(
    filename: string,
    sourceFormat: ImportFormat,
    totalRows: number,
    mapping: unknown,
    userId: string | null,
  ): Promise<string> {
    const id = newId();
    await this.run(
      `INSERT INTO import_jobs (id, filename, source_format, created_by, status, mapping_json, total_rows)
       VALUES (?, ?, ?, ?, 'importing', ?, ?)`,
      [id, filename.slice(0, 250), sourceFormat, userId, JSON.stringify(mapping ?? {}), totalRows],
    );
    return id;
  }

  async listJobs(limit = 20): Promise<ImportJob[]> {
    return this.all<ImportJob>(
      `SELECT id, filename, source_format AS sourceFormat, status,
              total_rows AS totalRows, imported_rows AS importedRows,
              duplicate_rows AS duplicateRows, invalid_rows AS invalidRows,
              created_at AS createdAt, completed_at AS completedAt,
              error_message AS errorMessage
       FROM import_jobs
       ORDER BY created_at DESC
       LIMIT ?`,
      [limit],
    );
  }

  async findJob(id: string): Promise<ImportJob | null> {
    return this.first<ImportJob>(
      `SELECT id, filename, source_format AS sourceFormat, status,
              total_rows AS totalRows, imported_rows AS importedRows,
              duplicate_rows AS duplicateRows, invalid_rows AS invalidRows,
              created_at AS createdAt, completed_at AS completedAt,
              error_message AS errorMessage
       FROM import_jobs WHERE id = ?`,
      [id],
    );
  }

  async listErrors(jobId: string, limit = 200): Promise<ImportRowError[]> {
    return this.all<ImportRowError>(
      `SELECT row_number AS rowNumber, field, error_code AS errorCode, message
       FROM import_job_errors WHERE job_id = ?
       ORDER BY row_number LIMIT ?`,
      [jobId, limit],
    );
  }

  /**
   * Write one batch of rows.
   *
   * Deliberately row-by-row rather than one giant statement: a bad row must
   * fail alone and be reported with its spreadsheet line number, which is the
   * whole point of the errors table. The batch sizes are chosen by the client
   * to keep this well inside a Worker's CPU budget.
   */
  async importBatch(
    jobId: string,
    rows: readonly ImportRow[],
    options: BatchOptions,
  ): Promise<BatchOutcome> {
    let imported = 0;
    let updated = 0;
    let duplicates = 0;
    let failed = 0;
    const written: string[] = [];

    for (const row of rows) {
      try {
        const outcome = await this.#importOne(row.draft, options);
        if (outcome === 'inserted') imported += 1;
        else if (outcome === 'updated') updated += 1;
        else duplicates += 1;
        if (outcome !== 'skipped') written.push(row.draft.videoId);
      } catch (cause) {
        failed += 1;
        await this.#recordError(jobId, row, cause);
      }
    }

    // Indexed once for the whole batch, by the one repository that knows what
    // the indexed document contains.
    //
    // The importer used to write its own FTS row per video, and it wrote the
    // `manufacturers` and `models` columns as empty strings — it has a draft,
    // not the vehicle joins. So every imported video was unfindable by the make
    // or model it is about until some later edit happened to reindex it, which
    // for most of the catalog is never. `SearchIndexRepository` reads the
    // document back from the database, so it gets those columns right, and
    // having exactly one answer to "what does the index contain?" is the reason
    // that class of divergence cannot come back.
    await new SearchIndexRepository(this.db).reindex(written);

    await this.run(
      `UPDATE import_jobs
       SET imported_rows  = imported_rows + ?,
           duplicate_rows = duplicate_rows + ?,
           invalid_rows   = invalid_rows + ?
       WHERE id = ?`,
      [imported + updated, duplicates, failed, jobId],
    );

    return { imported, updated, duplicates, failed };
  }

  /** Record rows the client rejected before sending, so the report is complete. */
  async recordRejected(
    jobId: string,
    rejected: readonly { rowNumber: number; field: string; message: string }[],
  ): Promise<void> {
    if (rejected.length === 0) return;

    await this.batch(
      rejected.map((entry) => ({
        sql: `INSERT INTO import_job_errors (job_id, row_number, field, error_code, message, raw_json)
              VALUES (?, ?, ?, 'validation', ?, '{}')`,
        bindings: [jobId, entry.rowNumber, entry.field.slice(0, 60), entry.message.slice(0, 300)],
      })),
    );

    await this.run(`UPDATE import_jobs SET invalid_rows = invalid_rows + ? WHERE id = ?`, [
      rejected.length,
      jobId,
    ]);
  }

  async completeJob(jobId: string, status: 'completed' | 'failed', message = ''): Promise<void> {
    await this.run(
      `UPDATE import_jobs
       SET status = ?, error_message = ?, completed_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [status, message.slice(0, 500), jobId],
    );
  }

  /** Insert or update one video, with its channel, tags and search index. */
  async #importOne(
    draft: ImportDraft,
    options: BatchOptions,
  ): Promise<'inserted' | 'updated' | 'skipped'> {
    const existing = await this.first<{ id: string }>(`SELECT id FROM videos WHERE id = ?`, [
      draft.videoId,
    ]);

    if (existing != null && !options.updateExisting) return 'skipped';

    const channelId = await this.#resolveChannel(draft);
    const categoryId = await this.#resolveCategory(draft, options.defaultCategoryId);

    if (existing == null) {
      await this.run(
        `INSERT INTO videos (id, title, description, category_id, channel_id,
                             duration_seconds, is_hebrew, status, added_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))`,
        [
          draft.videoId,
          draft.title,
          draft.description,
          categoryId,
          channelId,
          draft.durationSeconds,
          draft.isHebrew ? 1 : 0,
          options.status,
          draft.addedAt,
        ],
      );
    } else {
      await this.run(
        `UPDATE videos
         SET title = ?, description = ?, category_id = ?, channel_id = ?,
             duration_seconds = ?, is_hebrew = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [
          draft.title,
          draft.description,
          categoryId,
          channelId,
          draft.durationSeconds,
          draft.isHebrew ? 1 : 0,
          draft.videoId,
        ],
      );
    }

    await this.#writeTags(draft);
    // The search index is written once per batch by `importBatch`, not here.

    return existing == null ? 'inserted' : 'updated';
  }

  /** Find the channel by name, creating it when the import brings a new one. */
  async #resolveChannel(draft: ImportDraft): Promise<number | null> {
    if (draft.channelName.length === 0) return null;

    const slug = slugify(draft.channelName) || `channel-${String(Date.now())}`;
    const existing = await this.first<{ id: number }>(`SELECT id FROM channels WHERE slug = ?`, [
      slug,
    ]);
    if (existing != null) return existing.id;

    const result = await this.run(
      `INSERT INTO channels (slug, name, youtube_url) VALUES (?, ?, ?)`,
      [slug, draft.channelName, draft.channelUrl.length === 0 ? null : draft.channelUrl],
    );
    return Number(result.meta.last_row_id);
  }

  /**
   * Match the category to an existing one.
   * A category is never created by an import: the ten are a curated set, and a
   * typo in a spreadsheet must not add an eleventh.
   */
  async #resolveCategory(draft: ImportDraft, fallback: string): Promise<string> {
    if (draft.categoryId != null) {
      const byId = await this.first<{ id: string }>(`SELECT id FROM categories WHERE id = ?`, [
        draft.categoryId,
      ]);
      if (byId != null) return byId.id;

      const byName = await this.first<{ id: string }>(
        `SELECT id FROM categories WHERE name = ? COLLATE NOCASE`,
        [draft.categoryId],
      );
      if (byName != null) return byName.id;
    }

    const chosen = await this.first<{ id: string }>(`SELECT id FROM categories WHERE id = ?`, [
      fallback,
    ]);
    if (chosen == null) throw new Error(`unknown fallback category: ${fallback}`);
    return chosen.id;
  }

  /**
   * Replace a video's tags with the ones in the draft.
   *
   * **Replace**, not add. This used to be `INSERT OR IGNORE` only, with no
   * delete, which made `updateExisting` a lie: re-importing a video with fewer
   * tags left the old ones attached. Worse, `#writeSearchIndex` rebuilds the
   * FTS row from the *draft's* tags alone — so the tags shown on the video and
   * the tags search matched it by drifted permanently apart. One of them had to
   * become authoritative, and the draft is what the editor just uploaded.
   *
   * An empty tag list is still a list: it clears the tags rather than being
   * ignored, because "this video has no tags" is a thing an import can say.
   */
  async #writeTags(draft: ImportDraft): Promise<void> {
    const slugs = [...new Set(draft.tags.map((name) => slugify(name)))].filter(
      (slug) => slug.length > 0,
    );

    await this.run(`DELETE FROM video_tags WHERE video_id = ?`, [draft.videoId]);
    if (slugs.length === 0) return;

    for (const name of draft.tags) {
      const slug = slugify(name);
      if (slug.length === 0) continue;

      await this.run(`INSERT OR IGNORE INTO tags (slug, name) VALUES (?, ?)`, [slug, name]);
      await this.run(
        `INSERT OR IGNORE INTO video_tags (video_id, tag_id)
         SELECT ?, id FROM tags WHERE slug = ?`,
        [draft.videoId, slug],
      );
    }
  }

  async #recordError(jobId: string, row: ImportRow, cause: unknown): Promise<void> {
    const message = cause instanceof Error ? cause.message : String(cause);
    await this.run(
      `INSERT INTO import_job_errors (job_id, row_number, field, error_code, message, raw_json)
       VALUES (?, ?, '', 'write-failed', ?, ?)`,
      [
        jobId,
        row.rowNumber,
        message.slice(0, 300),
        JSON.stringify({ videoId: row.draft.videoId, title: row.draft.title }),
      ],
    );
  }
}
