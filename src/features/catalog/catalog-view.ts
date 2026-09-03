/**
 * The browse experience: filters, results, paging and URL state.
 *
 * One controller serves the home page, a category page, a channel page and the
 * search page — they differ only in the query they start from and in what they
 * are allowed to change. That is the difference between this and the old
 * `applyFilters` / `updateFiltersAndURL` / `getFilteredAndSortedVideos` trio,
 * which existed once and was reachable only from the home page.
 *
 * Invariants:
 *   * the URL always reflects the current query, so any view is shareable;
 *   * only one request is ever in flight — a superseded one is aborted;
 *   * every state has a rendering: loading, empty, error and results.
 */

import { SORT_OPTIONS } from '@shared/constants.js';
import { countActiveFilters, parseQuery, serializeQuery } from '@shared/core/query.js';
import { DURATION_BUCKETS, type DurationBucket } from '@shared/core/duration.js';
import type { PageMeta } from '@shared/types/api.js';
import type { Category, Tag, VideoQuery, VideoSummary } from '@shared/types/catalog.js';
import { catalog } from '../../data/catalog-repository.js';
import { ApiError } from '../../data/http-client.js';
import { readPreferences } from '../preferences/preferences.js';
import { mountCardActions, readCardState } from '../library/card-actions.js';
import { library } from '../../data/library-repository.js';
import {
  appendHtml,
  byData,
  countLabel,
  debounce,
  delegate,
  formatCount,
  html,
  on,
  select,
  selectAll,
  setHtml,
  toggleClass,
  type SafeHtml,
} from '../../ui/dom.js';
import { icon } from '../../ui/icons.js';
import { emptyState, errorState, skeletonGrid, videoGrid } from '../../ui/components/video-card.js';
import { loadMore, observeInfiniteScroll, pagination } from '../../ui/components/pagination.js';

/** Human labels for the sort options, in the order they are offered. */
const SORT_LABELS: Readonly<Record<(typeof SORT_OPTIONS)[number], string>> = {
  'date-desc': 'החדשים ביותר',
  'date-asc': 'הוותיקים ביותר',
  'duration-asc': 'מהקצר לארוך',
  'duration-desc': 'מהארוך לקצר',
  'title-asc': 'כותרת (א־ת)',
  'title-desc': 'כותרת (ת־א)',
  relevance: 'הכי רלוונטי',
};

export interface CatalogViewOptions {
  /** The section element containing the toolbar, grid and pagination hooks. */
  readonly root: HTMLElement;
  /**
   * Query values this view forces and the visitor cannot change — a category
   * page pins `category`, a channel page pins `channel`.
   */
  readonly fixed?: Partial<VideoQuery>;
  /** Show the category chip row. Off on a category page, where it is noise. */
  readonly showCategories?: boolean;
  /** Write the query into the address bar. Off for a widget inside a page. */
  readonly syncUrl?: boolean;
  /** Called after every successful load, e.g. to update a result heading. */
  readonly onLoaded?: (meta: PageMeta, query: VideoQuery) => void;
}

export interface CatalogViewHandle {
  /** Merge changes into the query and reload from page 1. */
  update(changes: Partial<VideoQuery>): void;
  /** The query currently displayed. */
  current(): VideoQuery;
  destroy(): void;
}

export function mountCatalogView(options: CatalogViewOptions): CatalogViewHandle {
  const { root } = options;
  const preferences = readPreferences();

  let query: VideoQuery = {
    ...parseQuery(new URL(window.location.href).searchParams, {
      hebrewOnly: preferences.hebrewOnly,
      sort: preferences.defaultSort as VideoQuery['sort'],
      limit: preferences.resultsPerPage,
    }),
    ...options.fixed,
  };

  let videos: VideoSummary[] = [];
  let meta: PageMeta = { page: 1, limit: query.limit, total: 0, pages: 0 };
  let categories: readonly Category[] = [];
  let popularTags: readonly Tag[] = [];
  let controller: AbortController | null = null;
  let loading = false;

  const cleanups: (() => void)[] = [];

  // --- Elements the page template must provide ----------------------------
  // `select` throws with the selector in the message, so a renamed hook fails
  // loudly at boot instead of producing a page where nothing happens.
  const grid = select('[data-video-grid]', root);
  const pager = select('[data-pager]', root);

  // These are optional: a page may omit the toolbar entirely.
  const resultSummary = byData('result-summary', root);
  const filtersPanel = byData('filters', root);
  const filterCount = byData('filter-count', root);
  const categoryRow = byData('categories', root);

  grid.dataset.view = preferences.viewMode;

  // ------------------------------------------------------------- Rendering

  const renderResults = (append: boolean): void => {
    void readCardState().then((state) => {
      const markup = videoGrid(videos, state);
      if (append) appendHtml(grid, videoGrid(videos.slice(-meta.limit), state));
      else setHtml(grid, markup);
    });
  };

  const renderPager = (): void => {
    if (meta.pages <= 1) {
      setHtml(pager, html``);
      return;
    }
    setHtml(pager, preferences.infiniteScroll ? loadMore(meta) : pagination(meta));

    if (preferences.infiniteScroll) {
      const sentinel = byData('load-more', pager) ?? pager;
      cleanups.push(
        observeInfiniteScroll(sentinel, () => {
          if (!loading && meta.page < meta.pages) void load({ page: meta.page + 1, append: true });
        }),
      );
    }
  };

  const renderSummary = (): void => {
    if (resultSummary == null) return;
    const text =
      meta.total === 0
        ? 'לא נמצאו סרטונים'
        : `${countLabel(meta.total, 'סרטון', 'סרטונים')}${query.q.length > 0 ? ` עבור "${query.q}"` : ''}`;
    setHtml(resultSummary, html`${text}`);
  };

  /**
   * Show the visitor's saved searches, if they have any.
   *
   * Rendered from the local library, so it is instant and works signed out;
   * when signed in the same list has already been pulled from the account.
   */
  const renderSavedSearches = async (): Promise<void> => {
    const container = filtersPanel?.querySelector<HTMLElement>('[data-saved-searches]');
    if (container == null) return;

    const searches = await library.savedSearches();
    if (searches.length === 0) {
      container.hidden = true;
      setHtml(container, html``);
      return;
    }

    container.hidden = false;
    setHtml(
      container,
      html`
        <h3>החיפושים השמורים שלי</h3>
        <div class="saved-searches__list">
          ${searches.map(
            (saved) => html`
              <span class="chip chip--saved">
                <button type="button" data-saved-search="${saved.query}">${saved.name}</button>
                <button
                  type="button"
                  class="chip__remove"
                  data-delete-search="${saved.id}"
                  aria-label="מחיקת החיפוש ${saved.name}"
                >
                  ${icon('close', { size: 14 })}
                </button>
              </span>
            `,
          )}
        </div>
      `,
    );
  };

  /**
   * Save the current filters under a name the visitor chooses.
   *
   * The default name is what they searched for, because that is what they
   * would have typed anyway — and an empty answer cancels rather than saving
   * something called "".
   */
  const saveCurrentSearch = async (): Promise<void> => {
    const { promptDialog } = await import('../../ui/components/dialog.js');
    const suggested = query.q.trim().length > 0 ? query.q.trim() : 'החיפוש שלי';

    const name = await promptDialog({
      title: 'שמירת החיפוש',
      label: 'איך לקרוא לו?',
      value: suggested,
      confirmLabel: 'שמירה',
    });
    if (name == null || name.trim().length === 0) return;

    await library.saveSearch(name, serializeQuery(query).toString());
    await renderSavedSearches();

    const { toastSuccess } = await import('../../ui/components/toast.js');
    toastSuccess('החיפוש נשמר');
  };

  const renderFilterCount = (): void => {
    if (filterCount == null) return;
    const count = countActiveFilters(query) - countFixed();
    setHtml(
      filterCount,
      count > 0 ? html`<span class="badge badge--brand">${count}</span>` : html``,
    );
  };

  const renderCategories = (): void => {
    if (categoryRow == null || options.showCategories === false) return;
    setHtml(
      categoryRow,
      html`
        <button
          type="button"
          class="chip"
          data-category="all"
          aria-pressed="${query.category === 'all' ? 'true' : 'false'}"
        >
          הכל
        </button>
        ${categories.map(
          (category) => html`
            <button
              type="button"
              class="chip"
              data-category="${category.id}"
              aria-pressed="${query.category === category.id ? 'true' : 'false'}"
            >
              ${category.name}
              ${
                category.videoCount == null
                  ? ''
                  : html`<span class="chip__count">${formatCount(category.videoCount)}</span>`
              }
            </button>
          `,
        )}
      `,
    );
  };

  const renderFilters = (): void => {
    if (filtersPanel == null) return;

    setHtml(
      filtersPanel,
      html`
        <div class="filters__row">
          <div class="field">
            <label for="filter-sort">מיון</label>
            <select class="select" id="filter-sort" data-filter="sort">
              ${SORT_OPTIONS.map(
                (value) => html`
                  <option value="${value}" ${value === query.sort ? 'selected' : ''}>
                    ${SORT_LABELS[value]}
                  </option>
                `,
              )}
            </select>
          </div>

          <div class="field">
            <label for="filter-duration">אורך</label>
            <select class="select" id="filter-duration" data-filter="duration">
              <option value="">כל אורך</option>
              ${Object.entries(DURATION_BUCKETS).map(
                ([key, bucket]) => html`
                  <option
                    value="${key}"
                    ${matchesBucket(query, key as DurationBucket) ? 'selected' : ''}
                  >
                    ${bucket.label}
                  </option>
                `,
              )}
            </select>
          </div>

          <label class="check">
            <input type="checkbox" data-filter="hebrew" ${query.hebrewOnly ? 'checked' : ''} />
            עברית בלבד
          </label>

          <div class="filters__actions">
            <button type="button" class="btn btn--ghost" data-action="save-search">
              ${icon('bookmark', { size: 16 })} שמירת החיפוש
            </button>
            <button type="button" class="btn btn--ghost" data-action="share-filters">
              ${icon('link', { size: 16 })} שיתוף הסינון
            </button>
            <button type="button" class="btn btn--secondary" data-action="clear-filters">
              ניקוי
            </button>
          </div>

          <!-- Filled in from the library; hidden entirely when empty. -->
          <div class="saved-searches" data-saved-searches hidden></div>
        </div>

        <div class="filters__group">
          <h3>סינון לפי תגיות</h3>
          <div class="selected-tags" data-selected-tags></div>
          <div class="field" style="max-width:22rem;margin-block:var(--space-3)">
            <label class="sr-only" for="tag-search">חיפוש תגית</label>
            <input
              class="input"
              id="tag-search"
              type="search"
              placeholder="חיפוש תגית…"
              data-tag-search
            />
          </div>
          <div class="tag-cloud" data-tag-cloud></div>
        </div>
      `,
    );

    renderTags();
    void renderSavedSearches();
  };

  const renderTags = (): void => {
    const cloud = byData('tag-cloud', root);
    const selected = byData('selected-tags', root);

    if (selected != null) {
      setHtml(
        selected,
        html`${query.tags.map(
          (tag) => html`
            <button type="button" class="chip chip--removable is-active" data-remove-tag="${tag}">
              ${tag}
            </button>
          `,
        )}`,
      );
    }

    if (cloud != null) {
      setHtml(
        cloud,
        html`${popularTags
          .filter((tag) => !query.tags.includes(tag.slug))
          .map(
            (tag) => html`
              <button type="button" class="chip" data-add-tag="${tag.slug}">
                ${tag.name}
                ${tag.videoCount == null ? '' : html`<span class="chip__count">${tag.videoCount}</span>`}
              </button>
            `,
          )}`,
      );
    }
  };

  // ------------------------------------------------------------- Data flow

  const syncUrl = (): void => {
    if (options.syncUrl === false) return;
    const params = serializeQuery(query);
    // Values pinned by the page belong to the path, not the query string.
    for (const key of Object.keys(options.fixed ?? {})) params.delete(key);
    const search = params.toString();
    const url = `${window.location.pathname}${search.length > 0 ? `?${search}` : ''}`;
    window.history.replaceState(null, '', url);
  };

  async function load({
    page = 1,
    append = false,
  }: { page?: number; append?: boolean } = {}): Promise<void> {
    controller?.abort();
    controller = new AbortController();
    loading = true;

    query = { ...query, page };
    syncUrl();
    renderFilterCount();

    if (!append) setHtml(grid, skeletonGrid(Math.min(query.limit, 8)));

    try {
      const result = await catalog.listVideos(query, controller.signal);
      videos = append ? [...videos, ...result.items] : [...result.items];
      meta = result.meta;

      if (videos.length === 0) {
        setHtml(
          grid,
          emptyState({
            title: 'לא נמצאו סרטונים',
            description: 'נסה לשנות את הסינון או לחפש משהו אחר.',
            actionLabel: 'נקה את כל הסינונים',
            actionName: 'clear-filters',
          }),
        );
        setHtml(pager, html``);
      } else {
        renderResults(append);
        renderPager();
      }

      renderSummary();
      renderCategories();
      options.onLoaded?.(meta, query);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      const message = error instanceof ApiError ? error.message : 'לא הצלחנו לטעון את הסרטונים';
      setHtml(grid, errorState(message));
      setHtml(pager, html``);
    } finally {
      loading = false;
    }
  }

  const applyChanges = (changes: Partial<VideoQuery>): void => {
    query = { ...query, ...changes, ...options.fixed };
    renderFilters();
    void load({ page: 1 });
  };

  // -------------------------------------------------------------- Wiring

  cleanups.push(
    mountCardActions({ container: grid, getVideo: (id) => videos.find((v) => v.id === id) }),
  );

  cleanups.push(
    delegate(grid, 'click', '[data-action="clear-filters"]', () => {
      applyChanges(clearedQuery());
    }),
  );

  if (categoryRow != null) {
    cleanups.push(
      delegate(categoryRow, 'click', '[data-category]', (_event, button) => {
        applyChanges({ category: button.dataset.category ?? 'all' });
      }),
    );
  }

  const filterToggle = byData('filter-toggle', root);
  if (filterToggle != null && filtersPanel != null) {
    cleanups.push(
      on(filterToggle, 'click', () => {
        const open = filtersPanel.hidden;
        filtersPanel.hidden = !open;
        filterToggle.setAttribute('aria-expanded', String(open));
      }),
    );
  }

  if (filtersPanel != null) {
    cleanups.push(
      delegate(filtersPanel, 'change', '[data-filter]', (_event, control) => {
        const kind = control.dataset.filter;

        if (kind === 'sort' && control instanceof HTMLSelectElement) {
          applyChanges({ sort: control.value as VideoQuery['sort'] });
        } else if (kind === 'hebrew' && control instanceof HTMLInputElement) {
          applyChanges({ hebrewOnly: control.checked });
        } else if (kind === 'duration' && control instanceof HTMLSelectElement) {
          const bucket = control.value as DurationBucket | '';
          applyChanges(
            bucket === ''
              ? { minDurationSeconds: null, maxDurationSeconds: null }
              : {
                  minDurationSeconds: DURATION_BUCKETS[bucket].min,
                  maxDurationSeconds: DURATION_BUCKETS[bucket].max,
                },
          );
        }
      }),
    );

    cleanups.push(
      delegate(filtersPanel, 'click', '[data-add-tag]', (_event, button) => {
        const tag = button.dataset.addTag;
        if (tag == null || query.tags.includes(tag)) return;
        applyChanges({ tags: [...query.tags, tag] });
      }),
    );

    cleanups.push(
      delegate(filtersPanel, 'click', '[data-remove-tag]', (_event, button) => {
        const tag = button.dataset.removeTag;
        applyChanges({ tags: query.tags.filter((item) => item !== tag) });
      }),
    );

    cleanups.push(
      delegate(filtersPanel, 'click', '[data-action="clear-filters"]', () => {
        applyChanges(clearedQuery());
      }),
    );

    cleanups.push(
      delegate(filtersPanel, 'click', '[data-action="save-search"]', () => {
        void saveCurrentSearch();
      }),
    );

    cleanups.push(
      delegate(filtersPanel, 'click', '[data-saved-search]', (_event, button) => {
        const saved = button.dataset.savedSearch;
        if (saved != null) applyChanges(parseQuery(new URLSearchParams(saved)));
      }),
    );

    cleanups.push(
      delegate(filtersPanel, 'click', '[data-delete-search]', (event, button) => {
        // The delete button sits inside the chip that runs the search.
        event.stopPropagation();
        const id = button.dataset.deleteSearch;
        if (id == null) return;
        void library.deleteSavedSearch(id).then(renderSavedSearches);
      }),
    );

    cleanups.push(
      delegate(filtersPanel, 'click', '[data-action="share-filters"]', () => {
        void import('../../ui/components/toast.js').then(({ shareUrl }) =>
          shareUrl(window.location.href, 'סינון סרטונים ב־CAR־טיב'),
        );
      }),
    );

    const searchTags = debounce((value: string) => {
      void catalog
        .searchTags(value, query.category)
        .then((rows) => {
          popularTags = rows;
          renderTags();
        })
        .catch(() => undefined);
    }, 250);

    cleanups.push(
      delegate(filtersPanel, 'input', '[data-tag-search]', (_event, input) => {
        if (!(input instanceof HTMLInputElement)) return;
        const value = input.value.trim();
        if (value.length === 0) void loadPopularTags();
        else searchTags(value);
      }),
    );
  }

  cleanups.push(
    delegate(pager, 'click', '[data-page]', (_event, button) => {
      const page = Number(button.dataset.page);
      if (!Number.isFinite(page) || page < 1) return;
      void load({ page }).then(() => {
        root.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }),
  );

  cleanups.push(
    delegate(pager, 'click', '[data-load-more]', () => {
      if (!loading) void load({ page: meta.page + 1, append: true });
    }),
  );

  // View mode switcher, when the page offers one.
  const viewSwitch = byData('view-switch', root);
  if (viewSwitch != null) {
    cleanups.push(
      delegate(viewSwitch, 'click', '[data-view]', (_event, button) => {
        const view = button.dataset.view;
        if (view == null) return;
        grid.dataset.view = view;
        for (const other of selectAll('[data-view]', viewSwitch)) {
          other.setAttribute('aria-pressed', String(other === button));
        }
        void import('../preferences/preferences.js').then(({ updatePreferences }) =>
          updatePreferences({ viewMode: view as 'grid' | 'list' }),
        );
      }),
    );
  }

  // ------------------------------------------------------------ Bootstrap

  async function loadPopularTags(): Promise<void> {
    try {
      popularTags = await catalog.listPopularTags(query.category);
      renderTags();
    } catch {
      popularTags = [];
    }
  }

  const bootstrap = async (): Promise<void> => {
    renderFilters();
    void load({ page: query.page });

    if (options.showCategories !== false) {
      try {
        categories = await catalog.listCategories();
        renderCategories();
      } catch {
        toggleClass(root, 'has-no-categories', true);
      }
    }

    await loadPopularTags();
  };

  void bootstrap();

  function clearedQuery(): Partial<VideoQuery> {
    return {
      q: '',
      category: 'all',
      tags: [],
      hebrewOnly: false,
      featuredOnly: false,
      manufacturer: null,
      model: null,
      year: null,
      minDurationSeconds: null,
      maxDurationSeconds: null,
      sort: 'date-desc',
      ...options.fixed,
    };
  }

  function countFixed(): number {
    return Object.keys(options.fixed ?? {}).filter((key) => key === 'category' || key === 'channel')
      .length;
  }

  return {
    update: applyChanges,
    current: () => query,
    destroy: () => {
      controller?.abort();
      for (const cleanup of cleanups) cleanup();
    },
  };
}

function matchesBucket(query: VideoQuery, bucket: DurationBucket): boolean {
  const { min, max } = DURATION_BUCKETS[bucket];
  return query.minDurationSeconds === min && query.maxDurationSeconds === max;
}

/** Re-export so pages can build their own toolbar without importing internals. */
export type { SafeHtml };
