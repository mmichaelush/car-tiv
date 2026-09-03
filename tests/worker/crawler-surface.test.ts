/**
 * What a search engine actually sees.
 *
 * Everything here failed silently. A crawler does not report back, the site
 * looks perfect in a browser, and the only symptom is that nothing is indexed —
 * which takes weeks to notice and looks like a ranking problem rather than a
 * bug.
 *
 * Two of the three were found by reading rather than by using the site:
 *
 *  * `robots.txt` was a static file saying `Sitemap: /sitemap.xml`. The
 *    standard requires that value to be a fully-qualified URL; a relative one
 *    is not "mostly works", it is ignored. So every sitemap the Worker
 *    generates was undiscoverable.
 *  * `/sitemap*` was missing from `run_worker_first`, so the asset handler
 *    answered first, found no such file, and served the single-page app's 404
 *    page — with a 200. A crawler was handed HTML that claimed to be a sitemap.
 *  * The router only treated a path segment *starting* with a colon as a
 *    parameter, so `/sitemap-videos-:page.xml` matched only its own literal
 *    text and all 7,876 video URLs 404ed.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../helpers/d1.js';
import { seedCatalog } from '../helpers/fixtures.js';
import { TEST_ORIGIN, createTestWorker, type TestWorker } from '../helpers/worker.js';

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

describe('robots.txt', () => {
  it('is served by the Worker, not by the asset handler', async () => {
    const response = await api.fetch('/robots.txt');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');
  });

  it('names the sitemap by absolute URL', async () => {
    // The whole point. A relative `Sitemap:` line is ignored by crawlers.
    const body = await (await api.fetch('/robots.txt')).text();

    expect(body).toContain(`Sitemap: ${TEST_ORIGIN}/sitemap.xml`);
    expect(body).not.toContain('Sitemap: /sitemap.xml');
  });

  it('takes its origin from the environment, not from a hardcoded host', async () => {
    // Staging must advertise staging. Writing a hostname into the repository is
    // the one thing the deployment rules forbid, which is also why this could
    // not be fixed by editing the static file.
    const other = createTestWorker(db, { APP_URL: 'https://example.test' });
    const body = await (await other.fetch('/robots.txt')).text();

    expect(body).toContain('Sitemap: https://example.test/sitemap.xml');
  });

  it('still keeps crawlers out of the private areas', async () => {
    const body = await (await api.fetch('/robots.txt')).text();

    expect(body).toContain('Disallow: /admin/');
    expect(body).toContain('Disallow: /library/');
    expect(body).toContain('Disallow: /search?');
    expect(body).toContain('Allow: /');
  });
});

describe('the sitemap a crawler is handed', () => {
  it('serves the index', async () => {
    const response = await api.fetch('/sitemap.xml');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('xml');
  });

  it('serves every video page the index advertises', async () => {
    // The bug this replaces made all of them 404. The index lists its own
    // children, so following them is exactly what a crawler does.
    const index = await (await api.fetch('/sitemap.xml')).text();
    const advertised = [...index.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1] ?? '');

    expect(advertised.length).toBeGreaterThan(1);

    for (const url of advertised) {
      const response = await api.fetch(new URL(url).pathname);
      expect(response.status, url).toBe(200);
      expect(response.headers.get('content-type'), url).toContain('xml');
    }
  });

  it('lists every channel that has a page, not one browser page of them', async () => {
    // `sitemapPages` asked `listChannels` for 60 and got 60, because that
    // method clamps to `PAGINATION.maxLimit` — so on the real catalog 356 of
    // 416 channel pages were never advertised, and the sitemap looked perfectly
    // healthy while doing it. The fixture is small, so this asserts the
    // relationship rather than a number: every channel with videos appears.
    const body = await (await api.fetch('/sitemap-pages.xml')).text();

    const expected = db.queryRaw<{ slug: string }>(
      `SELECT slug FROM channels WHERE is_visible = 1 AND video_count > 0`,
    );
    expect(expected.length).toBeGreaterThan(0);
    for (const channel of expected) {
      expect(body, channel.slug).toContain(`/channel/${channel.slug}`);
    }
  });

  it('does not advertise a channel page that would be empty', async () => {
    // A sitemap full of empty pages is how a site teaches a crawler to trust
    // it less, so a channel with nothing published is left out.
    db.runRaw(
      `INSERT INTO channels (slug, name, is_visible, video_count) VALUES ('quiet', 'ערוץ ריק', 1, 0)`,
    );
    const body = await (await api.fetch('/sitemap-pages.xml')).text();

    expect(body).not.toContain('/channel/quiet');
  });

  it('advertises URLs on the configured origin', async () => {
    const other = createTestWorker(db, { APP_URL: 'https://example.test' });
    const index = await (await other.fetch('/sitemap.xml')).text();

    expect(index).toContain('https://example.test/sitemap-');
  });
});
