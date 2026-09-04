/**
 * Scheduled maintenance.
 *
 * A catalog of nearly eight thousand YouTube links rots on its own: videos are
 * deleted, made private, or taken down. Nobody notices until a visitor clicks
 * one — which is exactly the kind of problem a cron job should find first.
 *
 * Five jobs, in the order they run:
 *
 *  1. **Link check.** A slice of the catalog is verified against YouTube's
 *     oEmbed endpoint, oldest-checked first, so every video comes round in
 *     time without any single run being expensive.
 *  2. **Counter refresh.** The aggregates behind `/api/tags`, `/api/stats`,
 *     `/api/categories` and `/api/channels` are recomputed here so that no
 *     visitor ever pays for them. This is the job that keeps the site inside
 *     D1's free read budget; see `migrations/0008_counters.sql`.
 *  3. **Retention.** Every table that grows with traffic rather than with the
 *     catalog is trimmed to the bounds in `RETENTION`. Without this, storage
 *     is a slope with no ceiling.
 *  4. **Housekeeping.** Expired sessions and spent rate-limit windows are
 *     deleted, and one row per table records how many rows it holds today —
 *     which is what makes a storage forecast possible at all.
 *  5. **A heartbeat.** One row in `maintenance_runs`, so the admin can answer
 *     "is the checker actually running?" — a silent cron job and a deleted one
 *     look identical from the outside.
 *
 * Every job is independent and every one is wrapped: a failure is logged and
 * the run continues, because a link check that cannot reach YouTube must not
 * stop the retention pass that keeps the database inside its plan.
 *
 * A broken video is never deleted. It is marked `broken`, which takes it out
 * of public listings and puts it in front of an editor — a video can come back
 * (a channel unhides it), and throwing away an editor's tags and category
 * because YouTube had a bad minute is not recoverable.
 */

import type { Env } from '../env.js';
import type { Logger } from '../lib/logger.js';
import type { MaintenanceRepository } from '../repositories/maintenance-repository.js';
import type { CountersRepository } from '../repositories/counters-repository.js';
import type { SearchIndexRepository } from '../repositories/search-index-repository.js';

/**
 * How many videos one run checks.
 *
 * Each check is one small HTTPS request. 200 keeps a run inside a Worker's
 * limits with room to spare, and at one run an hour the whole catalog is
 * revisited about every two days.
 */
export const LINK_CHECK_BATCH = 200;

/**
 * How many outstanding videos one maintenance run reindexes.
 *
 * The reindex is the most statement-hungry write in the code base, and this run
 * shares one Worker invocation — fifty D1 queries — with the link check, the
 * counter refresh, the retention pass and the growth sample. Fifty videos costs
 * about a dozen statements, which fits alongside all of them. A larger backlog
 * drains an hour at a time, and that is the right speed for a condition that
 * should never arise in the first place.
 */
export const REINDEX_BACKLOG = 50;

/** Requests in flight at once. Politeness, and a bound on memory. */
const CONCURRENCY = 8;

const OEMBED_URL = 'https://www.youtube.com/oembed';

export interface MaintenanceReport {
  readonly checked: number;
  readonly broken: number;
  readonly recovered: number;
  readonly sessionsPruned: number;
  readonly rateLimitsPruned: number;
  /** Rows deleted by the retention pass. */
  readonly rowsPruned: number;
  /** Rows whose maintained counters were recomputed. */
  readonly countersRefreshed: number;
  /** Videos whose search index was rebuilt from the backlog. */
  readonly reindexed: number;
  readonly durationMs: number;
}

export class MaintenanceService {
  readonly #repository: MaintenanceRepository;
  readonly #counters: CountersRepository;
  readonly #search: SearchIndexRepository;
  readonly #logger: Logger;

  constructor(
    repository: MaintenanceRepository,
    counters: CountersRepository,
    search: SearchIndexRepository,
    logger: Logger,
  ) {
    this.#repository = repository;
    this.#counters = counters;
    this.#search = search;
    this.#logger = logger;
  }

  /** Run everything. Never throws: a failed job must not retry forever. */
  async run(env: Env): Promise<MaintenanceReport> {
    const started = Date.now();

    const links = await this.#checkLinks().catch((cause: unknown) => {
      this.#logger.warn('Link check failed', { error: describe(cause) });
      return { checked: 0, broken: 0, recovered: 0 };
    });

    const counters = await this.#counters.refreshAll().catch((cause: unknown) => {
      this.#logger.warn('Counter refresh failed', { error: describe(cause) });
      return null;
    });

    const rowsPruned = await this.#counters.prune().catch((cause: unknown) => {
      this.#logger.warn('Retention pass failed', { error: describe(cause) });
      return 0;
    });

    const housekeeping = await this.#housekeeping().catch((cause: unknown) => {
      this.#logger.warn('Housekeeping failed', { error: describe(cause) });
      return { sessions: 0, rateLimits: 0 };
    });

    const reindexed = await this.#drainReindexBacklog().catch((cause: unknown) => {
      this.#logger.warn('Reindex backlog failed', { error: describe(cause) });
      return 0;
    });

    await this.#counters.sampleGrowth().catch((cause: unknown) => {
      this.#logger.warn('Growth sampling failed', { error: describe(cause) });
    });

    const report: MaintenanceReport = {
      ...links,
      sessionsPruned: housekeeping.sessions,
      rateLimitsPruned: housekeeping.rateLimits,
      rowsPruned,
      countersRefreshed:
        counters == null
          ? 0
          : counters.categories + counters.channels + counters.tags + counters.categoryTagPairs,
      reindexed,
      durationMs: Date.now() - started,
    };

    await this.#repository.recordRun(report).catch(() => undefined);

    this.#logger.info('maintenance', { ...report, environment: env.ENVIRONMENT });
    return report;
  }

  /**
   * Verify a slice of the catalog against YouTube.
   *
   * oEmbed is used rather than the Data API because it needs no key, no quota
   * and no configuration: a 200 means the video is playable, a 401/404 means
   * it is gone or private. Anything else — a timeout, a 5xx, a rate limit — is
   * treated as "unknown" and simply leaves the row alone, because marking
   * hundreds of videos broken during a YouTube incident would be far worse
   * than checking them again next hour.
   */
  async #checkLinks(): Promise<{ checked: number; broken: number; recovered: number }> {
    const videos = await this.#repository.videosDueForCheck(LINK_CHECK_BATCH);
    if (videos.length === 0) return { checked: 0, broken: 0, recovered: 0 };

    const broken: string[] = [];
    const alive: string[] = [];

    for (let index = 0; index < videos.length; index += CONCURRENCY) {
      const slice = videos.slice(index, index + CONCURRENCY);

      const results = await Promise.all(
        slice.map(async (video) => ({ video, state: await probe(video.id) })),
      );

      for (const { video, state } of results) {
        if (state === 'gone') broken.push(video.id);
        else if (state === 'alive') alive.push(video.id);
        // 'unknown' deliberately does nothing at all.
      }
    }

    const recovered = await this.#repository.markAlive(alive);
    await this.#repository.markBroken(broken);

    // Every video probed is marked attempted, including the ones YouTube gave
    // no clear answer about. Without this the unknowns stay at the head of the
    // queue and the rest of the catalog is never reached.
    await this.#repository.markAttempted(videos.map((video) => video.id));

    // `checked` counts videos that got a definite answer, not videos we tried.
    // Reporting the batch size meant a run where all 200 timed out still said
    // "checked 200", which is the opposite of what the dashboard is for.
    return { checked: alive.length + broken.length, broken: broken.length, recovered };
  }

  /**
   * Rebuild the search index for videos whose reindex never succeeded.
   *
   * Every write that changes indexed text sets `needs_reindex = 1` in the same
   * transaction as the change; a successful reindex clears it. Anything still
   * set is a video that is in the catalog and missing from search — visible on
   * every listing, unfindable by typing its name — and before this ran, that
   * was permanent: an import advances its own high-water mark inside the
   * committed batch, so the client's retry is dropped as "already imported" and
   * nothing ever tries again.
   *
   * `REINDEX_BACKLOG` at a time, not everything outstanding. The reindex is the
   * most statement-hungry write in the code base and this shares one Worker
   * invocation with the link check, the counter refresh and the retention pass;
   * a backlog larger than one slice is drained an hour at a time, which is the
   * right speed for a condition that should never occur.
   */
  async #drainReindexBacklog(): Promise<number> {
    const outstanding = await this.#search.backlog(REINDEX_BACKLOG);
    if (outstanding.length === 0) return 0;

    this.#logger.warn('Reindex backlog found', { count: outstanding.length });
    return this.#search.reindex(outstanding);
  }

  async #housekeeping(): Promise<{ sessions: number; rateLimits: number }> {
    return {
      sessions: await this.#repository.pruneSessions(),
      rateLimits: await this.#repository.pruneRateLimits(),
    };
  }
}

/** What YouTube says about one video. */
type LinkState = 'alive' | 'gone' | 'unknown';

async function probe(videoId: string): Promise<LinkState> {
  const url = `${OEMBED_URL}?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}&format=json`;

  try {
    const response = await fetch(url, {
      method: 'GET',
      // A slow answer is not an answer; the video gets checked again next run.
      signal: AbortSignal.timeout(6_000),
    });

    if (response.ok) return 'alive';
    // 404: no such video. 401/403: private or embedding disabled — either way
    // a visitor cannot watch it here, which is what "broken" means to us.
    if (response.status === 404 || response.status === 401 || response.status === 403) {
      return 'gone';
    }
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
