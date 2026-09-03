/**
 * Pagination and "load more".
 *
 * The old site kept every video in memory and sliced the array; this asks the
 * server for a page. Two presentations over the same data, chosen by the
 * visitor's `infiniteScroll` preference:
 *
 *   * numbered pages — shareable, and a way to jump;
 *   * a "load more" button, optionally auto-triggered when it scrolls into view.
 */

import { hasNextPage, paginationWindow } from '@shared/core/pagination.js';
import type { PageMeta } from '@shared/types/api.js';
import { countLabel, html, type SafeHtml } from '../dom.js';
import { icon } from '../icons.js';

/** Numbered page controls. Buttons carry `data-page` for delegated handling. */
export function pagination(meta: PageMeta): SafeHtml {
  if (meta.pages <= 1) return html``;

  const pages = paginationWindow(meta.page, meta.pages);

  return html`
    <nav class="pagination" aria-label="ניווט בין עמודים">
      <button
        type="button"
        data-page="${meta.page - 1}"
        ${meta.page <= 1 ? 'disabled' : ''}
        aria-label="העמוד הקודם"
      >
        ${icon('chevronEnd', { size: 18 })}
      </button>

      ${pages.map((page) =>
        page == null
          ? html`<span aria-hidden="true">…</span>`
          : html`<button
              type="button"
              data-page="${page}"
              ${page === meta.page ? 'aria-current="page"' : ''}
              aria-label="עמוד ${page}"
            >
              ${page}
            </button>`,
      )}

      <button
        type="button"
        data-page="${meta.page + 1}"
        ${hasNextPage(meta) ? '' : 'disabled'}
        aria-label="העמוד הבא"
      >
        ${icon('chevronStart', { size: 18 })}
      </button>
    </nav>
  `;
}

/** The "show more" button, with a count of what is left. */
export function loadMore(meta: PageMeta): SafeHtml {
  if (!hasNextPage(meta)) return html``;
  const remaining = meta.total - meta.page * meta.limit;

  return html`
    <div class="load-more">
      <button class="btn btn--secondary" type="button" data-load-more>הצגת סרטונים נוספים</button>
      <p class="muted">נותרו ${countLabel(Math.max(0, remaining), 'סרטון', 'סרטונים')}</p>
    </div>
  `;
}

/**
 * Load the next page automatically when a sentinel scrolls into view.
 *
 * @param sentinel  An element rendered after the grid.
 * @param onReach   Called once per intersection; the caller guards re-entry.
 * @returns A function that stops observing.
 */
export function observeInfiniteScroll(sentinel: Element, onReach: () => void): () => void {
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) onReach();
      }
    },
    // Start loading a screenful early, so the grid rarely shows a gap.
    { rootMargin: '600px 0px' },
  );

  observer.observe(sentinel);
  return () => {
    observer.disconnect();
  };
}
