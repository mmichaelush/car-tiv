/**
 * The maintained counters, and the one job that recomputes them.
 *
 * Everything in this file writes numbers that `catalog-repository.ts` and
 * `video-repository.ts` then read for free. The division is deliberate: the
 * expensive aggregate runs a handful of times a day here, instead of once per
 * visitor there.
 *
 * See `migrations/0008_counters.sql` for why, with the measurement that
 * prompted it.
 */

import { RETENTION } from '@shared/constants.js';
import { BaseRepository } from './base.js';

/** Counter keys. Anything not listed here is not written by `refreshAll`. */
export const COUNTER_KEYS = {
  liveVideos: 'videos.live',
  addedThisWeek: 'videos.addedThisWeek',
  visibleChannels: 'channels.visible',
  visibleCategories: 'categories.visible',
  visibleTags: 'tags.visible',
} as const;

export type CounterKey = (typeof COUNTER_KEYS)[keyof typeof COUNTER_KEYS];

/** What one refresh pass did, for the maintenance heartbeat. */
export interface CounterRefresh {
  readonly categories: number;
  readonly channels: number;
  readonly tags: number;
  readonly categoryTagPairs: number;
  readonly durationMs: number;
}

/** One table's growth, for the admin's storage forecast. */
export interface GrowthSample {
  readonly table: string;
  readonly rows: number;
  readonly rowsThirtyDaysAgo: number | null;
}

/**
 * The pairs `category_tag_counts` should hold, computed from the catalog.
 *
 * Written once and used by both halves of the reconciliation, so the "what it
 * should be" definition cannot drift between the upsert and the delete — which
 * would leave rows that neither statement ever touches again.
 */
const CATEGORY_TAG_AGGREGATE = `
  SELECT v.category_id AS category_id, vt.tag_id AS tag_id, COUNT(*) AS n
  FROM video_tags vt
  JOIN videos v ON v.id = vt.video_id
  JOIN tags t   ON t.id = vt.tag_id
  WHERE v.status = 'published' AND v.deleted_at IS NULL AND t.is_visible = 1
  GROUP BY v.category_id, vt.tag_id
  HAVING COUNT(*) >= 2`;

/**
 * Live videos for one tag.
 *
 * `EXISTS` rather than a join, and the difference is not stylistic. Written as
 * `FROM video_tags vt JOIN videos v ON v.id = vt.video_id WHERE vt.tag_id = …`,
 * SQLite inverts the join: it drives from `videos` through
 * `idx_videos_live_added` — scanning all 7,876 live rows — and probes
 * `video_tags` by `(video_id, tag_id)`, so `idx_video_tags_tag` is never used
 * and the whole catalog is scanned once per tag. Measured on the real data:
 *
 * | form                       | cold refresh of 10,732 tags |
 * | -------------------------- | --------------------------: |
 * | join (what this was)       |            **~215 seconds** |
 * | `EXISTS` (what this is)    |                   **155ms** |
 *
 * Both produce identical counts; only the plan differs. The warm case — the
 * hourly cron, where nothing changed — is 63ms.
 *
 * This was invisible until the counters were run against a genuinely cold
 * database, because the guard means a refresh of an already-correct database
 * evaluates the same subquery and still finishes quickly enough not to notice.
 * The first import of a new deployment is exactly the cold case, so this would
 * have hung the one run that has to work.
 */
const TAG_LIVE_COUNT = `(
      SELECT COUNT(*) FROM video_tags vt
      WHERE vt.tag_id = tags.id
        AND EXISTS (
          SELECT 1 FROM videos v
          WHERE v.id = vt.video_id
            AND v.status = 'published' AND v.deleted_at IS NULL
        )
    )`;

/** Live-video count for one row of a table, as a scalar subquery. */
const liveCount = (table: string, column: string): string => `(
      SELECT COUNT(*) FROM videos v
      WHERE v.${column} = ${table}.id
        AND v.status = 'published' AND v.deleted_at IS NULL
    )`;

/**
 * The statements a counter refresh runs, in order.
 *
 * Exported, and the single definition of this SQL, because it has two
 * consumers that must never disagree: `refreshAll()` below, and
 * `scripts/build-catalog.ts`, which writes them into the last file of the
 * generated catalog import.
 *
 * That second consumer is the fix for a whole class of "the site looks broken"
 * report. Every maintained counter starts at zero, and the public catalog reads
 * them rather than counting rows: `listPopularTags` filters on
 * `t.video_count > 0`, the category-scoped tag list reads
 * `category_tag_counts`, and both the category chips and the channel list show
 * `video_count`. So a database that was imported but never refreshed serves an
 * empty tag cloud, an empty tag filter and zeroes everywhere — which looks
 * exactly like the advanced filtering being broken rather than like a missing
 * step. It was documented as step 5 of the deployment, and a documented step is
 * one a person can skip. Now the import carries it.
 *
 * Every statement is idempotent and guarded, so running the refresh twice
 * writes nothing the second time.
 */
export const COUNTER_REFRESH = {
  categories:
    `UPDATE categories SET video_count = ${liveCount('categories', 'category_id')} ` +
    `WHERE video_count <> ${liveCount('categories', 'category_id')}`,

  channels:
    `UPDATE channels SET video_count = ${liveCount('channels', 'channel_id')} ` +
    `WHERE video_count <> ${liveCount('channels', 'channel_id')}`,

  tags: `UPDATE tags SET video_count = ${TAG_LIVE_COUNT} WHERE video_count <> ${TAG_LIVE_COUNT}`,

  categoryTagsUpsert: `INSERT INTO category_tag_counts (category_id, tag_id, video_count)
     SELECT f.category_id, f.tag_id, f.n
     FROM (${CATEGORY_TAG_AGGREGATE}) f
     LEFT JOIN category_tag_counts c
       ON c.category_id = f.category_id AND c.tag_id = f.tag_id
     WHERE c.video_count IS NULL OR c.video_count <> f.n
     ON CONFLICT (category_id, tag_id) DO UPDATE
       SET video_count = excluded.video_count`,

  categoryTagsDelete: `DELETE FROM category_tag_counts
     WHERE NOT EXISTS (
       SELECT 1 FROM (${CATEGORY_TAG_AGGREGATE}) f
       WHERE f.category_id = category_tag_counts.category_id
         AND f.tag_id = category_tag_counts.tag_id
     )`,

  totals: `INSERT INTO catalog_counters (key, value, updated_at)
     SELECT 'videos.live',
            (SELECT COUNT(*) FROM videos WHERE status = 'published' AND deleted_at IS NULL),
            CURRENT_TIMESTAMP
     UNION ALL SELECT 'videos.addedThisWeek',
            (SELECT COUNT(*) FROM videos
             WHERE status = 'published' AND deleted_at IS NULL
               AND added_at >= date('now', '-7 days')),
            CURRENT_TIMESTAMP
     UNION ALL SELECT 'channels.visible',
            (SELECT COUNT(*) FROM channels WHERE is_visible = 1), CURRENT_TIMESTAMP
     UNION ALL SELECT 'categories.visible',
            (SELECT COUNT(*) FROM categories WHERE is_visible = 1), CURRENT_TIMESTAMP
     UNION ALL SELECT 'tags.visible',
            (SELECT COUNT(*) FROM tags WHERE is_visible = 1 AND video_count > 0),
            CURRENT_TIMESTAMP
     ON CONFLICT (key) DO UPDATE
       SET value = excluded.value, updated_at = excluded.updated_at`,
} as const;

/**
 * Tables whose size follows traffic rather than the catalog.
 *
 * Every table the retention pass prunes must appear here, and in
 * `BYTES_PER_ROW` in `admin-routes.ts`. Four were missing:
 * `search_query_daily` was added in migration 0009 and forgotten in all three
 * places at once, and `table_growth_samples`, `import_jobs` and `usage_daily`
 * were pruned by a policy that nothing was measuring. A table nobody watches
 * is exactly the one that fills the 500 MB, and the storage forecast the admin
 * page draws was quietly leaving them out of the total.
 *
 * `table_growth_samples` watching itself is intentional and safe: the counts
 * are all read before any row is written.
 */
const WATCHED_TABLES = [
  'videos',
  'video_tags',
  'tags',
  'search_logs',
  'search_query_daily',
  'admin_audit_log',
  'watch_history',
  'favorites',
  'sessions',
  'rate_limits',
  'import_jobs',
  'import_job_errors',
  'maintenance_runs',
  'table_growth_samples',
  'usage_daily',
] as const;

/**
 * Tables the retention pass may delete from.
 *
 * A table name cannot be a bound parameter — SQL has no syntax for it — so
 * this union is how the "no string interpolation into SQL" rule is kept: the
 * only values that reach the statement are these literals, and the compiler
 * rejects anything else. No caller can pass a name that came from a request.
 */
type PrunableTable =
  | 'search_logs'
  | 'search_query_daily'
  | 'admin_audit_log'
  | 'watch_history'
  | 'maintenance_runs'
  | 'table_growth_samples'
  | 'usage_daily'
  | 'import_jobs';

/** Likewise for the timestamp column each of those is aged by. */
type PrunableColumn = 'created_at' | 'last_watched_at' | 'ran_at' | 'day';

export class CountersRepository extends BaseRepository {
  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  /**
   * Every catalog-wide counter, as a map.
   *
   * One statement returning five rows, replacing the four correlated
   * `COUNT(*)` subqueries that `/api/stats` used to run over the whole catalog.
   */
  async readAll(): Promise<Map<string, number>> {
    const rows = await this.all<{ key: string; value: number }>(
      `SELECT key, value FROM catalog_counters`,
    );
    return new Map(rows.map((row) => [row.key, row.value]));
  }

  /** When the counters were last recomputed, or `null` if they never were. */
  async lastRefreshedAt(): Promise<string | null> {
    const row = await this.first<{ at: string | null }>(
      `SELECT updated_at AS at FROM catalog_counters WHERE key = 'videos.live'`,
    );
    return row?.at ?? null;
  }

  // -------------------------------------------------------------------------
  // Writing
  // -------------------------------------------------------------------------

  /** Reconcile only after a catalog mutation; the batch clears dirtiness atomically. */
  async refreshAll(): Promise<CounterRefresh> {
    const started = Date.now();
    const dirty = await this.first<{ value: number }>(
      "SELECT value FROM catalog_counters WHERE key = 'maintenance.catalogDirty'",
    );
    if (dirty?.value === 0) {
      // Time alone changes this one counter. The added_at index bounds its scan.
      await this.run(`UPDATE catalog_counters SET value = (
        SELECT COUNT(*) FROM videos WHERE status = 'published' AND deleted_at IS NULL
        AND added_at >= date('now', '-7 days'))
        WHERE key = 'videos.addedThisWeek' AND updated_at < date('now')`);
      await this.run(`UPDATE catalog_counters SET updated_at = CURRENT_TIMESTAMP
        WHERE key IN ('videos.live', 'videos.addedThisWeek', 'channels.visible',
        'categories.visible', 'tags.visible') AND updated_at < datetime('now', '-1 hour')`);
      return {
        categories: 0,
        channels: 0,
        tags: 0,
        categoryTagPairs: 0,
        durationMs: Date.now() - started,
      };
    }
    // D1 serializes this transaction with mutations. No write can land between
    // recomputing the counters and clearing the dirty flag.
    const results = await this.batchWithResults([
      ...Object.values(COUNTER_REFRESH).map((sql) => ({ sql })),
      {
        sql: "UPDATE catalog_counters SET value = 0 WHERE key = 'maintenance.catalogDirty' AND value <> 0",
      },
    ]);
    const changes = (index: number): number => Number(results[index]?.meta.changes ?? 0);
    return {
      categories: changes(0),
      channels: changes(1),
      tags: changes(2),
      categoryTagPairs: changes(3) + changes(4),
      durationMs: Date.now() - started,
    };
  }

  /**
   * Record today's row count for each watched table.
   *
   * D1 reports database size over its HTTP API, not through SQL, so a Worker
   * cannot read its own size. Row counts it can read, and combined with the
   * measured bytes-per-row in `docs/performance.md` they answer the question
   * that matters: at this rate, when does this database reach 500 MB?
   */
  async sampleGrowth(): Promise<number> {
    const day = new Date().toISOString().slice(0, 10);
    const sampled = await this.first<{ found: number }>(
      'SELECT 1 AS found FROM table_growth_samples WHERE day = ? LIMIT 1',
      [day],
    );
    if (sampled != null) return 0;

    // Two statements, not two per table. The loop version issued twenty-four
    // queries, and D1's free plan caps a Worker invocation at fifty — with the
    // link check, the counter refresh and the retention pass in the same cron
    // invocation, this one job was most of the budget.
    //
    // The table names come from the frozen list above, never from input.
    const counts = await this.first<Record<string, number>>(
      `SELECT ${WATCHED_TABLES.map((table) => `(SELECT COUNT(*) FROM ${table}) AS "${table}"`).join(', ')}`,
    );
    if (counts == null) return 0;

    await this.run(
      `INSERT INTO table_growth_samples (day, table_name, row_count)
       VALUES ${WATCHED_TABLES.map(() => '(?, ?, ?)').join(', ')}
       ON CONFLICT (day, table_name) DO UPDATE SET row_count = excluded.row_count`,
      WATCHED_TABLES.flatMap((table) => [day, table, counts[table] ?? 0]),
    );

    return WATCHED_TABLES.length;
  }

  /** Today's counts beside the counts from thirty days ago, for the admin. */
  async growth(): Promise<GrowthSample[]> {
    return this.all<GrowthSample>(
      `SELECT s.table_name AS "table",
              s.row_count  AS rows,
              (SELECT p.row_count FROM table_growth_samples p
               WHERE p.table_name = s.table_name AND p.day <= date('now', '-30 days')
               ORDER BY p.day DESC LIMIT 1) AS rowsThirtyDaysAgo
       FROM table_growth_samples s
       WHERE s.day = (SELECT MAX(day) FROM table_growth_samples)
       ORDER BY s.row_count DESC`,
    );
  }

  /**
   * Apply the retention policy.
   *
   * Two bounds per table, both from `RETENTION` in `shared/constants.ts`: an
   * age, and a row ceiling. The ceiling exists because a traffic spike can
   * produce a month of logs in a day, which age alone would not catch until it
   * was already stored.
   *
   * Deletes are capped per run so one clean-up cannot exceed D1's daily write
   * budget on its own; whatever is left over goes next hour.
   */
  async prune(): Promise<number> {
    let deleted = 0;

    deleted += await this.#pruneByAge('search_logs', 'created_at', RETENTION.searchLogs.days);
    deleted += await this.#pruneToLimit('search_logs', 'id', RETENTION.searchLogs.maxRows);

    // The rollup outlives the raw rows by design, but it is still bounded.
    deleted += await this.#pruneByAge('search_query_daily', 'day', RETENTION.searchQueryDaily.days);

    deleted += await this.#pruneByAge('admin_audit_log', 'created_at', RETENTION.auditLog.days);
    deleted += await this.#pruneToLimit('admin_audit_log', 'id', RETENTION.auditLog.maxRows);

    deleted += await this.#pruneByAge(
      'watch_history',
      'last_watched_at',
      RETENTION.watchHistory.days,
    );

    deleted += await this.#pruneByAge('maintenance_runs', 'ran_at', RETENTION.maintenanceRuns.days);

    deleted += await this.#pruneByAge('table_growth_samples', 'day', RETENTION.growthSamples.days);
    deleted += await this.#pruneByAge('usage_daily', 'day', RETENTION.usageDaily.days);

    // Import errors follow their job: once the job row is gone the rows that
    // explain it are noise. Deleted explicitly rather than relying on the
    // foreign key, so the count is honest and the behaviour does not depend on
    // whether foreign-key enforcement happens to be on.
    const orphanedErrors = await this.run(
      `DELETE FROM import_job_errors
       WHERE job_id IN (SELECT id FROM import_jobs WHERE created_at < date('now', ?))`,
      [`-${String(RETENTION.importJobs.days)} days`],
    );
    deleted += Number(orphanedErrors.meta.changes);
    deleted += await this.#pruneByAge('import_jobs', 'created_at', RETENTION.importJobs.days);

    return deleted;
  }

  /** Retention's row-cap checks use OFFSET; do not pay that scan every hour. */
  async pruneDaily(): Promise<number> {
    const day = new Date().toISOString().slice(0, 10);
    const done = await this.first<{ updated_at: string }>(
      "SELECT updated_at FROM catalog_counters WHERE key = 'maintenance.pruneDay'",
    );
    if (done?.updated_at === day) return 0;
    const deleted = await this.prune();
    await this.run(
      `INSERT INTO catalog_counters (key, value, updated_at)
      VALUES ('maintenance.pruneDay', 0, ?)
      ON CONFLICT(key) DO UPDATE SET updated_at = excluded.updated_at`,
      [day],
    );
    return deleted;
  }

  /** Delete rows older than `days`, at most `PRUNE_BATCH` of them. */
  async #pruneByAge(table: PrunableTable, column: PrunableColumn, days: number): Promise<number> {
    const result = await this.run(
      `DELETE FROM ${table} WHERE rowid IN (
         SELECT rowid FROM ${table} WHERE ${column} < date('now', ?) LIMIT ?
       )`,
      [`-${String(days)} days`, PRUNE_BATCH],
    );
    return Number(result.meta.changes);
  }

  /** Delete the oldest rows above `maxRows`, at most `PRUNE_BATCH` of them. */
  async #pruneToLimit(
    table: 'search_logs' | 'admin_audit_log',
    orderColumn: 'id',
    maxRows: number,
  ): Promise<number> {
    const result = await this.run(
      `DELETE FROM ${table} WHERE rowid IN (
         SELECT rowid FROM ${table} ORDER BY ${orderColumn} DESC LIMIT ? OFFSET ?
       )`,
      [PRUNE_BATCH, maxRows],
    );
    return Number(result.meta.changes);
  }
}

/**
 * Rows one clean-up statement may delete.
 *
 * D1's free plan allows 100,000 writes a day and a delete is a write, so an
 * unbounded `DELETE` on a table that grew unnoticed for a year could spend the
 * whole budget in one cron run and take the site's writes down with it. At
 * 2,000 per statement and one run an hour the backlog still clears in days,
 * and no single run is ever noticeable.
 */
const PRUNE_BATCH = 2_000;
