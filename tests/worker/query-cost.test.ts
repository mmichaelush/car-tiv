/**
 * What each endpoint costs the database.
 *
 * Every other test in this folder asks "is the answer right?". This one asks
 * "how much did the answer cost?", because on Cloudflare's free plan that is
 * the constraint that bites first: 5,000,000 D1 rows read per day, shared by
 * every visitor.
 *
 * The measurements that produced this file, against the real 7,876-video
 * catalog:
 *
 *   endpoint                      before        after
 *   /api/tags                     ~127,000 rows        40 rows
 *   /api/stats                    ~16,000 rows          5 rows
 *   /api/categories               ~7,900 rows          10 rows
 *   /api/videos (the total)       ~7,876 rows           1 row
 *   /api/videos/:id/related       75 ms                 8 ms
 *
 * An unfiltered home page cost around 35,000 rows, which is 143 page views a
 * day before the plan's read budget is gone.
 *
 * The guard below is a **query plan** assertion rather than a timing one. Time
 * is noisy and depends on the machine; a plan is exact and is the thing that
 * actually determines the cost. A step reading `SCAN <table>` without an index
 * means every row of that table, every request — which is precisely the shape
 * that was removed. Adding a correlated `COUNT(*)` back into one of these
 * endpoints, or dropping one of the indexes in `0008_counters.sql`, fails here
 * rather than six months later on a bill.
 *
 * Small tables are allowed to be scanned: reading all ten rows of `categories`
 * is not a cost, and forcing an index onto it would be worse code for no gain.
 * `SCANNABLE` lists them, and the list is short on purpose.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CatalogRepository } from '@worker/repositories/catalog-repository.js';
import { CountersRepository } from '@worker/repositories/counters-repository.js';
import { VideoRepository } from '@worker/repositories/video-repository.js';
import { EMPTY_QUERY } from '@shared/core/query.js';
import { PAGE_REQUEST_COST, PLAN_LIMITS, TYPICAL_VISIT_REQUESTS } from '@shared/constants.js';
import { RateLimitRepository, RATE_LIMITS } from '@worker/repositories/rate-limit-repository.js';
import type { VideoId, VideoQuery } from '@shared/types/catalog.js';
import { createTestDatabase, type RecordedStatement, type TestDatabase } from '../helpers/d1.js';
import { seedCatalog, clearCounters } from '../helpers/fixtures.js';

/**
 * Tables a full scan of is genuinely free, whatever the traffic.
 *
 * The test is that each stays bounded by *configuration* rather than by
 * content: a category is added by an editor, a counter key by a developer.
 * Nothing a visitor does makes any of them grow.
 */
const SCANNABLE = new Set([
  'categories',
  'catalog_counters',
  'home_sections',
  'feature_flags',
  'search_synonyms',
  'roles',
  'manufacturers',
]);

let db: TestDatabase;
let catalog: CatalogRepository;
let videos: VideoRepository;
let counters: CountersRepository;

beforeEach(async () => {
  db = await createTestDatabase();
  seedCatalog(db);
  catalog = new CatalogRepository(db);
  videos = new VideoRepository(db);
  counters = new CountersRepository(db);
});

afterEach(() => {
  db.close();
});

const query = (over: Partial<VideoQuery> = {}): VideoQuery => ({ ...EMPTY_QUERY, ...over });

/** Every full table scan across the statements one call issued. */
function scans(statements: readonly RecordedStatement[]): string[] {
  const found: string[] = [];

  for (const statement of statements) {
    for (const step of db.explain(statement)) {
      // `SCAN t` is a full scan. `SCAN t USING … INDEX …` is not — it walks an
      // index, which is ordered and can stop early. Virtual-table steps are
      // FTS5 and are bounded by the MATCH, not by the table.
      const match = /^SCAN (\w+)/.exec(step);
      if (match == null) continue;
      if (/USING (COVERING )?INDEX|VIRTUAL TABLE/.test(step)) continue;

      const table = match[1] ?? '';
      if (SCANNABLE.has(table)) continue;
      // Subquery and CTE aliases are not tables; a scan of one is bounded by
      // whatever produced it, which the plan shows separately.
      if (!TABLES.has(table)) continue;

      found.push(`${table} (from: ${step})`);
    }
  }

  return found;
}

/** Real table names, so an alias is never mistaken for a scan of a table. */
const TABLES = new Set([
  'videos',
  'video_tags',
  'tags',
  'channels',
  'video_vehicle_models',
  'vehicle_models',
  'category_tag_counts',
  'search_logs',
  'admin_audit_log',
  'watch_history',
  'favorites',
  'sessions',
]);

describe('the endpoints a visitor hits on every page', () => {
  it('reads popular tags without touching video_tags at all', async () => {
    const statements = await db.record(() => catalog.listPopularTags('all'));

    expect(scans(statements)).toEqual([]);
    // The old query joined 59,255 rows to answer this. The new one reads at
    // most the page it returns.
    expect(statements.every((s) => s.rows <= 40)).toBe(true);
  });

  it('reads a category’s popular tags from the maintained table', async () => {
    const statements = await db.record(() => catalog.listPopularTags('maintenance'));

    expect(scans(statements)).toEqual([]);
    expect(statements.some((s) => s.sql.includes('category_tag_counts'))).toBe(true);
  });

  it('reads the hero counters as five rows, not four table counts', async () => {
    const statements = await db.record(() => catalog.stats());

    expect(statements).toHaveLength(1);
    expect(statements[0]?.rows).toBeLessThanOrEqual(8);
    // The whole point: no COUNT over videos.
    expect(statements[0]?.sql).not.toMatch(/COUNT\(\*\)\s+FROM videos/i);
  });

  it('lists categories without a subquery per category', async () => {
    const statements = await db.record(() => catalog.listCategories());

    expect(statements).toHaveLength(1);
    expect(statements[0]?.sql).not.toMatch(/SELECT COUNT\(\*\) FROM videos/i);
  });

  it('lists channels without a subquery per channel', async () => {
    const statements = await db.record(() => catalog.listChannels({ featuredOnly: true }));

    expect(scans(statements.filter((s) => s.sql.includes('SELECT ch.')))).toEqual([]);
    expect(statements[0]?.sql).not.toMatch(/SELECT COUNT\(\*\) FROM videos/i);
  });

  it('pages the catalog without scanning it twice', async () => {
    const statements = await db.record(() => videos.list(query()));

    expect(scans(statements)).toEqual([]);
    // One statement for the page, one for the total — and the total is a
    // single stored row, not a second pass over the join.
    const total = statements.at(-1);
    expect(total?.sql).toContain('catalog_counters');
    expect(total?.rows).toBe(1);
  });

  it('takes a category total from the category row', async () => {
    const statements = await db.record(() => videos.list(query({ category: 'maintenance' })));
    expect(statements.at(-1)?.sql).toMatch(/video_count.*FROM categories/s);
  });

  it('takes a single-tag total from the tag row', async () => {
    const statements = await db.record(() => videos.list(query({ tags: ['טיפול'] })));
    expect(statements.at(-1)?.sql).toMatch(/video_count.*FROM tags/s);
  });
});

describe('related videos', () => {
  it('scores a bounded candidate pool rather than the whole catalog', async () => {
    const statements = await db.record(() => videos.findRelated('corolla0001' as VideoId));

    expect(statements).toHaveLength(1);
    const plan = db.explain(statements[0]!).join('\n');

    // The candidate CTE is what makes the cost independent of catalog size.
    expect(statements[0]?.sql).toContain('candidates AS');
    // And the manufacturer arm must resolve models to ids first — written the
    // other way, SQLite drives the join from `videos` and reads every live row.
    expect(statements[0]?.sql).toContain('make_models AS');
    expect(plan).not.toMatch(/^SCAN videos$/m);
  });

  it('still returns related videos, ranked', async () => {
    const related = await videos.findRelated('corolla0001' as VideoId);

    expect(related.length).toBeGreaterThan(0);
    expect(related.every((video) => video.id !== 'corolla0001')).toBe(true);
  });

  it('puts a same-model video above one that only shares a category', async () => {
    const related = await videos.findRelated('corolla0001' as VideoId);
    const ids = related.map((video) => video.id);

    // corolla0002 is the other Toyota Corolla video in the fixture; scoring
    // weights the shared model at 5 and a shared category at 3.
    expect(ids[0]).toBe('corolla0002');
  });
});

describe('the counters themselves', () => {
  it('produces the same numbers the old subqueries did', async () => {
    clearCounters(db);
    await counters.refreshAll();

    const categories = await catalog.listCategories();
    for (const category of categories) {
      const [live] = db.queryRaw<{ n: number }>(
        `SELECT COUNT(*) AS n FROM videos
         WHERE category_id = ? AND status = 'published' AND deleted_at IS NULL`,
        category.id,
      );
      expect(category.videoCount).toBe(live?.n ?? 0);
    }
  });

  it('counts only live videos, so a hidden one is not advertised', async () => {
    clearCounters(db);
    await counters.refreshAll();

    const total = (await catalog.stats()).videos;
    const [live] = db.queryRaw<{ n: number }>(
      `SELECT COUNT(*) AS n FROM videos WHERE status = 'published' AND deleted_at IS NULL`,
    );
    expect(total).toBe(live?.n ?? 0);
  });

  it('falls back to a real count before the first refresh', async () => {
    // A database that has been migrated but whose cron has never run must not
    // report an empty catalog — that would turn a stalled job into an outage.
    clearCounters(db);

    const page = await videos.list(query());
    const [live] = db.queryRaw<{ n: number }>(
      `SELECT COUNT(*) AS n FROM videos WHERE status = 'published' AND deleted_at IS NULL`,
    );
    expect(page.meta.total).toBe(live?.n ?? 0);
  });

  it('is idempotent — running twice changes nothing', async () => {
    await counters.refreshAll();
    const first = await catalog.listPopularTags('all');
    await counters.refreshAll();
    const second = await catalog.listPopularTags('all');

    expect(second).toEqual(first);
  });

  it('drops a category/tag pair once its last video leaves the category', async () => {
    await counters.refreshAll();
    const before = await catalog.listPopularTags('maintenance');
    expect(before.length).toBeGreaterThan(0);

    db.runRaw(`UPDATE videos SET status = 'hidden' WHERE category_id = 'maintenance'`);
    await counters.refreshAll();

    expect(await catalog.listPopularTags('maintenance')).toEqual([]);
  });
});

describe('retention', () => {
  it('deletes search logs past their retention window', async () => {
    db.runRaw(
      `INSERT INTO search_logs (query, raw_query, result_count, created_at)
       VALUES ('old', 'old', 0, date('now', '-400 days'))`,
    );
    db.runRaw(
      `INSERT INTO search_logs (query, raw_query, result_count, created_at)
       VALUES ('new', 'new', 3, CURRENT_TIMESTAMP)`,
    );

    const deleted = await counters.prune();

    expect(deleted).toBeGreaterThan(0);
    const remaining = db.queryRaw<{ query: string }>(`SELECT query FROM search_logs`);
    expect(remaining.map((row) => row.query)).toEqual(['new']);
  });

  it('leaves recent rows alone', async () => {
    db.runRaw(
      `INSERT INTO search_logs (query, raw_query, result_count, created_at)
       VALUES ('recent', 'recent', 1, date('now', '-3 days'))`,
    );

    await counters.prune();

    expect(db.queryRaw<{ n: number }>(`SELECT COUNT(*) AS n FROM search_logs`)[0]?.n).toBe(1);
  });

  it('takes import errors with the job they belong to', async () => {
    db.runRaw(
      `INSERT INTO import_jobs (id, filename, source_format, created_at)
       VALUES ('job-old', 'a.csv', 'csv', date('now', '-90 days'))`,
    );
    db.runRaw(
      `INSERT INTO import_job_errors (job_id, row_number, field, error_code, message)
       VALUES ('job-old', 1, 'title', 'required', 'missing')`,
    );

    await counters.prune();

    expect(db.queryRaw<{ n: number }>(`SELECT COUNT(*) AS n FROM import_job_errors`)[0]?.n).toBe(0);
    expect(db.queryRaw<{ n: number }>(`SELECT COUNT(*) AS n FROM import_jobs`)[0]?.n).toBe(0);
  });

  it('records a row count per watched table, so growth is visible', async () => {
    await counters.sampleGrowth();
    const samples = await counters.growth();

    expect(samples.length).toBeGreaterThan(0);
    expect(samples.find((sample) => sample.table === 'videos')?.rows).toBeGreaterThan(0);
  });
});

describe('the freshness signal', () => {
  it('reports a never-refreshed database as never refreshed', async () => {
    // A migrated database whose cron has never fired is the case the admin
    // warning exists for. Seeding `updated_at` with the deploy time would have
    // hidden it for exactly the first 24 hours — when a missing cron trigger or
    // a forgotten post-import refresh most needs to be noticed.
    const fresh = await createTestDatabase();
    try {
      const at = await new CountersRepository(fresh).lastRefreshedAt();
      expect(at).toBe('1970-01-01 00:00:00');
    } finally {
      fresh.close();
    }
  });

  it('moves the timestamp forward once the counters are computed', async () => {
    await counters.refreshAll();
    const at = await counters.lastRefreshedAt();

    expect(at).not.toBe('1970-01-01 00:00:00');
    expect(at).not.toBeNull();
  });
});

describe('the request budget the admin screen quotes', () => {
  it('adds up to the measured typical visit', () => {
    // These are measurements, taken in a browser against the real catalog and
    // counted from the server's own log — not estimates. A change to a page's
    // data loading has to update them, or the admin screen quotes a headroom
    // figure that no longer matches reality.
    expect(TYPICAL_VISIT_REQUESTS).toBe(
      PAGE_REQUEST_COST.home.first +
        PAGE_REQUEST_COST.video.first +
        PAGE_REQUEST_COST.video.again +
        PAGE_REQUEST_COST.category.again,
    );
  });

  it('costs less on a second page of the same kind than on the first', () => {
    // If this ever inverts, the browser cache headers have stopped working.
    for (const page of Object.values(PAGE_REQUEST_COST)) {
      expect(page.again).toBeLessThanOrEqual(page.first);
    }
  });

  it('leaves real headroom on the free plan', () => {
    const visitors = Math.floor(PLAN_LIMITS.workerRequestsPerDay / TYPICAL_VISIT_REQUESTS);
    expect(visitors).toBeGreaterThanOrEqual(5_000);
  });
});

describe('the rate limiter protects the write budget too', () => {
  it('stops writing once a caller is over the limit', async () => {
    // The bug this catches: the limiter incremented on every call, including
    // calls it was already refusing. A flood of a hundred thousand blocked
    // requests was a hundred thousand D1 writes — the entire daily budget,
    // spent by the mechanism that exists to prevent exactly that. A limiter a
    // flood can use to exhaust the quota it protects is not a limiter.
    const limits = new RateLimitRepository(db);
    const { max } = RATE_LIMITS.report;

    // Spend the budget.
    for (let attempt = 0; attempt < max; attempt++) {
      const verdict = await limits.consume('flood-key', 'report');
      expect(verdict.allowed).toBe(true);
    }

    const countBefore = db.queryRaw<{ n: number }>(
      `SELECT request_count AS n FROM rate_limits WHERE key = 'flood-key'`,
    )[0]?.n;

    // Everything past it is refused — and, crucially, writes nothing.
    for (let attempt = 0; attempt < 25; attempt++) {
      expect((await limits.consume('flood-key', 'report')).allowed).toBe(false);
    }

    const countAfter = db.queryRaw<{ n: number }>(
      `SELECT request_count AS n FROM rate_limits WHERE key = 'flood-key'`,
    )[0]?.n;

    expect(countAfter).toBe(countBefore);
  });

  it('still lets a different caller through', async () => {
    const limits = new RateLimitRepository(db);
    for (let attempt = 0; attempt < RATE_LIMITS.report.max; attempt++) {
      await limits.consume('noisy', 'report');
    }

    expect((await limits.consume('noisy', 'report')).allowed).toBe(false);
    expect((await limits.consume('quiet', 'report')).allowed).toBe(true);
  });

  it('reports how long to wait', async () => {
    const limits = new RateLimitRepository(db);
    const verdict = await limits.consume('someone', 'report');
    expect(verdict.retryAfterSeconds).toBeGreaterThan(0);
    expect(verdict.retryAfterSeconds).toBeLessThanOrEqual(RATE_LIMITS.report.windowSeconds);
  });
});
