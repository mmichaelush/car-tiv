/**
 * Fixed-window rate limiting.
 *
 * One upsert per write request and nothing at all on reads, which keeps the
 * cost inside the D1 free tier. The window is a wall-clock bucket rather than a
 * sliding window: less precise, but a single row and a single statement.
 */

import { BaseRepository } from './base.js';

/** Actions that are rate limited, with their per-window budget. */
export const RATE_LIMITS = {
  submission: { max: 5, windowSeconds: 3_600 },
  report: { max: 10, windowSeconds: 3_600 },
  feedback: { max: 10, windowSeconds: 3_600 },
  contact: { max: 5, windowSeconds: 3_600 },
  search: { max: 300, windowSeconds: 60 },
  login: { max: 10, windowSeconds: 900 },
} as const;

export type RateLimitedAction = keyof typeof RATE_LIMITS;

export interface RateLimitVerdict {
  readonly allowed: boolean;
  readonly remaining: number;
  /** Seconds until the current window ends. */
  readonly retryAfterSeconds: number;
}

export class RateLimitRepository extends BaseRepository {
  /**
   * Count this request against the caller's budget.
   *
   * @param key     Salted hash of the caller (see `worker/lib/crypto.ts`).
   * @param action  Which budget to charge.
   */
  async consume(key: string, action: RateLimitedAction): Promise<RateLimitVerdict> {
    const { max, windowSeconds } = RATE_LIMITS[action];
    const now = Math.floor(Date.now() / 1000);
    const windowStart = now - (now % windowSeconds);

    // Read first, and stop counting once the caller is over the limit.
    //
    // The obvious order — increment, then check — is what this used to do, and
    // it meant an attacker who was *already blocked* still cost one D1 write per
    // attempt. The rate limiter protected the content and not the database: a
    // hundred thousand refused requests were a hundred thousand writes, which is
    // the entire daily write budget on the free plan. A limiter that a flood can
    // use to exhaust the quota it is meant to protect is not a limiter.
    //
    // Reads are the cheap side of the plan — five million a day against a
    // hundred thousand writes — so paying an extra read to avoid a write is the
    // right way round, and a blocked caller now costs reads only.
    const used = await this.count(
      `SELECT request_count AS value FROM rate_limits
       WHERE key = ? AND action = ? AND window_start = ?`,
      [key, action, windowStart],
    );

    if (used >= max) {
      return { allowed: false, remaining: 0, retryAfterSeconds: windowStart + windowSeconds - now };
    }

    // Still a race: two requests can read the same count and both write. That
    // overshoots by the number of concurrent requests, never by more, which is
    // the accepted trade for not holding a lock — the window is a coarse budget,
    // not an exact quota.
    await this.run(
      `INSERT INTO rate_limits (key, action, window_start, request_count)
       VALUES (?, ?, ?, 1)
       ON CONFLICT (key, action, window_start)
       DO UPDATE SET request_count = request_count + 1`,
      [key, action, windowStart],
    );

    return {
      allowed: true,
      remaining: Math.max(0, max - used - 1),
      retryAfterSeconds: windowStart + windowSeconds - now,
    };
  }

  /**
   * Drop windows that have already closed.
   * Called by the scheduled maintenance job, not on the request path.
   */
  async purgeExpired(olderThanSeconds = 86_400): Promise<number> {
    const cutoff = Math.floor(Date.now() / 1000) - olderThanSeconds;
    const result = await this.run(`DELETE FROM rate_limits WHERE window_start < ?`, [cutoff]);
    return result.meta.changes;
  }
}
