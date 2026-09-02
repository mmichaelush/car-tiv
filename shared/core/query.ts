/**
 * Conversion between a `VideoQuery` and a URL query string.
 *
 * This module is the reason a filtered view is shareable: the browser writes
 * its state into the address bar with `serializeQuery`, and both the next page
 * load and the Worker read it back with `parseQuery`. One parser, one
 * serialiser, no drift.
 *
 * Defaults are never written to the URL, so `/search?q=corolla` stays short and
 * `/` never grows a query string just because the page loaded.
 */

import { DEFAULT_SORT, PAGINATION, SEARCH, SORT_OPTIONS, type SortOption } from '../constants.js';
import type { VideoQuery } from '../types/catalog.js';
import { clampLimit, clampPage } from './pagination.js';

/** The query a page starts from before any filter is applied. */
export const EMPTY_QUERY: VideoQuery = {
  q: '',
  category: 'all',
  channel: null,
  tags: [],
  manufacturer: null,
  model: null,
  year: null,
  hebrewOnly: false,
  featuredOnly: false,
  minDurationSeconds: null,
  maxDurationSeconds: null,
  sort: DEFAULT_SORT,
  page: 1,
  limit: PAGINATION.defaultLimit,
};

/**
 * Read a `VideoQuery` out of URL parameters, clamping every value.
 * Unknown parameters are ignored; malformed ones fall back to the default
 * rather than producing an error, because a hand-edited URL must never 500.
 */
export function parseQuery(params: URLSearchParams, base: Partial<VideoQuery> = {}): VideoQuery {
  const text = (key: string): string | null => {
    const value = params.get(key)?.trim();
    return value != null && value.length > 0 ? value : null;
  };

  const number = (key: string): number | null => {
    const value = text(key);
    if (value == null) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };

  const sortParam = text('sort');
  const sort: SortOption = isSortOption(sortParam) ? sortParam : (base.sort ?? DEFAULT_SORT);

  return {
    q: (text('q') ?? base.q ?? '').slice(0, SEARCH.maxQueryLength),
    category: text('category') ?? base.category ?? 'all',
    channel: text('channel') ?? base.channel ?? null,
    tags: parseList(params, 'tags', base.tags ?? []),
    manufacturer: text('manufacturer') ?? base.manufacturer ?? null,
    model: text('model') ?? base.model ?? null,
    year: number('year') ?? base.year ?? null,
    hebrewOnly: parseBoolean(text('hebrew')) ?? base.hebrewOnly ?? false,
    featuredOnly: parseBoolean(text('featured')) ?? base.featuredOnly ?? false,
    minDurationSeconds: number('minDuration') ?? base.minDurationSeconds ?? null,
    maxDurationSeconds: number('maxDuration') ?? base.maxDurationSeconds ?? null,
    sort,
    page: clampPage(text('page') ?? base.page ?? 1),
    limit: clampLimit(text('limit') ?? base.limit ?? PAGINATION.defaultLimit),
  };
}

/**
 * Write a query back to URL parameters, omitting anything that equals the
 * default. The result is stable: the same query always produces the same
 * string, so `history.replaceState` does not churn.
 */
export function serializeQuery(query: VideoQuery): URLSearchParams {
  const params = new URLSearchParams();

  if (query.q.length > 0) params.set('q', query.q);
  if (query.category !== 'all') params.set('category', query.category);
  if (query.channel != null) params.set('channel', query.channel);
  if (query.tags.length > 0) params.set('tags', [...query.tags].join(','));
  if (query.manufacturer != null) params.set('manufacturer', query.manufacturer);
  if (query.model != null) params.set('model', query.model);
  if (query.year != null) params.set('year', String(query.year));
  if (query.hebrewOnly) params.set('hebrew', '1');
  if (query.featuredOnly) params.set('featured', '1');
  if (query.minDurationSeconds != null) params.set('minDuration', String(query.minDurationSeconds));
  if (query.maxDurationSeconds != null) params.set('maxDuration', String(query.maxDurationSeconds));
  if (query.sort !== DEFAULT_SORT) params.set('sort', query.sort);
  if (query.page > 1) params.set('page', String(query.page));
  if (query.limit !== PAGINATION.defaultLimit) params.set('limit', String(query.limit));

  return params;
}

/**
 * Number of active filters, for the "סינון (3)" badge.
 * The free-text query and the page number are navigation, not filters, so they
 * do not count.
 */
export function countActiveFilters(query: VideoQuery): number {
  let count = 0;
  if (query.category !== 'all') count += 1;
  if (query.channel != null) count += 1;
  count += query.tags.length;
  if (query.manufacturer != null) count += 1;
  if (query.model != null) count += 1;
  if (query.year != null) count += 1;
  if (query.hebrewOnly) count += 1;
  if (query.featuredOnly) count += 1;
  if (query.minDurationSeconds != null || query.maxDurationSeconds != null) count += 1;
  if (query.sort !== DEFAULT_SORT) count += 1;
  return count;
}

/** `true` when nothing but the defaults is set. */
export function isEmptyQuery(query: VideoQuery): boolean {
  return query.q.length === 0 && countActiveFilters(query) === 0;
}

function parseList(params: URLSearchParams, key: string, fallback: readonly string[]): string[] {
  const raw = params.get(key);
  if (raw == null) return [...fallback];
  return [
    ...new Set(
      raw
        .split(',')
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    ),
  ];
}

function parseBoolean(value: string | null): boolean | null {
  if (value == null) return null;
  return value === '1' || value === 'true' || value === 'yes';
}

function isSortOption(value: string | null): value is SortOption {
  return value != null && (SORT_OPTIONS as readonly string[]).includes(value);
}
