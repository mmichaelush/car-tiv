import { readFileSync, readdirSync, existsSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { createTestDatabase } from '../helpers/d1.js';
import { CatalogRepository } from '@worker/repositories/catalog-repository.js';
import { VideoRepository } from '@worker/repositories/video-repository.js';
import { CountersRepository, COUNTER_REFRESH } from '@worker/repositories/counters-repository.js';
import { SearchRepository } from '@worker/repositories/search-repository.js';
import { MaintenanceRepository } from '@worker/repositories/maintenance-repository.js';
import { EMPTY_QUERY } from '@shared/core/query.js';
import type { VideoId } from '@shared/types/catalog.js';

const root = path.resolve(import.meta.dirname, '../..');
const built = path.join(root, 'build/catalog');
const suite = existsSync(built) ? describe : describe.skip;

suite('final package against the migrated database', () => {
  it('preserves every source field and records the real repository query plans', async () => {
    const db = await createTestDatabase();
    try {
      for (const file of readdirSync(built)
        .filter((n) => n.endsWith('.sql'))
        .sort()) {
        await db.exec(readFileSync(path.join(built, file), 'utf8'));
      }
      const channels = JSON.parse(
        readFileSync(path.join(root, 'data/featured_channels.json'), 'utf8'),
      ) as {
        channels: {
          id: string;
          channel_name: string;
          channel_url: string;
          youtubeChannelId?: string;
          netfreeOpen: boolean;
          hasHebrewVideos: boolean;
        }[];
      };
      const source = readdirSync(path.join(root, 'data/videos')).flatMap((file) => {
        const data = JSON.parse(readFileSync(path.join(root, 'data/videos', file), 'utf8')) as {
          videos: {
            id: string;
            title: string;
            content: string;
            channelId: string;
            netfreeOpen: boolean;
            hebrewContent: boolean;
          }[];
        };
        return data.videos;
      });
      expect(db.rowCount('videos')).toBe(source.length);
      const stored = new Map(
        db
          .queryRaw<{
            id: string;
            title: string;
            description: string;
            source_id: string;
            netfree_open: number;
            is_hebrew: number;
          }>(
            `SELECT v.id, v.title, v.description, c.source_id,
        v.netfree_open, v.is_hebrew FROM videos v JOIN channels c ON c.id = v.channel_id`,
          )
          .map((v) => [v.id, v]),
      );
      for (const video of source) {
        expect(stored.get(video.id)).toMatchObject({
          title: video.title,
          description: video.content,
          source_id: video.channelId,
          netfree_open: Number(video.netfreeOpen),
          is_hebrew: Number(video.hebrewContent),
        });
      }
      const catalog = new CatalogRepository(db);
      for (const channel of channels.channels) {
        expect(await catalog.findChannel(channel.id)).toMatchObject({
          sourceId: channel.id,
          name: channel.channel_name,
          youtubeUrl: channel.channel_url,
          youtubeChannelId: channel.youtubeChannelId ?? null,
          netfreeOpen: channel.netfreeOpen,
          hasHebrewVideos: channel.hasHebrewVideos,
        });
      }
      expect(db.queryRaw('PRAGMA foreign_key_check')).toEqual([]);
      expect(db.rowCount('videos_fts')).toBe(source.length);
      const counters = new CountersRepository(db);
      await counters.refreshAll();
      const videos = new VideoRepository(db);
      const search = new SearchRepository(db);
      const first = source[0]!;
      const jobs: Record<string, () => Promise<unknown>> = {
        categories: () => catalog.listCategories(),
        channels: () => catalog.listChannels({}),
        tags: () => catalog.listPopularTags('all', 40),
        categoryTags: () => catalog.listPopularTags('review', 40),
        stats: () => catalog.stats(),
        listing: () => videos.list(EMPTY_QUERY),
        category: () => videos.list({ ...EMPTY_QUERY, category: 'review' }),
        channel: () => videos.findByChannel(first.channelId, null, 24),
        search: () => videos.list({ ...EMPTY_QUERY, q: 'טויוטה' }),
        tagsFilter: () => videos.list({ ...EMPTY_QUERY, tags: ['טויוטה'] }),
        manufacturer: () => videos.list({ ...EMPTY_QUERY, manufacturer: 'toyota' }),
        suggestions: () => search.suggest('טויוטה'),
        related: () => videos.findRelated(first.id as VideoId, 12),
        page2: () => videos.list({ ...EMPTY_QUERY, page: 2 }),
        idleCounters: () => counters.refreshAll(),
        growthFirst: () => counters.sampleGrowth(),
        growthRepeat: () => counters.sampleGrowth(),
        checkQueue: () => new MaintenanceRepository(db).videosDueForCheck(200),
      };
      const report: Record<string, unknown> = {};
      for (const [name, job] of Object.entries(jobs)) {
        const start = performance.now();
        const statements = await db.record(job);
        report[name] = {
          queries: statements.length,
          durationMs: performance.now() - start,
          statements: statements.map((s) => ({ ...s, plan: db.explain(s) })),
        };
        if (name === 'growthRepeat') expect(statements).toHaveLength(1);
        if (name === 'checkQueue') {
          const plan = statements.flatMap((s) => db.explain(s));
          expect(plan.some((line) => line.includes('idx_videos_check_queue'))).toBe(true);
          expect(plan.some((line) => line.includes('TEMP B-TREE'))).toBe(false);
        }
        if (name === 'listing') {
          const plan = statements.flatMap((s) => db.explain(s));
          expect(plan.some((line) => /SEARCH vt .*video_id=/.test(line))).toBe(true);
          expect(plan.some((line) => /SEARCH t .*idx_tags_popular/.test(line))).toBe(false);
        }
        if (name === 'idleCounters')
          expect(statements.some((s) => /video_tags|UPDATE tags|UPDATE channels/.test(s.sql))).toBe(
            false,
          );
      }
      report.counterPlansBefore = Object.entries(COUNTER_REFRESH).map(([name, sql]) => ({
        name,
        plan: db.explain({ sql, bindings: [], rows: 0 }),
      }));
      report.counts = Object.fromEntries(
        ['videos', 'channels', 'tags', 'video_tags', 'video_vehicle_models', 'videos_fts'].map(
          (t) => [t, db.rowCount(t)],
        ),
      );
      writeFileSync(
        path.join(root, 'build/performance-audit.json'),
        JSON.stringify(report, null, 2),
      );
      const dbFile = path.join(root, 'build/catalog-validation.sqlite').replaceAll('\\', '/');
      if (existsSync(dbFile)) unlinkSync(dbFile);
      await db.exec(`VACUUM INTO '${dbFile.replaceAll("'", "''")}'`);
    } finally {
      db.close();
    }
  }, 120_000);
});
