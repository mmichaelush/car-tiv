import { afterEach, it, expect, vi } from 'vitest';
import { withEdgeCache, purgeVideo } from '@worker/middleware/edge-cache.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function cache(): void {
  const items = new Map<string, Response>();
  vi.stubGlobal('caches', {
    default: {
      match: (key: string) => Promise.resolve(items.get(key)?.clone()),
      put: (key: string, response: Response) => {
        items.set(key, response.clone());
        return Promise.resolve();
      },
      delete: (key: string) => Promise.resolve(items.delete(key)),
    },
  });
}

it('serves stale reference data while one background refresh replaces it', async () => {
  cache();
  const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
  const url = new URL('https://test/api/categories');
  const work: Promise<unknown>[] = [];
  const produce = vi.fn(() =>
    Promise.resolve(
      new Response(String(produce.mock.calls.length), {
        headers: { 'cache-control': 'public, max-age=10, s-maxage=60' },
      }),
    ),
  );
  const call = () =>
    withEdgeCache(new Request(url), url, 'stale-test', (p) => work.push(p), produce);
  expect(await (await call()).response.text()).toBe('1');
  now.mockReturnValue(1_061_000);
  const stale = await Promise.all([call(), call()]);
  for (const result of stale) {
    expect(result.hit).toBe(true);
    expect(await result.response.text()).toBe('1');
    expect(result.response.headers.has('x-cartiv-fresh-until')).toBe(false);
    expect(result.response.headers.get('cache-control')).toBe('public, max-age=10, s-maxage=60');
  }
  await Promise.all(work);
  expect(produce).toHaveBeenCalledTimes(2);
  expect(await (await call()).response.text()).toBe('2');
});

it('stores, hits, coalesces concurrent misses and invalidates video responses', async () => {
  cache();
  const url = new URL('https://test/api/videos/abcdefghijk');
  const produce = vi.fn(() =>
    Promise.resolve(new Response('{}', { headers: { 'cache-control': 'public, s-maxage=60' } })),
  );
  const call = () => withEdgeCache(new Request(url), url, 'test', () => undefined, produce);
  const initial = await Promise.all([call(), call(), call()]);
  expect(produce).toHaveBeenCalledTimes(1);
  for (const result of initial) expect(await result.response.text()).toBe('{}');
  expect((await call()).hit).toBe(true);
  await purgeVideo('abcdefghijk', 'test');
  expect((await call()).hit).toBe(false);
  expect(produce).toHaveBeenCalledTimes(2);
});

it('never shares a response containing a session cookie', async () => {
  cache();
  const url = new URL('https://test/api/videos/abcdefghijl');
  const produce = vi.fn(() =>
    Promise.resolve(
      new Response('{}', {
        headers: {
          'cache-control': 'public, s-maxage=60',
          'set-cookie': 'session=private',
        },
      }),
    ),
  );
  const call = () => withEdgeCache(new Request(url), url, 'test', () => undefined, produce);
  await Promise.all([call(), call()]);
  expect(produce).toHaveBeenCalledTimes(2);
  expect((await call()).hit).toBe(false);
});
