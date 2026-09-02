/**
 * The scheduled link checker.
 *
 * The behaviour that matters is what it does when YouTube answers oddly, so
 * `fetch` is stubbed and every answer a real run could get is exercised. The
 * expensive mistake this guards against is marking hundreds of good videos
 * broken during a YouTube incident.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MaintenanceRepository } from '@worker/repositories/maintenance-repository.js';
import { CountersRepository } from '@worker/repositories/counters-repository.js';
import { MaintenanceService } from '@worker/services/maintenance-service.js';
import type { Env } from '@worker/env.js';
import { createTestDatabase, type TestDatabase } from '../helpers/d1.js';
import { seedCatalog } from '../helpers/fixtures.js';

let db: TestDatabase;
let repository: MaintenanceRepository;
let counters: CountersRepository;

/** The maintenance job logs; nothing here cares what it says. */
const silentLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
} as unknown as ConstructorParameters<typeof MaintenanceService>[2];

const env = { ENVIRONMENT: 'test', APP_URL: 'https://car-tiv.test' } as unknown as Env;

/** Answer every oEmbed probe with one status. */
function stubYouTube(status: number | 'network-error'): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      if (status === 'network-error') return Promise.reject(new Error('offline'));
      return Promise.resolve(new Response('{}', { status }));
    }),
  );
}

const service = (): MaintenanceService =>
  new MaintenanceService(repository, counters, silentLogger);

const statusOf = (id: string): string =>
  db.queryRaw<{ status: string }>(`SELECT status FROM videos WHERE id = ?`, id)[0]?.status ?? '';

beforeEach(async () => {
  db = await createTestDatabase();
  seedCatalog(db);
  repository = new MaintenanceRepository(db);
  counters = new CountersRepository(db);
});

afterEach(() => {
  vi.unstubAllGlobals();
  db.close();
});

describe('videosDueForCheck', () => {
  it('takes never-checked videos before ones already seen', async () => {
    db.runRaw(`UPDATE videos SET last_checked_at = CURRENT_TIMESTAMP WHERE id = 'corolla0001'`);

    const due = await repository.videosDueForCheck(50);
    expect(due[0]?.id).not.toBe('corolla0001');
    // But it is still in the queue, at the back.
    expect(due.map((video) => video.id)).toContain('corolla0001');
  });

  it('skips soft-deleted videos', async () => {
    db.runRaw(`UPDATE videos SET deleted_at = CURRENT_TIMESTAMP WHERE id = 'corolla0001'`);
    const due = await repository.videosDueForCheck(50);
    expect(due.map((video) => video.id)).not.toContain('corolla0001');
  });

  it('honours the batch size, so one run stays cheap', async () => {
    expect(await repository.videosDueForCheck(3)).toHaveLength(3);
  });
});

describe('link checking', () => {
  it('leaves everything alone when YouTube answers 200', async () => {
    stubYouTube(200);

    const report = await service().run(env);
    expect(report.checked).toBeGreaterThan(0);
    expect(report.broken).toBe(0);
    expect(statusOf('corolla0001')).toBe('published');
  });

  it('does not mark a video broken on the first failure', async () => {
    stubYouTube(404);

    const report = await service().run(env);
    expect(report.broken).toBeGreaterThan(0);
    // Counted as a failure, but still published — one odd answer is not proof.
    expect(statusOf('corolla0001')).toBe('published');
    expect(
      db.queryRaw<{ check_failures: number }>(
        `SELECT check_failures FROM videos WHERE id = 'corolla0001'`,
      )[0]?.check_failures,
    ).toBe(1);
  });

  it('marks it broken on the second consecutive failure', async () => {
    stubYouTube(404);

    await service().run(env);
    await service().run(env);

    expect(statusOf('corolla0001')).toBe('broken');
  });

  it('hides a broken video from the public catalog', async () => {
    stubYouTube(404);
    await service().run(env);
    await service().run(env);

    const visible = db.queryRaw<{ id: string }>(
      `SELECT id FROM videos WHERE status = 'published' AND deleted_at IS NULL`,
    );
    expect(visible.map((video) => video.id)).not.toContain('corolla0001');
  });

  it('treats a private or embedding-disabled video as broken', async () => {
    stubYouTube(403);
    await service().run(env);
    await service().run(env);
    expect(statusOf('corolla0001')).toBe('broken');
  });

  it('changes nothing at all when YouTube is having a bad day', async () => {
    // The expensive mistake this prevents: a 500 from YouTube must never flag
    // the catalog. Twice, to prove it is not merely the first-failure grace.
    stubYouTube(500);
    await service().run(env);
    await service().run(env);

    expect(statusOf('corolla0001')).toBe('published');
    expect(
      db.queryRaw<{ check_failures: number }>(
        `SELECT check_failures FROM videos WHERE id = 'corolla0001'`,
      )[0]?.check_failures,
    ).toBe(0);
  });

  it('changes nothing when the network is unreachable', async () => {
    stubYouTube('network-error');
    await service().run(env);
    await service().run(env);
    expect(statusOf('corolla0001')).toBe('published');
  });

  it('brings a video back when the channel restores it', async () => {
    stubYouTube(404);
    await service().run(env);
    await service().run(env);
    expect(statusOf('corolla0001')).toBe('broken');

    stubYouTube(200);
    const report = await service().run(env);

    expect(statusOf('corolla0001')).toBe('published');
    expect(report.recovered).toBeGreaterThan(0);
  });

  it('never un-hides a video an editor hid by hand', async () => {
    db.runRaw(`UPDATE videos SET status = 'hidden' WHERE id = 'corolla0001'`);
    stubYouTube(200);

    await service().run(env);
    // A human decision outranks a health check.
    expect(statusOf('corolla0001')).toBe('hidden');
  });

  it('resets the failure count after a success', async () => {
    stubYouTube(404);
    await service().run(env);

    stubYouTube(200);
    await service().run(env);

    expect(
      db.queryRaw<{ check_failures: number }>(
        `SELECT check_failures FROM videos WHERE id = 'corolla0001'`,
      )[0]?.check_failures,
    ).toBe(0);
  });
});

describe('housekeeping', () => {
  it('deletes long-expired sessions and stale rate-limit windows', async () => {
    stubYouTube(200);

    db.runRaw(`INSERT INTO users (id, email, display_name) VALUES ('u1', 'a@b.com', 'x')`);
    db.runRaw(
      `INSERT INTO sessions (id, user_id, token_hash, expires_at)
       VALUES ('s1', 'u1', 'hash', datetime('now', '-10 days'))`,
    );
    db.runRaw(
      `INSERT INTO rate_limits (key, action, window_start, request_count)
       VALUES ('k', 'contact', 1, 1)`,
    );

    const report = await service().run(env);

    expect(report.sessionsPruned).toBe(1);
    expect(report.rateLimitsPruned).toBe(1);
    expect(db.queryRaw(`SELECT id FROM sessions`)).toHaveLength(0);
    expect(db.queryRaw(`SELECT key FROM rate_limits`)).toHaveLength(0);
  });

  it('keeps a live session', async () => {
    stubYouTube(200);

    db.runRaw(`INSERT INTO users (id, email, display_name) VALUES ('u1', 'a@b.com', 'x')`);
    db.runRaw(
      `INSERT INTO sessions (id, user_id, token_hash, expires_at)
       VALUES ('s1', 'u1', 'hash', datetime('now', '+10 days'))`,
    );

    await service().run(env);
    expect(db.queryRaw(`SELECT id FROM sessions`)).toHaveLength(1);
  });
});

describe('the heartbeat', () => {
  it('records every run, so a stopped job is visible', async () => {
    stubYouTube(200);
    await service().run(env);

    const runs = await repository.recentRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.checked).toBeGreaterThan(0);
  });

  it('reports how much of the catalog has been checked', async () => {
    stubYouTube(200);
    await service().run(env);

    const coverage = await repository.checkCoverage();
    expect(coverage.total).toBeGreaterThan(0);
    expect(coverage.checked).toBe(coverage.total);
    expect(coverage.broken).toBe(0);
  });
});

describe('the queue keeps moving during a YouTube outage', () => {
  it('records an attempt even when the answer is unknown', async () => {
    // The starvation bug: `last_checked_at` is only written on a definite
    // answer, and the queue was ordered by it. A video that timed out kept its
    // old timestamp and came straight back to the head of the queue — so during
    // an incident the same batch was retried hourly, forever, and the rest of
    // the catalog was never checked at all. The job looked busy the whole time.
    stubYouTube(500);
    await service().run(env);

    const attempted = db.queryRaw<{ n: number }>(
      `SELECT COUNT(*) AS n FROM videos WHERE last_attempted_at IS NOT NULL`,
    )[0]?.n;
    const verified = db.queryRaw<{ n: number }>(
      `SELECT COUNT(*) AS n FROM videos WHERE last_checked_at IS NOT NULL`,
    )[0]?.n;

    // Tried, but not verified — the two are different facts and stay different.
    expect(attempted).toBeGreaterThan(0);
    expect(verified).toBe(0);
  });

  it('puts an already-attempted video behind one never tried', async () => {
    // The property that keeps the queue moving. The fixture is smaller than one
    // batch, so rather than running the job twice this marks one video attempted
    // and asks what comes next — which is what the job does between runs.
    await repository.markAttempted(['corolla0001']);

    const next = await repository.videosDueForCheck(20);
    const ids = next.map((video) => video.id);

    // Everything untried comes first; the attempted one is last.
    expect(ids.at(-1)).toBe('corolla0001');
    expect(ids.length).toBeGreaterThan(1);
  });

  it('orders by when a video was last tried, not when it was last verified', async () => {
    // Ordering by `last_checked_at` is what caused the starvation: a video that
    // never gets a definite answer never updates that column, so it stays at
    // the head of the queue for ever.
    db.runRaw(`UPDATE videos SET last_checked_at = CURRENT_TIMESTAMP WHERE id = 'corolla0002'`);
    await repository.markAttempted(['corolla0001']);

    const ids = (await repository.videosDueForCheck(20)).map((video) => video.id);

    // corolla0002 was "checked" but never attempted, so it still comes before
    // corolla0001, which was attempted.
    expect(ids.indexOf('corolla0002')).toBeLessThan(ids.indexOf('corolla0001'));
  });

  it('does not count an unknown answer as a video checked', async () => {
    // Reporting the batch size meant a run where everything timed out still
    // said "checked 200", which is the opposite of what the dashboard is for.
    stubYouTube('network-error');
    const report = await service().run(env);

    expect(report.checked).toBe(0);
    expect(report.broken).toBe(0);
  });

  it('counts a video that answered', async () => {
    stubYouTube(200);
    const report = await service().run(env);
    expect(report.checked).toBeGreaterThan(0);
  });
});
