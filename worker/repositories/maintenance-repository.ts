/**
 * The queries the scheduled maintenance job runs.
 *
 * Kept in a repository like everything else, so the job itself contains no SQL
 * and can be read as "what does maintenance do" rather than "what does
 * maintenance do to the database".
 */

import type { D1Database } from '@cloudflare/workers-types';
import { BaseRepository, chunkForBindings, placeholders } from './base.js';

/**
 * Consecutive failures before a video is taken out of public listings.
 *
 * Two, not one: a single odd answer from YouTube — an edge hiccup, a
 * rate-limit, a momentary 404 — must not flag a video that is perfectly fine.
 * Two failures on two separate runs is a link that is actually gone.
 */
export const FAILURES_BEFORE_BROKEN = 2;

export interface VideoToCheck {
  readonly id: string;
  readonly status: string;
  readonly checkFailures: number;
}

export interface MaintenanceRun {
  readonly ranAt: string;
  readonly checked: number;
  readonly broken: number;
  readonly recovered: number;
  readonly rowsPruned: number;
  readonly countersRefreshed: number;
  readonly durationMs: number;
}

export class MaintenanceRepository extends BaseRepository {
  constructor(db: D1Database) {
    super(db);
  }

  /**
   * The next slice of videos to verify.
   *
   * Never-checked rows come first (`NULL` sorts first in SQLite), then the
   * least recently checked — so the whole catalog cycles round without any
   * bookkeeping beyond one column.
   *
   * Videos already marked `removed` are skipped: an editor has decided about
   * those, and re-checking them forever would waste most of every run.
   */
  async videosDueForCheck(limit: number): Promise<VideoToCheck[]> {
    // Ordered by when the video was last *attempted*, not last verified.
    //
    // Ordering by `last_checked_at` was a trap: that column is only written on
    // a definite answer, so a video that times out keeps its old value and
    // comes back to the head of the queue on the very next run. During a
    // YouTube incident the same 200 videos would be retried hourly, forever,
    // and the other 7,600 would never be checked at all — the job would look
    // busy and healthy while doing nothing useful.
    return this.all<VideoToCheck>(
      `SELECT id, status, check_failures AS checkFailures
       FROM videos
       WHERE deleted_at IS NULL
         AND status IN ('published', 'broken', 'hidden')
       ORDER BY last_attempted_at IS NOT NULL, last_attempted_at
       LIMIT ?`,
      [limit],
    );
  }

  /**
   * Record that these videos were probed, whatever the answer was.
   *
   * Deliberately separate from `last_checked_at`, which still means "YouTube
   * gave us a definite answer at this time". The queue needs to move on; the
   * coverage report must not claim a video was verified when it was not.
   */
  async markAttempted(videoIds: readonly string[]): Promise<void> {
    if (videoIds.length === 0) return;

    // A link-check run probes 200 videos, so this list was 200 bindings long —
    // twice D1's limit, on every single cron run. Chunked, it is three
    // set-based statements.
    await this.batch(
      chunkForBindings(videoIds).map((chunk) => ({
        sql: `UPDATE videos SET last_attempted_at = CURRENT_TIMESTAMP
              WHERE id IN (${placeholders(chunk.length)})`,
        bindings: [...chunk],
      })),
    );
  }

  /**
   * Record a failed check, and mark the video broken once it has failed enough
   * times. Returns nothing: the count of newly broken videos is reported by
   * the caller, which knows what it probed.
   */
  async markBroken(videoIds: readonly string[]): Promise<void> {
    if (videoIds.length === 0) return;

    // One statement per chunk rather than one per id. The per-id version was
    // not only 200 statements in a batch — enough to reach D1's 50-queries-per
    // -invocation limit on the free plan — it also had no reason to be: every
    // statement was identical apart from the id, so a set-based `IN` does
    // exactly the same thing in a fraction of the queries.
    await this.batch(
      chunkForBindings(videoIds, { fixed: 1 }).map((chunk) => ({
        sql: `UPDATE videos
              SET check_failures    = check_failures + 1,
                  last_checked_at   = CURRENT_TIMESTAMP,
                  last_attempted_at = CURRENT_TIMESTAMP,
                  status = CASE
                             WHEN check_failures + 1 >= ? AND status = 'published'
                             THEN 'broken' ELSE status
                           END,
                  updated_at = CURRENT_TIMESTAMP
              WHERE id IN (${placeholders(chunk.length)})`,
        bindings: [FAILURES_BEFORE_BROKEN, ...chunk],
      })),
    );
  }

  /**
   * Record a successful check.
   *
   * A video previously marked `broken` is published again: the channel put it
   * back, and leaving it hidden would be a permanent penalty for a temporary
   * problem. A video an editor hid stays hidden — that was a human decision.
   *
   * @returns How many videos came back from `broken`.
   */
  async markAlive(videoIds: readonly string[]): Promise<number> {
    if (videoIds.length === 0) return 0;

    const chunks = chunkForBindings(videoIds);

    let recovered = 0;
    for (const chunk of chunks) {
      recovered += await this.count(
        `SELECT COUNT(*) AS value FROM videos
         WHERE status = 'broken' AND id IN (${placeholders(chunk.length)})`,
        [...chunk],
      );
    }

    // Counted before the update, and only then written — otherwise the count
    // would be zero, because the update is what stops them being broken.
    await this.batch(
      chunks.map((chunk) => ({
        sql: `UPDATE videos
              SET check_failures    = 0,
                  last_checked_at   = CURRENT_TIMESTAMP,
                  last_attempted_at = CURRENT_TIMESTAMP,
                  status = CASE WHEN status = 'broken' THEN 'published' ELSE status END,
                  updated_at = CURRENT_TIMESTAMP
              WHERE id IN (${placeholders(chunk.length)})`,
        bindings: [...chunk],
      })),
    );

    return recovered;
  }

  /** Delete sessions that expired or were revoked more than a day ago. */
  async pruneSessions(): Promise<number> {
    const result = await this.run(
      `DELETE FROM sessions
       WHERE expires_at < datetime('now', '-1 day')
          OR (revoked_at IS NOT NULL AND revoked_at < datetime('now', '-1 day'))`,
    );
    return Number(result.meta.changes);
  }

  /** Delete rate-limit windows that closed more than a day ago. */
  async pruneRateLimits(): Promise<number> {
    const cutoff = Math.floor(Date.now() / 1000) - 86_400;
    const result = await this.run(`DELETE FROM rate_limits WHERE window_start < ?`, [cutoff]);
    return Number(result.meta.changes);
  }

  /** Keep a row per run, so "is the checker alive?" has an answer. */
  async recordRun(report: {
    checked: number;
    broken: number;
    recovered: number;
    sessionsPruned: number;
    rateLimitsPruned: number;
    rowsPruned: number;
    countersRefreshed: number;
    durationMs: number;
  }): Promise<void> {
    await this.run(
      `INSERT INTO maintenance_runs
         (checked, broken, recovered, sessions_pruned, rate_limits_pruned,
          rows_pruned, counters_refreshed, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        report.checked,
        report.broken,
        report.recovered,
        report.sessionsPruned,
        report.rateLimitsPruned,
        report.rowsPruned,
        report.countersRefreshed,
        report.durationMs,
      ],
    );

    // Keep a month of history and no more; this table is a heartbeat, not an
    // archive.
    await this.run(`DELETE FROM maintenance_runs WHERE ran_at < datetime('now', '-30 days')`);
  }

  async recentRuns(limit = 20): Promise<MaintenanceRun[]> {
    return this.all<MaintenanceRun>(
      `SELECT ran_at AS ranAt, checked, broken, recovered,
              rows_pruned AS rowsPruned, counters_refreshed AS countersRefreshed,
              duration_ms AS durationMs
       FROM maintenance_runs ORDER BY ran_at DESC LIMIT ?`,
      [limit],
    );
  }

  /** How much of the catalog has ever been checked, for the admin. */
  async checkCoverage(): Promise<{ total: number; checked: number; broken: number }> {
    const row = await this.first<{ total: number; checked: number; broken: number }>(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN last_checked_at IS NOT NULL THEN 1 ELSE 0 END) AS checked,
              SUM(CASE WHEN status = 'broken' THEN 1 ELSE 0 END) AS broken
       FROM videos WHERE deleted_at IS NULL`,
    );
    return row ?? { total: 0, checked: 0, broken: 0 };
  }
}
