import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ApiEnvelope, PageMeta } from '@shared/types/api.js';
import type { VideoSummary } from '@shared/types/catalog.js';
import { createTestDatabase, type TestDatabase } from '../helpers/d1.js';
import { seedCatalog } from '../helpers/fixtures.js';
import { TEST_ORIGIN, createTestWorker, postJson, type TestWorker } from '../helpers/worker.js';

let db: TestDatabase;
let api: TestWorker;

beforeEach(async () => {
  db = await createTestDatabase();
  seedCatalog(db);
  api = createTestWorker(db);
});

afterEach(() => {
  db.close();
});

describe('envelope', () => {
  it('wraps success as { data, meta, error: null }', async () => {
    const { status, body } = await api.json<ApiEnvelope<VideoSummary[], PageMeta>>('/api/videos');
    expect(status).toBe(200);
    expect(body.error).toBeNull();
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.meta).toMatchObject({ page: 1, total: 8 });
  });

  it('wraps failure as { data: null, error: { code, message } }', async () => {
    const { status, body } = await api.json<ApiEnvelope<null>>('/api/videos/not-an-id');
    expect(status).toBe(400);
    expect(body.data).toBeNull();
    expect(body.error?.code).toBe('INVALID_VIDEO_ID');
    expect(body.error?.message).toBeTruthy();
  });

  it('answers an unknown path with 404 and a code', async () => {
    const { status, body } = await api.json<ApiEnvelope<null>>('/api/nope');
    expect(status).toBe(404);
    expect(body.error?.code).toBe('NOT_FOUND');
  });

  it('answers a known path with the wrong method with 405 and an Allow header', async () => {
    const response = await api.fetch('/api/videos', { method: 'POST', body: '{}' });
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toContain('GET');
  });

  it('echoes a request id', async () => {
    const response = await api.fetch('/api/categories');
    expect(response.headers.get('x-request-id')).toBeTruthy();
  });
});

describe('GET /api/categories', () => {
  it('carries the icon and gradient the home-page tiles are drawn from', async () => {
    const { body } =
      await api.json<
        ApiEnvelope<{ id: string; icon: string; colorFrom: string; colorTo: string }[]>
      >('/api/categories');

    const maintenance = body.data?.find((category) => category.id === 'maintenance');
    expect(maintenance?.icon).toBe('oil-can');
    // Real CSS colours, so a tile can be styled without a lookup table in the
    // client — and so an editor can change one without a deployment.
    expect(maintenance?.colorFrom).toMatch(/^#[0-9a-f]{6}$/i);
    expect(maintenance?.colorTo).toMatch(/^#[0-9a-f]{6}$/i);
  });
});

describe('caching', () => {
  it('caches reference data at the edge', async () => {
    const response = await api.fetch('/api/categories');
    expect(response.headers.get('cache-control')).toContain('s-maxage=');
  });

  it('never caches an error', async () => {
    const response = await api.fetch('/api/videos/not-an-id');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});

describe('GET /api/videos', () => {
  it('hydrates an explicit list of ids', async () => {
    // What the offline library and playlists need: a saved set of ids turned
    // back into cards in one request. `CatalogRepository.getVideosByIds` sent
    // this parameter at an endpoint that did not read it, so it quietly
    // returned the newest videos in the catalog instead of the ones asked for
    // — a wrong answer with a 200 beside it.
    const all = await api.json<ApiEnvelope<VideoSummary[], PageMeta>>('/api/videos');
    const wanted = (all.body.data ?? []).slice(0, 3).map((video) => String(video.id));
    expect(wanted.length).toBe(3);

    const { body } = await api.json<ApiEnvelope<VideoSummary[], PageMeta>>(
      `/api/videos?ids=${wanted.join(',')}`,
    );

    expect(body.data?.map((video) => String(video.id)).sort()).toEqual([...wanted].sort());
    // The total must describe the id list, not the category the counter knows.
    expect(body.meta?.total).toBe(3);
  });

  it('ignores an id that is not in the catalog rather than failing', async () => {
    // A library saved months ago will name videos that have since been hidden
    // or removed. Those must simply not come back.
    const { status, body } = await api.json<ApiEnvelope<VideoSummary[], PageMeta>>(
      '/api/videos?ids=corolla0001,zzzzzzzzzzz',
    );

    expect(status).toBe(200);
    expect(body.data).toHaveLength(1);
  });

  it('reads filters from the query string', async () => {
    const { body } = await api.json<ApiEnvelope<VideoSummary[], PageMeta>>(
      '/api/videos?category=maintenance&hebrew=1',
    );
    expect(body.meta.total).toBe(2);
  });

  it('clamps a hostile limit instead of failing', async () => {
    const { status, body } = await api.json<ApiEnvelope<VideoSummary[], PageMeta>>(
      '/api/videos?limit=100000',
    );
    expect(status).toBe(200);
    expect(body.meta.limit).toBeLessThanOrEqual(60);
  });

  it('logs a search, including one with no results', async () => {
    await api.fetch('/api/videos?q=' + encodeURIComponent('החלפת משאבת ABS'));
    await api.drain();

    const rows = db.queryRaw<{ query: string; hits: number; zero_hits: number }>(
      `SELECT query, hits, zero_hits FROM search_query_daily`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.hits).toBe(1);
    expect(rows[0]?.zero_hits).toBe(1);
  });

  it('counts a repeated search instead of writing another row', async () => {
    // The reason this is a counter and not a log: `/api/videos?q=` is public
    // and unauthenticated, and a row per search let anyone mint a D1 write per
    // request by varying the query. Bounded by distinct searches per day, the
    // table cannot be used to spend the write budget.
    const url = '/api/videos?q=' + encodeURIComponent('בלמים');
    for (let attempt = 0; attempt < 3; attempt++) {
      await api.fetch(url);
      await api.drain();
    }

    const rows = db.queryRaw<{ hits: number }>(`SELECT hits FROM search_query_daily`);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.hits).toBe(3);
  });

  it('does not log a query too short to search', async () => {
    await api.fetch('/api/videos?q=a');
    await api.drain();
    expect(db.queryRaw(`SELECT 1 FROM search_query_daily`)).toHaveLength(0);
  });
});

describe('GET /api/videos/:id', () => {
  it('returns a video', async () => {
    const { body } = await api.json<ApiEnvelope<{ id: string }>>('/api/videos/corolla0001');
    expect(body.data?.id).toBe('corolla0001');
  });

  it('returns 404 for a well-formed id that does not exist', async () => {
    const { status, body } = await api.json<ApiEnvelope<null>>('/api/videos/zzzzzzzzzzz');
    expect(status).toBe(404);
    expect(body.error?.code).toBe('VIDEO_NOT_FOUND');
  });

  it('routes /related separately from the video itself', async () => {
    const { status, body } = await api.json<ApiEnvelope<VideoSummary[]>>(
      '/api/videos/corolla0001/related',
    );
    expect(status).toBe(200);
    expect(body.data?.length).toBeGreaterThan(0);
  });
});

describe('GET /api/videos/exists', () => {
  it('is matched before /api/videos/:id', async () => {
    const { status, body } = await api.json<ApiEnvelope<{ exists: boolean }>>(
      '/api/videos/exists?value=https://youtu.be/corolla0001',
    );
    expect(status).toBe(200);
    expect(body.data?.exists).toBe(true);
  });

  it('rejects an unusable value', async () => {
    const { status } = await api.json('/api/videos/exists?value=hello');
    expect(status).toBe(400);
  });
});

describe('GET /api/channels', () => {
  it('lists channels with their video counts', async () => {
    const { body } =
      await api.json<ApiEnvelope<{ slug: string; videoCount: number }[], PageMeta>>(
        '/api/channels',
      );
    expect(body.data?.find((channel) => channel.slug === 'auto-il')?.videoCount).toBe(4);
  });

  it('returns one channel with its videos', async () => {
    const { body } =
      await api.json<ApiEnvelope<{ channel: { slug: string }; videos: unknown[] }>>(
        '/api/channels/auto-il',
      );
    expect(body.data?.channel.slug).toBe('auto-il');
    expect(body.data?.videos.length).toBe(4);
  });
});

describe('GET /api/search/suggestions', () => {
  it('returns nothing for a query below the minimum length', async () => {
    const { body } = await api.json<ApiEnvelope<unknown[]>>('/api/search/suggestions?q=a');
    expect(body.data).toEqual([]);
  });

  it('suggests tags and videos', async () => {
    const { body } = await api.json<ApiEnvelope<{ type: string }[]>>(
      '/api/search/suggestions?q=' + encodeURIComponent('שמן'),
    );
    expect(body.data?.length).toBeGreaterThan(0);
  });
});

describe('GET /api/home', () => {
  it('returns stats, categories and populated sections', async () => {
    const { body } =
      await api.json<
        ApiEnvelope<{ stats: { videos: number }; sections: { id: string; videos: unknown[] }[] }>
      >('/api/home');
    expect(body.data?.stats.videos).toBe(8);
    expect(body.data?.sections.some((section) => section.videos.length > 0)).toBe(true);
  });
});

describe('POST /api/reports', () => {
  it('stores a valid report', async () => {
    const { status } = await api.json(
      '/api/reports',
      postJson({ videoId: 'corolla0001', reason: 'broken', message: 'הסרטון לא נטען' }),
    );
    expect(status).toBe(201);
    expect(db.queryRaw(`SELECT 1 FROM video_reports`)).toHaveLength(1);
  });

  it('returns per-field messages for an invalid body', async () => {
    const { status, body } = await api.json<ApiEnvelope<null>>(
      '/api/reports',
      postJson({ videoId: 'nope', reason: 'unknown-reason' }),
    );
    expect(status).toBe(422);
    expect(body.error?.code).toBe('VALIDATION_ERROR');
    expect(Object.keys(body.error?.fields ?? {})).toEqual(
      expect.arrayContaining(['videoId', 'reason']),
    );
  });

  it('refuses a report about a video that does not exist', async () => {
    const { status } = await api.json(
      '/api/reports',
      postJson({ videoId: 'zzzzzzzzzzz', reason: 'broken' }),
    );
    expect(status).toBe(404);
  });

  it('refuses a cross-origin post', async () => {
    const { status } = await api.json(
      '/api/reports',
      postJson({ videoId: 'corolla0001', reason: 'broken' }, { origin: 'https://evil.example' }),
    );
    expect(status).toBe(403);
  });

  it('rate limits after the configured number of reports', async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await api.json('/api/reports', postJson({ videoId: 'corolla0001', reason: 'broken' }));
    }
    const response = await api.fetch(
      '/api/reports',
      postJson({ videoId: 'corolla0001', reason: 'broken' }),
    );
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBeTruthy();
  });
});

describe('POST /api/submissions', () => {
  it('accepts a YouTube URL in any form', async () => {
    const { status } = await api.json(
      '/api/submissions',
      postJson({ url: 'https://www.youtube.com/watch?v=brandnew001&list=x', name: 'דני' }),
    );
    expect(status).toBe(201);
    const rows = db.queryRaw<{ youtube_id: string }>(`SELECT youtube_id FROM video_submissions`);
    expect(rows[0]?.youtube_id).toBe('brandnew001');
  });

  it('rejects a video that is already in the catalog', async () => {
    const { status, body } = await api.json<ApiEnvelope<null>>(
      '/api/submissions',
      postJson({ url: 'corolla0001' }),
    );
    expect(status).toBe(409);
    expect(body.error?.code).toBe('DUPLICATE');
  });

  it('rejects a second submission of the same pending video', async () => {
    await api.json('/api/submissions', postJson({ url: 'brandnew001' }));
    const { status } = await api.json('/api/submissions', postJson({ url: 'brandnew001' }));
    expect(status).toBe(409);
  });
});

describe('POST /api/contact', () => {
  it('opens a thread with the first message', async () => {
    const { status } = await api.json(
      '/api/contact',
      postJson({
        name: 'ישראל',
        email: 'israel@example.com',
        subject: 'שאלה',
        message: 'שלום, יש לי שאלה על האתר',
        acceptedPrivacy: true,
      }),
    );
    expect(status).toBe(201);
    expect(db.queryRaw(`SELECT 1 FROM contact_threads`)).toHaveLength(1);
    expect(db.queryRaw(`SELECT 1 FROM contact_messages`)).toHaveLength(1);
  });

  it('requires the privacy checkbox', async () => {
    const { status, body } = await api.json<ApiEnvelope<null>>(
      '/api/contact',
      postJson({ name: 'ישראל', email: 'a@b.com', message: 'שלום', acceptedPrivacy: false }),
    );
    expect(status).toBe(422);
    expect(body.error?.fields?.acceptedPrivacy).toBeTruthy();
  });
});

describe('pages and redirects', () => {
  it('redirects a legacy ?v= link to /video/:id', async () => {
    const response = await api.fetch('/?v=corolla0001');
    expect(response.status).toBe(301);
    expect(response.headers.get('location')).toBe(`${TEST_ORIGIN}/video/corolla0001`);
  });

  it('redirects the legacy channels view', async () => {
    const response = await api.fetch('/?page=channels');
    expect(response.headers.get('location')).toBe(`${TEST_ORIGIN}/channels/`);
  });

  it('redirects privacy.html to /privacy/', async () => {
    const response = await api.fetch('/privacy.html');
    expect(response.headers.get('location')).toBe(`${TEST_ORIGIN}/privacy/`);
  });

  it('rewrites /video/:id to the video page shell', async () => {
    await api.fetch('/video/corolla0001');
    expect(api.assetRequests).toContain('/video/index.html');
  });

  it('does not rewrite a malformed video id', async () => {
    await api.fetch('/video/not-an-id');
    expect(api.assetRequests).not.toContain('/video/index.html');
  });

  it('adds security headers to a page response', async () => {
    const response = await api.fetch('/');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-security-policy')).toContain('youtube-nocookie.com');
  });
});

describe('GET /api/videos/:id?include=', () => {
  // The video page used to make three calls — the video, its related videos,
  // and the channel's other videos — which with the page's own HTML came to
  // four Worker requests. On a free plan capped at 100,000 a day, and with none
  // of the three reusable on the next video, that was the site's most expensive
  // page. `include` makes it two.

  it('returns the video alone by default, unchanged', async () => {
    const { body } =
      await api.json<ApiEnvelope<Record<string, unknown>>>('/api/videos/corolla0001');

    expect(body.data?.id).toBe('corolla0001');
    // Absent, not null: nothing that already calls this endpoint sees a change.
    expect(body.data).not.toHaveProperty('related');
    expect(body.data).not.toHaveProperty('channelVideos');
  });

  it('folds the related videos into the same response', async () => {
    const { body } = await api.json<ApiEnvelope<{ related: VideoSummary[] | null }>>(
      '/api/videos/corolla0001?include=related',
    );

    expect(Array.isArray(body.data?.related)).toBe(true);
    expect(body.data?.related?.length).toBeGreaterThan(0);
    expect(body.data?.related?.some((video) => video.id === 'corolla0001')).toBe(false);
  });

  it('folds the channel’s other videos in too', async () => {
    const { body } = await api.json<ApiEnvelope<{ channelVideos: VideoSummary[] | null }>>(
      '/api/videos/corolla0001?include=channel',
    );

    expect(Array.isArray(body.data?.channelVideos)).toBe(true);
    // The video being watched is excluded server-side.
    expect(body.data?.channelVideos?.some((video) => video.id === 'corolla0001')).toBe(false);
  });

  it('returns exactly what the three separate calls return', async () => {
    // The saving is only worth having if the combined payload is identical to
    // what the page would have assembled itself.
    const combined = await api.json<
      ApiEnvelope<{ related: VideoSummary[]; channelVideos: VideoSummary[] }>
    >('/api/videos/corolla0001?include=related,channel');
    const separate = await api.json<ApiEnvelope<VideoSummary[]>>('/api/videos/corolla0001/related');

    expect(combined.body.data?.related.map((video) => video.id)).toEqual(
      separate.body.data?.map((video) => video.id),
    );
  });

  it('ignores an unknown include rather than failing the page', async () => {
    const { status, body } = await api.json<ApiEnvelope<Record<string, unknown>>>(
      '/api/videos/corolla0001?include=nonsense',
    );

    expect(status).toBe(200);
    expect(body.data?.id).toBe('corolla0001');
  });

  it('handles a video with no channel', async () => {
    db.runRaw(`UPDATE videos SET channel_id = NULL WHERE id = 'corolla0001'`);

    const { status, body } = await api.json<ApiEnvelope<{ channelVideos: unknown }>>(
      '/api/videos/corolla0001?include=related,channel',
    );

    expect(status).toBe(200);
    expect(body.data?.channelVideos).toBeNull();
  });
});

describe('unbounded query parameters', () => {
  // Both of these routes read their parameters raw while `/api/videos` clamped
  // through `parseQuery`. Both are cached with `q` in the key, so an unbounded
  // value was an unbounded FTS query *and* an unbounded cache key — a way to
  // fill the edge cache with entries nobody will ever request again.
  const huge = 'א'.repeat(5_000);

  it('clamps the search suggestion query', async () => {
    const { status } = await api.json(`/api/search/suggestions?q=${encodeURIComponent(huge)}`);
    expect(status).toBe(200);
  });

  it('clamps the tag search query', async () => {
    const { status } = await api.json(`/api/tags/search?q=${encodeURIComponent(huge)}`);
    expect(status).toBe(200);
  });

  it('clamps the tag search category', async () => {
    const { status } = await api.json(
      `/api/tags/search?q=שמן&category=${encodeURIComponent(huge)}`,
    );
    expect(status).toBe(200);
  });

  it('still answers a normal suggestion query', async () => {
    const { status, body } = await api.json<ApiEnvelope<unknown[]>>(
      '/api/search/suggestions?q=טוי',
    );
    expect(status).toBe(200);
    expect(Array.isArray(body.data)).toBe(true);
  });
});
