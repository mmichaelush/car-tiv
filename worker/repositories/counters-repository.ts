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

/** Tables whose size follows traffic rather than the catalog. */
const WATCHED_TABLES = [
  'videos',
  'video_tags',
  'tags',
  'search_logs',
  'admin_audit_log',
  'watch_history',
  'favorites',
  'sessions',
  'rate_limits',
  'import_job_errors',
  'maintenance_runs',
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
      `SELECT MAX(updated_at) AS at FROM catalog_counters`,
    );
    return row?.at ?? null;
  }

  // -------------------------------------------------------------------------
  // Writing
  // -------------------------------------------------------------------------

  /**
   * Recompute every counter.
   *
   * This is the expensive pass — it is the aggregate that used to run on each
   * request — and it is deliberately concentrated here, where it runs from the
   * hourly cron and after a write that could have changed the numbers.
   *
   * Each step is a single `UPDATE … FROM` (or an `INSERT … SELECT`), so the
   * whole thing is a handful of statements rather than a loop over rows.
   */
  async refreshAll(): Promise<CounterRefresh> {
    const started = Date.now();

    const categories = await this.#refreshCategories();
    const channels = await this.#refreshChannels();
    const tags = await this.#refreshTags();
    const categoryTagPairs = await this.#refreshCategoryTags();
    await this.#refreshTotals();

    return { categories, channels, tags, categoryTagPairs, durationMs: Date.now() - started };
  }

  /** Live videos per category. */
  async #refreshCategories(): Promise<number> {
    const result = await this.run(
      `UPDATE categories SET video_count = (
         SELECT COUNT(*) FROM videos v
         WHERE v.category_id = categories.id
           AND v.status = 'published' AND v.deleted_at IS NULL
       )`,
    );
    return Number(result.meta.changes);
  }

  /** Live videos per channel. */
  async #refreshChannels(): Promise<number> {
    const result = await this.run(
      `UPDATE channels SET video_count = (
         SELECT COUNT(*) FROM videos v
         WHERE v.channel_id = channels.id
           AND v.status = 'published' AND v.deleted_at IS NULL
       )`,
    );
    return Number(result.meta.changes);
  }

  /** Live videos per tag. */
  async #refreshTags(): Promise<number> {
    const result = await this.run(
      `UPDATE tags SET video_count = (
         SELECT COUNT(*) FROM video_tags vt
         JOIN videos v ON v.id = vt.video_id
         WHERE vt.tag_id = tags.id
           AND v.status = 'published' AND v.deleted_at IS NULL
       )`,
    );
    return Number(result.meta.changes);
  }

  /**
   * Rebuild `category_tag_counts` from scratch.
   *
   * Delete-then-insert rather than an upsert, because a tag that lost its last
   * video in a category has to lose its row, and reconciling that incrementally
   * is more code and more ways to be wrong than simply recomputing a table that
   * is only about thirteen thousand rows.
   *
   * Only pairs worth showing are stored: a tag used once in a category never
   * reaches a filter panel, and keeping the long tail would double the table
   * for no visible effect.
   */
  async #refreshCategoryTags(): Promise<number> {
    await this.run(`DELETE FROM category_tag_counts`);
    const result = await this.run(
      `INSERT INTO category_tag_counts (category_id, tag_id, video_count)
       SELECT v.category_id, vt.tag_id, COUNT(*) AS n
       FROM video_tags vt
       JOIN videos v ON v.id = vt.video_id
       JOIN tags t   ON t.id = vt.tag_id
       WHERE v.status = 'published' AND v.deleted_at IS NULL AND t.is_visible = 1
       GROUP BY v.category_id, vt.tag_id
       HAVING COUNT(*) >= 2`,
    );
    return Number(result.meta.changes);
  }

  /** The five catalog-wide numbers. */
  async #refreshTotals(): Promise<void> {
    await this.run(
      `INSERT INTO catalog_counters (key, value, updated_at)
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
    );
  }

  // -------------------------------------------------------------------------
  // Growth and retention
  // -------------------------------------------------------------------------

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

    for (const table of WATCHED_TABLES) {
      // The table names come from the frozen list above, never from input.
      const rows = await this.count(`SELECT COUNT(*) AS value FROM ${table}`);
      await this.run(
        `INSERT INTO table_growth_samples (day, table_name, row_count) VALUES (?, ?, ?)
         ON CONFLICT (day, table_name) DO UPDATE SET row_count = excluded.row_count`,
        [day, table, rows],
      );
    }

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
