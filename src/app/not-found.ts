/**
 * `/404.html` — the page Cloudflare serves for a URL that matches nothing.
 *
 * ## Why this page exists
 *
 * `wrangler.jsonc` has said `"not_found_handling": "404-page"` since the
 * project started, and there was no 404 page. Workers Static Assets serves
 * `404.html` from the root of the assets directory when nothing matches; with
 * the file absent, a wrong URL got whatever the platform does with no page at
 * all. The configuration described a page that had never been built.
 *
 * The Worker relies on it too. `servePage` deliberately *stops* rewriting when
 * a video id is malformed — "a malformed video id should be a 404 page, not a
 * shell that then fails to load anything", says the comment — and then falls
 * through to the asset handler expecting that page to be there.
 *
 * ## What it does beyond apologising
 *
 * A dead end is the worst place to leave someone, and the site knows two things
 * that help: what they were looking for, and what it has. The path is turned
 * into a search — `/video/honda-civic-turbo` becomes a search for "honda civic
 * turbo" — and the results are shown right here. Most 404s on a catalog site
 * are a stale link or a typo in something that does exist, so this is usually
 * the video they wanted, one click away, instead of a link back to the home
 * page and a fresh start.
 *
 * The status code is not this file's business: the platform sends 404 with the
 * page, which is what a crawler needs. The page is `noindex` for the same
 * reason — one page standing in for thousands of wrong URLs must not be indexed
 * as thousands of real ones.
 */

import { PAGINATION } from '@shared/constants.js';
import { EMPTY_QUERY } from '@shared/core/query.js';
import { ROUTES, searchPath } from '@shared/core/paths.js';
import { startPage } from './bootstrap.js';
import { catalog } from '../data/catalog-repository.js';
import { videoGrid } from '../ui/components/video-card.js';
import { html, select, setHtml } from '../ui/dom.js';
import { icon } from '../ui/icons.js';

startPage({ active: null });

const body = select('[data-not-found-body]');

/** How many suggestions are worth showing. Enough to be useful, not a page. */
const SUGGESTIONS = 8;

/**
 * A search query guessed from the address.
 *
 * `/video/honda-civic-turbo` → `honda civic turbo`. Route prefixes are dropped
 * because they are ours, not words anyone searched for, and a YouTube id is
 * dropped because eleven random characters match nothing and would turn a
 * useful "here is what we have" into an empty state.
 */
function queryFromPath(pathname: string): string {
  const segments = decodeURIComponent(pathname)
    .split('/')
    .filter((segment) => segment.length > 0);

  const meaningful = segments.filter(
    (segment) =>
      !['video', 'channel', 'category', 'search', 'watch'].includes(segment) &&
      !/^[A-Za-z0-9_-]{11}$/.test(segment) &&
      !segment.endsWith('.html'),
  );

  return meaningful
    .join(' ')
    .replaceAll(/[-_+]+/g, ' ')
    .trim();
}

/** The links that are useful whatever went wrong. */
function ways(): ReturnType<typeof html> {
  return html`
    <div class="video-actions" style="margin-block-start: var(--space-5)">
      <a class="btn btn--primary" href="${ROUTES.home}"> ${icon('home', { size: 18 })} לדף הבית </a>
      <a class="btn btn--secondary" href="${ROUTES.search}">
        ${icon('search', { size: 18 })} חיפוש במאגר
      </a>
      <a class="btn btn--secondary" href="${ROUTES.channels}">
        ${icon('channel', { size: 18 })} רשימת הערוצים
      </a>
      <a class="btn btn--ghost" href="${ROUTES.contact}">
        ${icon('mail', { size: 18 })} דיווח על קישור שבור
      </a>
    </div>
  `;
}

async function render(): Promise<void> {
  const guess = queryFromPath(window.location.pathname);

  // The links go up first and stay up whatever the search does. A failed
  // request must not leave a 404 page with nothing on it at all.
  setHtml(body, ways());

  if (guess.length < 2) return;

  try {
    const page = await catalog.listVideos({
      ...EMPTY_QUERY,
      q: guess,
      limit: Math.min(SUGGESTIONS, PAGINATION.maxLimit),
    });
    if (page.items.length === 0) return;

    setHtml(
      body,
      html`
        ${ways()}
        <section class="section">
          <div class="section-heading">
            <div>
              <p class="eyebrow">אולי התכוונתם</p>
              <h2>תוצאות עבור "${guess}"</h2>
            </div>
            <a class="btn btn--ghost btn--sm" href="${searchPath(guess)}">
              ${icon('search', { size: 16 })} כל התוצאות
            </a>
          </div>
          ${videoGrid(page.items)}
        </section>
      `,
    );
  } catch {
    // A 404 page that shows an error about its own suggestions is worse than
    // a 404 page with none. The links above are already rendered.
  }
}

void render();
