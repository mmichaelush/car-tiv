import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EMPTY_QUERY } from '@shared/core/query.js';
import type { VideoId, VideoQuery } from '@shared/types/catalog.js';
import { VideoRepository } from '@worker/repositories/video-repository.js';
import { createTestDatabase, type TestDatabase } from '../helpers/d1.js';
import { seedCatalog } from '../helpers/fixtures.js';

let db: TestDatabase;
let repository: VideoRepository;

const query = (overrides: Partial<VideoQuery> = {}): VideoQuery => ({
  ...EMPTY_QUERY,
  ...overrides,
});
const id = (value: string): VideoId => value as VideoId;

beforeEach(async () => {
  db = await createTestDatabase();
  seedCatalog(db);
  repository = new VideoRepository(db);
});

afterEach(() => {
  db.close();
});

describe('list — visibility', () => {
  it('returns only published, non-deleted videos', async () => {
    const page = await repository.list(query());
    expect(page.meta.total).toBe(8);
    expect(page.items.map((video) => video.id)).not.toContain('hidden00001');
  });

  it('hides a soft-deleted video', async () => {
    db.runRaw(`UPDATE videos SET deleted_at = '2026-09-01' WHERE id = 'corolla0001'`);
    const page = await repository.list(query());
    expect(page.items.map((video) => video.id)).not.toContain('corolla0001');
  });
});

describe('list — ordering and paging', () => {
  it('defaults to newest first', async () => {
    const page = await repository.list(query());
    expect(page.items[0]?.id).toBe('corolla0001');
    expect(page.items.at(-1)?.id).toBe('offroad0001');
  });

  it('sorts by duration in both directions', async () => {
    const shortest = await repository.list(query({ sort: 'duration-asc' }));
    expect(shortest.items[0]?.id).toBe('short000001');

    const longest = await repository.list(query({ sort: 'duration-desc' }));
    expect(longest.items[0]?.id).toBe('offroad0001');
  });

  it('sorts by title in both directions', async () => {
    const ascending = await repository.list(query({ sort: 'title-asc' }));
    const descending = await repository.list(query({ sort: 'title-desc' }));

    expect(ascending.items).toHaveLength(descending.items.length);
    expect(descending.items.map((video) => video.id)).toEqual(
      [...ascending.items].reverse().map((video) => video.id),
    );
  });

  it('pages through the catalog without repeating or dropping a row', async () => {
    const first = await repository.list(query({ limit: 3, page: 1 }));
    const second = await repository.list(query({ limit: 3, page: 2 }));
    const third = await repository.list(query({ limit: 3, page: 3 }));

    expect(first.meta).toMatchObject({ page: 1, limit: 3, total: 8, pages: 3 });
    const ids = [...first.items, ...second.items, ...third.items].map((video) => video.id);
    expect(new Set(ids).size).toBe(8);
  });

  it('returns an empty page past the end rather than failing', async () => {
    const page = await repository.list(query({ page: 99 }));
    expect(page.items).toEqual([]);
    expect(page.meta.total).toBe(8);
  });
});

describe('list — filters', () => {
  it('filters by category', async () => {
    const page = await repository.list(query({ category: 'maintenance' }));
    expect(page.items.map((video) => video.id).sort()).toEqual(['corolla0001', 'i4000000001']);
  });

  it('filters by channel', async () => {
    const page = await repository.list(query({ channel: 'garage-tv' }));
    expect(page.meta.total).toBe(2);
  });

  it('filters to Hebrew content only', async () => {
    const page = await repository.list(query({ hebrewOnly: true }));
    expect(page.items.map((video) => video.id)).not.toContain('english0001');
  });

  it('filters to featured videos only', async () => {
    const page = await repository.list(query({ featuredOnly: true }));
    expect(page.items.map((video) => video.id)).toEqual(['corolla0002']);
  });

  it('combines several tags with AND, not OR', async () => {
    const one = await repository.list(query({ tags: ['שמנ-מנוע'] }));
    expect(one.meta.total).toBe(2);

    const both = await repository.list(query({ tags: ['שמנ-מנוע', 'בלמימ'] }));
    expect(both.meta.total).toBe(0);
  });

  it('filters by duration range', async () => {
    const page = await repository.list(query({ maxDurationSeconds: 600 }));
    expect(page.items.map((video) => video.id).sort()).toEqual([
      'corolla0001',
      'short000001',
      'yaris000001',
    ]);
  });

  it('filters by manufacturer, model and year', async () => {
    expect((await repository.list(query({ manufacturer: 'toyota' }))).meta.total).toBe(3);
    expect(
      (await repository.list(query({ manufacturer: 'toyota', model: 'corolla' }))).meta.total,
    ).toBe(2);
    expect((await repository.list(query({ manufacturer: 'hyundai', year: 2012 }))).meta.total).toBe(
      1,
    );
    expect((await repository.list(query({ manufacturer: 'hyundai', year: 2020 }))).meta.total).toBe(
      0,
    );
  });

  it('applies filters together', async () => {
    const page = await repository.list(
      query({ category: 'review', channel: 'auto-il', hebrewOnly: true }),
    );
    expect(page.items.map((video) => video.id).sort()).toEqual(['corolla0002', 'yaris000001']);
  });
});

describe('list — full-text search', () => {
  it('finds Hebrew text regardless of the exact spelling', async () => {
    const page = await repository.list(query({ q: 'קורולה' }));
    expect(page.meta.total).toBe(2);
  });

  it('matches a manufacturer name in English against Hebrew content', async () => {
    const page = await repository.list(query({ q: 'toyota' }));
    expect(page.meta.total).toBe(3);
  });

  it('treats several words as AND', async () => {
    expect((await repository.list(query({ q: 'שמן קורולה' }))).meta.total).toBe(1);
  });

  it('ranks a title match above a description match', async () => {
    const page = await repository.list(query({ q: 'שמן' }));
    expect(page.items[0]?.id).toBe('corolla0001');
  });

  it('returns nothing for a query with no match, rather than everything', async () => {
    expect((await repository.list(query({ q: 'קוואדים' }))).meta.total).toBe(0);
  });

  it('does not break on FTS operator characters typed by a visitor', async () => {
    for (const hostile of ['"', 'NEAR(', 'a OR b', '*', '-שמן', 'שמן"']) {
      await expect(repository.list(query({ q: hostile }))).resolves.toBeDefined();
    }
  });

  it('combines search with filters', async () => {
    const page = await repository.list(query({ q: 'טויוטה', category: 'review' }));
    expect(page.meta.total).toBe(2);
  });
});

describe('findById', () => {
  it('returns the full document with tags and vehicles', async () => {
    const video = await repository.findById(id('corolla0001'));
    expect(video?.title).toBe('החלפת שמן בטויוטה קורולה 2015');
    expect(video?.channel?.slug).toBe('auto-il');
    expect(video?.tags).toEqual(expect.arrayContaining(['שמן מנוע', 'טיפול']));
    expect(video?.vehicles).toEqual([
      { manufacturer: 'toyota', model: 'corolla', yearFrom: 2015, yearTo: 2015 },
    ]);
  });

  it('returns null for an unknown or hidden video', async () => {
    expect(await repository.findById(id('zzzzzzzzzzz'))).toBeNull();
    expect(await repository.findById(id('hidden00001'))).toBeNull();
  });
});

describe('findRelated', () => {
  it('ranks the same model above the same category', async () => {
    const related = await repository.findRelated(id('corolla0001'));
    expect(related[0]?.id).toBe('corolla0002');
  });

  it('never includes the source video', async () => {
    const related = await repository.findRelated(id('corolla0001'));
    expect(related.map((video) => video.id)).not.toContain('corolla0001');
  });

  it('excludes videos with nothing in common', async () => {
    const related = await repository.findRelated(id('offroad0001'));
    expect(related.map((video) => video.id)).not.toContain('english0001');
  });

  it('respects the limit', async () => {
    expect(await repository.findRelated(id('corolla0001'), 2)).toHaveLength(2);
  });
});

describe('findByChannel', () => {
  it('returns the channel’s videos, excluding the one being watched', async () => {
    const videos = await repository.findByChannel('auto-il', id('corolla0002'), 10);
    expect(videos.map((video) => video.id)).toEqual(['corolla0001', 'yaris000001', 'short000001']);
  });
});

describe('findManyByIds', () => {
  it('preserves the caller’s order and drops unknown ids', async () => {
    const videos = await repository.findManyByIds([
      id('short000001'),
      id('zzzzzzzzzzz'),
      id('corolla0001'),
    ]);
    expect(videos.map((video) => video.id)).toEqual(['short000001', 'corolla0001']);
  });

  it('returns an empty array for an empty request without querying', async () => {
    expect(await repository.findManyByIds([])).toEqual([]);
  });
});

describe('existsAnywhere', () => {
  it('reports a published video', async () => {
    expect(await repository.existsAnywhere(id('corolla0001'))).toEqual({
      published: true,
      pending: false,
    });
  });

  it('reports a video waiting for review', async () => {
    db.runRaw(
      `INSERT INTO video_submissions (id, youtube_id, youtube_url, status) VALUES ('s1', 'newvideo001', 'https://x', 'new')`,
    );
    expect(await repository.existsAnywhere(id('newvideo001'))).toEqual({
      published: false,
      pending: true,
    });
  });

  it('reports an unknown video', async () => {
    expect(await repository.existsAnywhere(id('zzzzzzzzzzz'))).toEqual({
      published: false,
      pending: false,
    });
  });
});
