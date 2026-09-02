/**
 * Page-number arithmetic, in one place so the client and the server can never
 * disagree about what page 3 contains.
 */

import { PAGINATION } from '../constants.js';
import type { PageMeta } from '../types/api.js';

/** Clamp an untrusted `page` value to a positive integer. */
export function clampPage(value: unknown): number {
  const page = Number(value);
  if (!Number.isFinite(page) || page < 1) return 1;
  return Math.min(Math.floor(page), 10_000);
}

/** Clamp an untrusted `limit` to the range the API is willing to serve. */
export function clampLimit(value: unknown, fallback: number = PAGINATION.defaultLimit): number {
  const limit = Number(value);
  if (!Number.isFinite(limit) || limit < 1) return fallback;
  return Math.min(Math.floor(limit), PAGINATION.maxLimit);
}

/** SQL `OFFSET` for a page. */
export function offsetFor(page: number, limit: number): number {
  return (clampPage(page) - 1) * clampLimit(limit);
}

/** Build the `meta` block that accompanies every list response. */
export function buildPageMeta(page: number, limit: number, total: number): PageMeta {
  const safeLimit = clampLimit(limit);
  const safePage = clampPage(page);
  return {
    page: safePage,
    limit: safeLimit,
    total,
    pages: total === 0 ? 0 : Math.ceil(total / safeLimit),
  };
}

/** `true` when another page exists after the current one. */
export function hasNextPage(meta: PageMeta): boolean {
  return meta.page < meta.pages;
}

/**
 * Page numbers to render in a pagination control, with `null` marking an
 * ellipsis. Always shows the first page, the last page and a window around
 * the current one.
 *
 * @example
 * paginationWindow(7, 20) // [1, null, 6, 7, 8, null, 20]
 */
export function paginationWindow(
  current: number,
  totalPages: number,
  radius = 1,
): (number | null)[] {
  if (totalPages <= 1) return totalPages === 1 ? [1] : [];

  const pages = new Set<number>([1, totalPages]);
  for (let page = current - radius; page <= current + radius; page += 1) {
    if (page >= 1 && page <= totalPages) pages.add(page);
  }

  const sorted = [...pages].sort((a, b) => a - b);
  const result: (number | null)[] = [];
  let previous = 0;

  for (const page of sorted) {
    if (previous !== 0 && page - previous > 1) result.push(null);
    result.push(page);
    previous = page;
  }

  return result;
}
