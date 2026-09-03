/**
 * The two D1 limits that decide whether this site works at all on the free plan.
 *
 * ## Why this file exists
 *
 * D1 rejects a statement carrying more than 100 bound parameters, and since
 * 1 September 2026 it *fails* queries once an account has spent its daily row
 * budget rather than merely billing for them. Both limits were being broken by
 * code that passed every existing test, because neither limit is visible from
 * inside the code:
 *
 *  * `node:sqlite` — what these tests run on — allows 32,766 bound parameters,
 *    so a link-check run binding 200 video ids looked perfectly fine here and
 *    would have thrown on the first real cron run. `tests/helpers/d1.ts` now
 *    enforces D1's number, which is what makes the first half of this file
 *    able to fail.
 *  * A row write costs nothing locally, so `refreshAll()` rewriting all 10,732
 *    tag rows every hour looked free. On the real catalog it was 22,569 writes
 *    a pass; hourly, 541,656 a day against a budget of 100,000. The site would
 *    have returned database errors every afternoon and the cause would have
 *    looked like a Cloudflare outage.
 *
 * Neither is the kind of bug a reader finds by reading. Both are the kind a
 * test finds by counting, so these tests count.
 *
 * @see https://developers.cloudflare.com/d1/platform/limits/
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminRepository } from '@worker/repositories/admin-repository.js';
import { CountersRepository } from '@worker/repositories/counters-repository.js';
import { MaintenanceRepository } from '@worker/repositories/maintenance-repository.js';
import { SearchIndexRepository } from '@worker/repositories/search-index-repository.js';
import { VideoRepository } from '@worker/repositories/video-repository.js';
import type { VideoId } from '@shared/types/catalog.js';
import { MaintenanceService, LINK_CHECK_BATCH } from '@worker/services/maintenance-service.js';
import { MAX_BOUND_PARAMETERS } from '@worker/repositories/base.js';
import { MAX_BULK_IDS, PLAN_LIMITS } from '@shared/constants.js';
import { idsSchema } from '@worker/routes/admin-routes.js';
import { IMPORT_BATCH_SIZE } from '@worker/routes/import-routes.js';
import { ImportRepository } from '@worker/repositories/import-repository.js';
import type { Env } from '@worker/env.js';
import { createTestDatabase, type TestDatabase } from '../helpers/d1.js';
import { seedCatalog } from '../helpers/fixtures.js';

let db: TestDatabase;

/**
 * More videos than any batch size in the code base, so a statement that failed
 * to chunk is over the limit rather than merely close to it.
 *
 * They are `published` and un-attempted, so the link checker picks them up
 * ahead of the seeded ones and a run really does probe a full batch.
 */
const BULK_COUNT = 500;

function seedManyVideos(count: number): string[] {
  const ids: string[] = [];
  const categoryId = db.queryRaw<{ id: number }>(`SELECT id FROM categories LIMIT 1`)[0]?.id ?? 1;

  for (let index = 0; index < count; index += 1) {
    // Valid 11-character YouTube ids, distinct and deterministic.
    const id = `bulk${String(index).padStart(7, '0')}`;
    db.runRaw(
      `INSERT INTO videos (id, title, description, category_id, status, added_at)
       VALUES (?, ?, '', ?, 'published', '2026-08-01')`,
      id,
      `סרטון בדיקה ${String(index)}`,
      categoryId,
    );
    ids.push(id);
  }
  return ids;
}

const silentLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
} as unknown as ConstructorParameters<typeof MaintenanceService>[2];

const env = { ENVIRONMENT: 'test', APP_URL: 'https://car-tiv.test' } as unknown as Env;

beforeEach(async () => {
  db = await createTestDatabase();
  seedCatalog(db);
});

afterEach(() => {
  vi.unstubAllGlobals();
  db.close();
});

// ---------------------------------------------------------------------------
// The 100-parameter limit
// ---------------------------------------------------------------------------

describe('no statement exceeds D1s bound-parameter limit', () => {
  it('a full link-check run', async () => {
    // The one that would have thrown on every single cron run in production:
    // `markAttempted` bound one parameter per probed video, and a run probes
    // 200. The test adapter throws on more than 100, so this test is the
    // difference between finding that here and finding it in the logs.
    seedManyVideos(LINK_CHECK_BATCH + 50);
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('{}', { status: 200 }))),
    );

    const service = new MaintenanceService(
      new MaintenanceRepository(db),
      new CountersRepository(db),
      silentLogger,
    );

    const report = await service.run(env);
    expect(report.checked).toBe(LINK_CHECK_BATCH);
  });

  it('marking a whole batch broken', async () => {
    const ids = seedManyVideos(LINK_CHECK_BATCH);
    const repository = new MaintenanceRepository(db);

    await expect(repository.markBroken(ids)).resolves.toBeUndefined();

    const failures = db.queryRaw<{ n: number }>(
      `SELECT COUNT(*) AS n FROM videos WHERE check_failures = 1`,
    );
    expect(failures[0]?.n).toBe(LINK_CHECK_BATCH);
  });

  it('marking a whole batch alive', async () => {
    const ids = seedManyVideos(LINK_CHECK_BATCH);
    db.runRaw(`UPDATE videos SET status = 'broken' WHERE id LIKE 'bulk%'`);

    const recovered = await new MaintenanceRepository(db).markAlive(ids);
    expect(recovered).toBe(LINK_CHECK_BATCH);
  });

  it('reindexing a bulk edit', async () => {
    // Seven bindings a row and 500 videos: the previous version also produced
    // 500 deletes plus 500 inserts in one batch, which is ten times the free
    // plan's queries-per-invocation limit as well.
    const ids = seedManyVideos(BULK_COUNT);
    const written = await new SearchIndexRepository(db).reindex(ids);

    expect(written).toBe(BULK_COUNT);
    expect(
      db.queryRaw<{ n: number }>(
        `SELECT COUNT(*) AS n FROM videos_fts WHERE video_id LIKE 'bulk%'`,
      )[0]?.n,
    ).toBe(BULK_COUNT);
  });

  it('the whole admin bulk surface, well past the list size the API accepts', async () => {
    // Deliberately 500 rather than `MAX_BULK_IDS`: the API ceiling exists for
    // the *query* budget, and chunking for bindings has to keep working
    // independently of it — a cron or a backfill that calls these directly is
    // not bounded by a request schema.
    const ids = seedManyVideos(BULK_COUNT);
    const admin = new AdminRepository(db);

    expect(await admin.bulkUpdate(ids, { isHebrew: false, adminNote: 'סבב בדיקה' }, null)).toBe(
      BULK_COUNT,
    );
    expect(await admin.addTag(ids, 'בדיקה', null)).toBe(BULK_COUNT);
    expect(await admin.removeTag(ids, 'בדיקה', null)).toBe(BULK_COUNT);
    expect(await admin.softDelete(ids, null)).toBe(BULK_COUNT);
    expect(await admin.restore(ids, null)).toBe(BULK_COUNT);
  });

  it('records one audit entry per operation, however many chunks it took', async () => {
    // Chunking must not turn one editor action into one log line per chunk
    // that a reader has to reassemble. They share a batch id.
    const ids = seedManyVideos(BULK_COUNT);
    await new AdminRepository(db).softDelete(ids, null);

    const batches = db.queryRaw<{ n: number }>(
      `SELECT COUNT(DISTINCT batch_id) AS n FROM admin_audit_log WHERE action = 'video.delete'`,
    );
    expect(batches[0]?.n).toBe(1);
  });

  it('hydrating a whole personal library', async () => {
    // `findManyByIds` was safe only because `account-routes.ts` sliced by
    // `PAGINATION.maxLimit`, which is 60. That constant caps a page size; it
    // was holding a database constraint together from another file, and
    // raising it for a pagination reason would have broken this. The chunking
    // lives in the repository now, so this asks it for 500 directly.
    const ids = seedManyVideos(BULK_COUNT);
    const found = await new VideoRepository(db).findManyByIds(ids as unknown as VideoId[]);

    expect(found).toHaveLength(BULK_COUNT);
    // Order is the caller's, not the database's.
    expect(found[0]?.id).toBe(ids[0]);
    expect(found.at(-1)?.id).toBe(ids.at(-1));
  });

  it('the guard itself works', () => {
    // If the adapter ever stops enforcing the limit, every test above turns
    // into a test of nothing at all, silently. This is the one that notices.
    expect(() =>
      db.prepare(`SELECT 1`).bind(...new Array<number>(MAX_BOUND_PARAMETERS + 1).fill(1)),
    ).toThrow(/too many SQL variables/);
  });
});

// ---------------------------------------------------------------------------
// The daily row-write budget
// ---------------------------------------------------------------------------

describe('the counter refresh writes only what changed', () => {
  /** Rows the refresh actually wrote, from the statements' own row counts. */
  const refreshCost = async (counters: CountersRepository): Promise<number> => {
    const report = await counters.refreshAll();
    return report.categories + report.channels + report.tags + report.categoryTagPairs;
  };

  it('writes nothing at all when nothing changed', async () => {
    // The hourly cron case, and the whole reason the site fits in the plan.
    // Before the change guards this was 22,569 rows on the real catalog —
    // 541,656 a day — against a budget of 100,000.
    const counters = new CountersRepository(db);
    await counters.refreshAll();

    expect(await refreshCost(counters)).toBe(0);
    expect(await refreshCost(counters)).toBe(0);
  });

  it('writes in proportion to a single edit', async () => {
    const counters = new CountersRepository(db);
    await counters.refreshAll();

    await new AdminRepository(db).bulkUpdate(['corolla0001'], { status: 'hidden' }, null);
    const cost = await refreshCost(counters);

    expect(cost).toBeGreaterThan(0);
    // Comfortably below the row count of any table it touches: the cost
    // follows the edit, not the size of the catalog.
    expect(cost).toBeLessThan(db.rowCount('tags'));
  });

  it('settles back to zero on the next pass', async () => {
    const counters = new CountersRepository(db);
    await new AdminRepository(db).bulkUpdate(['corolla0001'], { status: 'hidden' }, null);
    await counters.refreshAll();

    expect(await refreshCost(counters)).toBe(0);
  });

  it('still produces the table a full rebuild would', async () => {
    // The guards are only safe if they are invisible in the result. This
    // compares the incrementally-reconciled table against one rebuilt from
    // scratch, which is the property the delete-then-insert version had for
    // free and the differential version has to earn.
    const counters = new CountersRepository(db);
    await counters.refreshAll();

    await new AdminRepository(db).bulkUpdate(
      ['corolla0001', 'corolla0002'],
      { status: 'hidden' },
      null,
    );
    await new AdminRepository(db).addTag(['brakes00001', 'yaris000001'], 'בלמים', null);
    await counters.refreshAll();

    const incremental = db.queryRaw<{ row: string }>(
      `SELECT category_id || ':' || tag_id || '=' || video_count AS row
       FROM category_tag_counts ORDER BY category_id, tag_id`,
    );

    db.runRaw(`DELETE FROM category_tag_counts`);
    db.runRaw(
      `INSERT INTO category_tag_counts (category_id, tag_id, video_count)
       SELECT v.category_id, vt.tag_id, COUNT(*)
       FROM video_tags vt
       JOIN videos v ON v.id = vt.video_id
       JOIN tags t   ON t.id = vt.tag_id
       WHERE v.status = 'published' AND v.deleted_at IS NULL AND t.is_visible = 1
       GROUP BY v.category_id, vt.tag_id
       HAVING COUNT(*) >= 2`,
    );

    const rebuilt = db.queryRaw<{ row: string }>(
      `SELECT category_id || ':' || tag_id || '=' || video_count AS row
       FROM category_tag_counts ORDER BY category_id, tag_id`,
    );

    expect(incremental).toEqual(rebuilt);
  });

  it('keeps the heartbeat beating even on a pass that wrote nothing', async () => {
    // `catalog_counters.updated_at` is how the admin page answers "is the
    // refresh running?". A guard that skipped it would make a healthy site
    // indistinguishable from a dead cron.
    const counters = new CountersRepository(db);
    await counters.refreshAll();
    db.runRaw(`UPDATE catalog_counters SET updated_at = '1970-01-01 00:00:00'`);

    await counters.refreshAll();

    expect(await counters.lastRefreshedAt()).not.toBe('1970-01-01 00:00:00');
  });
});

// ---------------------------------------------------------------------------
// The 50-queries-per-invocation limit
// ---------------------------------------------------------------------------

describe('one maintenance run stays inside a Worker invocation', () => {
  it('issues well under fifty statements', async () => {
    // The free plan allows 50 queries per invocation. `sampleGrowth` alone
    // used to issue twenty-four — two per watched table — and the link check,
    // counter refresh and retention pass share the same invocation with it.
    seedManyVideos(LINK_CHECK_BATCH);
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('{}', { status: 200 }))),
    );

    const service = new MaintenanceService(
      new MaintenanceRepository(db),
      new CountersRepository(db),
      silentLogger,
    );

    const statements = await db.record(async () => {
      await service.run(env);
    });

    expect(statements.length).toBeLessThan(50);
  });
});

// ---------------------------------------------------------------------------
// The 50-queries-per-invocation limit, on the write paths
// ---------------------------------------------------------------------------

describe('an admin or import request stays inside one Worker invocation', () => {
  /**
   * D1's free plan allows 50 queries per Worker invocation. The maintenance
   * cron was measured against that; the write paths a person triggers were not,
   * and they are the ones that fan out per row.
   *
   * These count the statements the repositories actually issue, at exactly the
   * list size the API accepts, so the number moves when the code does rather
   * than when someone updates a comment. That coupling is the point: raising
   * `MAX_BULK_IDS` without making the paths cheaper fails here.
   *
   * The headroom is deliberate and not slack. A real request also resolves the
   * session and the staff account before the handler runs, and the budget is
   * per *invocation*, not per repository call.
   */
  const BUDGET = PLAN_LIMITS.queriesPerInvocation;
  const HEADROOM = 10;

  /** Statements one route's writes issue, reported with the number in the message. */
  const cost = async (work: () => Promise<unknown>): Promise<number> =>
    (await db.record(async () => void (await work()))).length;

  it('reindexing the largest edit the API accepts', async () => {
    // The measurement that moved the ceiling: at the old maximum of 500 this
    // was 60 statements — the request was accepted, the update written, and
    // the reindex then failed partway through, leaving the catalog changed and
    // the index describing videos that no longer existed in that form.
    const ids = seedManyVideos(MAX_BULK_IDS);
    const index = new SearchIndexRepository(db);

    const statements = await cost(() => index.reindex(ids));
    expect(statements, `${String(statements)} statements`).toBeLessThanOrEqual(BUDGET - HEADROOM);
  });

  it('the whole bulk-update path: update, audit, reindex', async () => {
    // What one `POST /api/admin/videos/bulk` really costs, which is the number
    // Cloudflare counts.
    const ids = seedManyVideos(MAX_BULK_IDS);
    const admin = new AdminRepository(db);
    const index = new SearchIndexRepository(db);

    const statements = await cost(async () => {
      await admin.bulkUpdate(ids, { title: 'כותרת אחידה' }, null);
      await index.reindex(ids);
    });
    expect(statements, `${String(statements)} statements`).toBeLessThanOrEqual(BUDGET - HEADROOM);
  });

  it('the most expensive path of all: tagging, then reindexing', async () => {
    // `addTag` binds two parameters a row rather than one, so its chunks are
    // half the size and it issues twice the statements. This is the path
    // `MAX_BULK_IDS` was actually derived from.
    const ids = seedManyVideos(MAX_BULK_IDS);
    const admin = new AdminRepository(db);
    const index = new SearchIndexRepository(db);

    const statements = await cost(async () => {
      await admin.addTag(ids, 'בלמים', null);
      await index.reindex(ids);
    });
    expect(statements, `${String(statements)} statements`).toBeLessThanOrEqual(BUDGET - HEADROOM);
  });

  it('a delete of the documented maximum', async () => {
    const ids = seedManyVideos(MAX_BULK_IDS);
    const admin = new AdminRepository(db);

    const statements = await cost(() => admin.softDelete(ids, null));
    expect(statements, `${String(statements)} statements`).toBeLessThanOrEqual(BUDGET - HEADROOM);
  });

  it('a full import batch, tags and all', async () => {
    // The path that was worst by an order of magnitude: a row at a time, six
    // queries each plus two per tag, so a hundred rows with three tags apiece
    // was about 1,200 queries against a limit of fifty. Every import failed on
    // its first batch, partway through, with no record of where it stopped.
    const imports = new ImportRepository(db);
    const jobId = await imports.createJob('catalog.xlsx', 'xlsx', 5_000, {}, null);
    const job = await imports.findJob(jobId);
    expect(job).not.toBeNull();

    const rows = Array.from({ length: IMPORT_BATCH_SIZE }, (_, index) => ({
      rowNumber: index + 1,
      draft: {
        videoId: `imp${String(index).padStart(8, '0')}`,
        title: `סרטון ייבוא ${String(index)}`,
        description: 'תיאור',
        categoryId: null,
        // A handful of channels across the batch, which is what a real
        // spreadsheet looks like — and what makes the channel lookup cheap.
        channelName: `ערוץ ${String(index % 5)}`,
        channelUrl: '',
        // Three tags a row: two shared across the batch, one its own, so the
        // tag table sees both the common and the worst case.
        tags: ['בלמים', 'תחזוקה', `תגית ${String(index)}`],
        durationSeconds: 300,
        addedAt: null,
        isHebrew: true,
      },
    }));

    const statements = await cost(() =>
       
      imports.importBatch(job!, rows, {
        updateExisting: false,
        status: 'published',
        defaultCategoryId: db.queryRaw<{ id: string }>(`SELECT id FROM categories LIMIT 1`)[0]!.id,
      }),
    );

    expect(statements, `${String(statements)} statements`).toBeLessThanOrEqual(BUDGET - HEADROOM);
    expect(db.rowCount('videos')).toBeGreaterThanOrEqual(IMPORT_BATCH_SIZE);
  });

  it('drops a batch the client is resending', async () => {
    // Idempotency, measured by its effect rather than asserted in a comment:
    // the second attempt writes nothing and costs nothing, so a dropped
    // connection cannot make the final report claim more rows than the file
    // had.
    const imports = new ImportRepository(db);
    const jobId = await imports.createJob('catalog.csv', 'csv', 2, {}, null);
    const categoryId = db.queryRaw<{ id: string }>(`SELECT id FROM categories LIMIT 1`)[0]?.id ?? '';
    const options = { updateExisting: false, status: 'published' as const, defaultCategoryId: categoryId };
    const rows = [
      {
        rowNumber: 1,
        draft: {
          videoId: 'imp00000001',
          title: 'סרטון',
          description: '',
          categoryId: null,
          channelName: '',
          channelUrl: '',
          tags: [],
          durationSeconds: 60,
          addedAt: null,
          isHebrew: true,
        },
      },
    ];

    const first = await imports.findJob(jobId);
    expect(first).not.toBeNull();
     
    expect((await imports.importBatch(first!, rows, options)).imported).toBe(1);

    const second = await imports.findJob(jobId);
     
    expect(second!.lastRowNumber).toBe(1);
     
    expect(await imports.importBatch(second!, rows, options)).toEqual({
      imported: 0,
      updated: 0,
      duplicates: 0,
      failed: 0,
    });

     
    expect((await imports.findJob(jobId))!.importedRows).toBe(1);
  });

  it('refuses at the door a list the write paths could not serve', () => {
    // The ceiling has to be enforced where the request arrives, not merely
    // documented in a comment next to the repositories. Rejected here, an
    // over-long list is a 400 the editor can act on; accepted here, it is a
    // half-applied edit — the update written, the reindex failing on its
    // fifty-first query, and the search index describing videos that no longer
    // look like that.
    const ids = (count: number) =>
      Array.from({ length: count }, (_, index) => `bulk${String(index).padStart(7, '0')}`);

    expect(idsSchema.safeParse({ ids: ids(MAX_BULK_IDS) }).success).toBe(true);
    expect(idsSchema.safeParse({ ids: ids(MAX_BULK_IDS + 1) }).success).toBe(false);
    expect(idsSchema.safeParse({ ids: [] }).success).toBe(false);
  });
});
