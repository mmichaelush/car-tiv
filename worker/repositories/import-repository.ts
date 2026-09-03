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
 * `import_job_errors`, and a completion call.
 *
 * ## Why a batch is set-based
 *
 * This used to import one row at a time, and read very naturally: look the
 * video up, resolve its channel, resolve its category, insert or update it,
 * rewrite its tags. Six queries a row, plus two per tag. A batch of a hundred
 * rows carrying three tags each was **around 1,200 queries in one Worker
 * invocation**, against a D1 limit of fifty.
 *
 * That is not a performance note. It is the whole feature failing on the first
 * batch, every time, on the plan this site runs on — and failing *partway*,
 * because the writes were separate calls rather than one transaction, so an
 * import that stopped at query fifty left the catalog holding half a
 * spreadsheet with no record of where it stopped.
 *
 * So a batch is now shaped the way the database wants it: every lookup is one
 * set-based read for the whole batch, and every write is a multi-row statement,
 * with the video rows, their tags and the job's counters landing in **one** D1
 * batch — one transaction, all or nothing. `tests/worker/plan-limits.test.ts`
 * counts the statements at the batch size the API accepts, so this cannot
 * quietly regress into a loop again.
 *
 * ## Where per-row error reporting went
 *
 * The old loop could catch one row's failure and report it with its spreadsheet
 * line, which is what `import_job_errors` is for. A set-based write cannot: one
 * bad value fails the statement its whole chunk is in.
 *
 * That trade is smaller than it looks, because the errors the loop actually
 * caught are gone rather than hidden. Everything a spreadsheet can get wrong —
 * a malformed id, an unparseable duration, a missing title — is caught by
 * `readRow` in `import-routes.ts` before a row reaches this file, and reported
 * per row exactly as before. The category and channel a row names are resolved
 * here, in memory, and an unknown one falls back rather than failing. What is
 * left that could still fail at the database is a constraint being violated by
 * a value that already passed validation, which is a bug in this code, not bad
 * data — and the right answer to a bug mid-import is to roll the batch back and
 * say so, not to write most of it.
 */

import type { D1Database } from '@cloudflare/workers-types';
import type { ImportDraft } from '@shared/core/import-mapping.js';
import { slugify } from '@shared/core/text.js';
import { newId } from '../lib/crypto.js';
import { BaseRepository, chunkForBindings, placeholders, type Binding } from './base.js';
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
  /**
   * The highest spreadsheet row already written for this job.
   *
   * A resent batch — a dropped connection, a retry, a second tab — is dropped
   * rather than imported twice. See `migrations/0011_import_resume.sql`.
   */
  readonly lastRowNumber: number;
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
              error_message AS errorMessage, last_row_number AS lastRowNumber
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
              error_message AS errorMessage, last_row_number AS lastRowNumber
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
   * Write one batch of rows, as one transaction and a fixed handful of queries.
   *
   * The shape, and why each step is one statement rather than `rows.length` of
   * them:
   *
   *  1. drop rows a previous attempt already wrote (`lastRowNumber`);
   *  2. read the ten categories, every channel the batch names, and which of
   *     its video ids already exist — three set-based reads for the whole batch;
   *  3. create the channels and tags the batch introduces, and read their ids
   *     back, because a multi-row insert cannot return them;
   *  4. write the videos, their tags and the job's counters in **one** D1
   *     batch, so a failure leaves the job exactly as it was rather than
   *     half-imported;
   *  5. reindex what was written, once.
   *
   * @param job   The job as it currently stands — its `lastRowNumber` is what
   *              makes a resent batch a no-op.
   */
  async importBatch(
    job: ImportJob,
    rows: readonly ImportRow[],
    options: BatchOptions,
  ): Promise<BatchOutcome> {
    // A batch the client is resending. Rows are sent in ascending order, so
    // anything at or below the high-water mark is already in the catalog and
    // re-importing it would only inflate the job's counters.
    const fresh = rows.filter((row) => row.rowNumber > job.lastRowNumber);
    if (fresh.length === 0) return { imported: 0, updated: 0, duplicates: 0, failed: 0 };

    const [categories, existing, channels] = await Promise.all([
      this.#categories(),
      this.#existingVideoIds(fresh.map((row) => row.draft.videoId)),
      this.#resolveChannels(fresh),
    ]);

    const fallback = categories.get(options.defaultCategoryId.toLowerCase());
    if (fallback == null) {
      throw new Error(`unknown fallback category: ${options.defaultCategoryId}`);
    }

    // Decide every row's fate in memory, before a single write.
    const writes: { row: ImportRow; categoryId: string; channelId: number | null }[] = [];
    let duplicates = 0;
    let imported = 0;
    let updated = 0;

    for (const row of fresh) {
      const draft = row.draft;
      if (existing.has(draft.videoId) && !options.updateExisting) {
        duplicates += 1;
        continue;
      }

      // A category named by id or by name, falling back to the one the editor
      // chose. Never created: the ten are curated, and a typo in a spreadsheet
      // must not add an eleventh.
      const named = draft.categoryId == null ? null : categories.get(draft.categoryId.toLowerCase());
      writes.push({
        row,
        categoryId: named ?? fallback,
        channelId: channels.get(slugify(draft.channelName)) ?? null,
      });

      if (existing.has(draft.videoId)) updated += 1;
      else imported += 1;
    }

    const tagIds = await this.#resolveTags(writes.map(({ row }) => row.draft));

    // One batch: D1 runs it inside a transaction, so the videos, their tags and
    // the job's counters either all land or none do. Written as separate calls
    // — which is what this was — a failure halfway left the catalog changed and
    // the job's report describing an import that had not happened.
    const highWater = Math.max(job.lastRowNumber, ...fresh.map((row) => row.rowNumber));
    await this.batch([
      ...this.#videoStatements(writes, options.status),
      ...this.#tagStatements(writes, tagIds),
      {
        sql: `UPDATE import_jobs
                 SET imported_rows   = imported_rows + ?,
                     duplicate_rows  = duplicate_rows + ?,
                     last_row_number = MAX(last_row_number, ?)
               WHERE id = ?`,
        bindings: [imported + updated, duplicates, highWater, job.id],
      },
    ]);

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
    //
    // Outside the batch above on purpose: an index that is briefly behind is a
    // video that is momentarily hard to search for, which the next batch or the
    // next edit repairs. Rolling back a correct import because the index write
    // failed would be the worse of the two.
    await new SearchIndexRepository(this.db).reindex(writes.map(({ row }) => row.draft.videoId));

    return { imported, updated, duplicates, failed: 0 };
  }

  /** Record rows the client rejected before sending, so the report is complete. */
  async recordRejected(
    jobId: string,
    rejected: readonly { rowNumber: number; field: string; message: string }[],
  ): Promise<void> {
    if (rejected.length === 0) return;

    // Multi-row inserts, four bindings apiece. One statement per rejected row
    // meant a batch where every row failed validation — a mis-mapped column,
    // which is the common mistake — issued a hundred queries to report it.
    const statements = chunkForBindings(rejected, { perItem: 4 }).map((group) => ({
      sql: `INSERT INTO import_job_errors (job_id, row_number, field, error_code, message, raw_json)
            VALUES ${group.map(() => `(?, ?, ?, 'validation', ?, '{}')`).join(', ')}`,
      bindings: group.flatMap((entry) => [
        jobId,
        entry.rowNumber,
        entry.field.slice(0, 60),
        entry.message.slice(0, 300),
      ]),
    }));

    await this.batch([
      ...statements,
      {
        sql: `UPDATE import_jobs SET invalid_rows = invalid_rows + ? WHERE id = ?`,
        bindings: [rejected.length, jobId],
      },
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

  // ------------------------------------------------------------------ reads

  /**
   * Every category, keyed by lower-cased id *and* lower-cased name.
   *
   * One query for a ten-row table, rather than up to three per imported row.
   * Both keys live in one map because a spreadsheet's category cell may hold
   * either, and the caller does not need to care which.
   */
  async #categories(): Promise<Map<string, string>> {
    const rows = await this.all<{ id: string; name: string }>(`SELECT id, name FROM categories`);
    const byKey = new Map<string, string>();
    for (const row of rows) {
      byKey.set(row.id.toLowerCase(), row.id);
      byKey.set(row.name.toLowerCase(), row.id);
    }
    return byKey;
  }

  /** Which of these video ids the catalog already holds. */
  async #existingVideoIds(ids: readonly string[]): Promise<Set<string>> {
    const found = new Set<string>();
    for (const chunk of chunkForBindings(ids)) {
      const rows = await this.all<{ id: string }>(
        `SELECT id FROM videos WHERE id IN (${placeholders(chunk.length)})`,
        chunk,
      );
      for (const row of rows) found.add(row.id);
    }
    return found;
  }

  /**
   * Channel id per slug for every channel the batch names, creating the new
   * ones.
   *
   * A batch of a hundred rows usually names a handful of channels, so this is
   * two or three statements rather than the two hundred the per-row version
   * issued.
   */
  async #resolveChannels(rows: readonly ImportRow[]): Promise<Map<string, number>> {
    const wanted = new Map<string, { name: string; url: string }>();
    for (const { draft } of rows) {
      if (draft.channelName.length === 0) continue;
      const slug = slugify(draft.channelName);
      if (slug.length === 0) continue;
      // First spelling wins, so two rows naming the same channel differently
      // still resolve to one row rather than racing.
      if (!wanted.has(slug)) wanted.set(slug, { name: draft.channelName, url: draft.channelUrl });
    }
    if (wanted.size === 0) return new Map();

    const ids = await this.#channelIds([...wanted.keys()]);

    const missing = [...wanted.entries()].filter(([slug]) => !ids.has(slug));
    if (missing.length === 0) return ids;

    await this.batch(
      chunkForBindings(missing, { perItem: 3 }).map((group) => ({
        sql: `INSERT OR IGNORE INTO channels (slug, name, youtube_url)
              VALUES ${group.map(() => '(?, ?, ?)').join(', ')}`,
        bindings: group.flatMap(([slug, channel]) => [
          slug,
          channel.name,
          channel.url.length === 0 ? null : channel.url,
        ]),
      })),
    );

    // Read back rather than using `last_row_id`: a multi-row insert reports one
    // id, and `INSERT OR IGNORE` may have inserted fewer rows than it was given.
    return this.#channelIds([...wanted.keys()]);
  }

  /** Channel ids for these slugs, for the ones that exist. */
  async #channelIds(slugs: readonly string[]): Promise<Map<string, number>> {
    const ids = new Map<string, number>();
    for (const chunk of chunkForBindings(slugs)) {
      const rows = await this.all<{ id: number; slug: string }>(
        `SELECT id, slug FROM channels WHERE slug IN (${placeholders(chunk.length)})`,
        chunk,
      );
      for (const row of rows) ids.set(row.slug, row.id);
    }
    return ids;
  }

  /** Tag id per slug for every tag the batch names, creating the new ones. */
  async #resolveTags(drafts: readonly ImportDraft[]): Promise<Map<string, number>> {
    const wanted = new Map<string, string>();
    for (const draft of drafts) {
      for (const name of draft.tags) {
        const slug = slugify(name);
        if (slug.length > 0 && !wanted.has(slug)) wanted.set(slug, name);
      }
    }
    if (wanted.size === 0) return new Map();

    await this.batch(
      chunkForBindings([...wanted.entries()], { perItem: 2 }).map((group) => ({
        sql: `INSERT OR IGNORE INTO tags (slug, name) VALUES ${group.map(() => '(?, ?)').join(', ')}`,
        bindings: group.flatMap(([slug, name]) => [slug, name]),
      })),
    );

    const ids = new Map<string, number>();
    for (const chunk of chunkForBindings([...wanted.keys()])) {
      const rows = await this.all<{ id: number; slug: string }>(
        `SELECT id, slug FROM tags WHERE slug IN (${placeholders(chunk.length)})`,
        chunk,
      );
      for (const row of rows) ids.set(row.slug, row.id);
    }
    return ids;
  }

  // ----------------------------------------------------------------- writes

  /** The video rows, as multi-row upserts. */
  #videoStatements(
    writes: readonly { row: ImportRow; categoryId: string; channelId: number | null }[],
    status: 'published' | 'pending',
  ): { sql: string; bindings: Binding[] }[] {
    // Nine bindings a row, so ten rows to a statement.
    //
    // `ON CONFLICT DO UPDATE` rather than a separate insert and update path:
    // one statement shape covers both, and — importantly — it leaves `status`
    // and `added_at` alone on an existing video. An import re-run must not
    // republish something an editor hid, nor move a two-year-old video to the
    // top of "newest" because a spreadsheet was uploaded again today.
    const COLUMNS = 9;
    return chunkForBindings(writes, { perItem: COLUMNS }).map((group) => ({
      sql: `INSERT INTO videos
              (id, title, description, category_id, channel_id,
               duration_seconds, is_hebrew, status, added_at)
            VALUES ${group.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))').join(', ')}
            ON CONFLICT (id) DO UPDATE SET
              title            = excluded.title,
              description      = excluded.description,
              category_id      = excluded.category_id,
              channel_id       = excluded.channel_id,
              duration_seconds = excluded.duration_seconds,
              is_hebrew        = excluded.is_hebrew,
              updated_at       = CURRENT_TIMESTAMP`,
      bindings: group.flatMap(({ row, categoryId, channelId }) => [
        row.draft.videoId,
        row.draft.title,
        row.draft.description,
        categoryId,
        channelId,
        row.draft.durationSeconds,
        row.draft.isHebrew ? 1 : 0,
        status,
        row.draft.addedAt,
      ]),
    }));
  }

  /**
   * The tag links, as a set-based clear followed by multi-row inserts.
   *
   * **Replace**, not add. This used to be `INSERT OR IGNORE` only, with no
   * delete, which made `updateExisting` a lie: re-importing a video with fewer
   * tags left the old ones attached, and the tags shown on the video and the
   * tags search matched it by drifted permanently apart. One of them had to
   * become authoritative, and the draft is what the editor just uploaded.
   *
   * An empty tag list is still a list: it clears the video's tags rather than
   * being ignored, because "this video has no tags" is a thing an import can
   * say. That is why the delete covers every written row, not only the ones
   * that brought tags with them.
   */
  #tagStatements(
    writes: readonly { row: ImportRow }[],
    tagIds: ReadonlyMap<string, number>,
  ): { sql: string; bindings: Binding[] }[] {
    if (writes.length === 0) return [];

    const statements: { sql: string; bindings: Binding[] }[] = chunkForBindings(writes).map(
      (group) => ({
        sql: `DELETE FROM video_tags WHERE video_id IN (${placeholders(group.length)})`,
        bindings: group.map(({ row }) => row.draft.videoId),
      }),
    );

    const pairs: [videoId: string, tagId: number][] = [];
    for (const { row } of writes) {
      const seen = new Set<number>();
      for (const name of row.draft.tags) {
        const id = tagIds.get(slugify(name));
        // De-duplicated here rather than by `OR IGNORE`: two spellings of one
        // tag in the same spreadsheet row would otherwise put the same pair in
        // the statement twice, which SQLite rejects outright inside a single
        // multi-row insert.
        if (id != null && !seen.has(id)) {
          seen.add(id);
          pairs.push([row.draft.videoId, id]);
        }
      }
    }

    for (const group of chunkForBindings(pairs, { perItem: 2 })) {
      statements.push({
        sql: `INSERT OR IGNORE INTO video_tags (video_id, tag_id)
              VALUES ${group.map(() => '(?, ?)').join(', ')}`,
        bindings: group.flat(),
      });
    }

    return statements;
  }
}
