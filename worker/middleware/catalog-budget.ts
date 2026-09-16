import { SEARCH, TAGS, ERROR_CODES } from '@shared/constants.js';
import { parseQuery } from '@shared/core/query.js';
import { fail } from '../lib/response.js';

const windows = new Map<string, { until: number; used: number }>();

/** No D1 writes for read throttling. This is a per-isolate guard, not a global quota. */
export function consumeCatalogBudget(key: string, now = Date.now()): boolean {
  let window = windows.get(key);
  if (window == null || window.until <= now) {
    if (windows.size >= 4096) {
      for (const [id, value] of windows) if (value.until <= now) windows.delete(id);
      if (windows.size >= 4096) return false;
    }
    window = { until: now + 60_000, used: 0 };
    windows.set(key, window);
  }
  if (window.used >= 60) return false;
  window.used += 1;
  return true;
}

export function expensiveCatalogPath(path: string): boolean {
  return (
    path === '/api/videos' ||
    path === '/api/search/suggestions' ||
    path === '/api/tags/search' ||
    path === '/api/channels' ||
    /^\/api\/videos\/[^/]+(?:\/related)?$/.test(path)
  );
}

/** Validate before looking in the cache so normalization cannot mask invalid input. */
export function invalidCatalogQuery(url: URL): Response | null {
  if (!url.pathname.startsWith('/api/')) return null;
  if (!expensiveCatalogPath(url.pathname)) return null;
  const params = url.searchParams;
  const query = parseQuery(params);
  const tags = (params.get('tags') ?? '').split(',').filter(Boolean);
  const invalid =
    [...params.values()].some((value) => value.length > 2048) ||
    (params.get('q')?.length ?? 0) > SEARCH.maxQueryLength ||
    tags.length > TAGS.maxSelected ||
    (query.page - 1) * query.limit > 20_000 ||
    (query.minDurationSeconds != null &&
      query.maxDurationSeconds != null &&
      query.minDurationSeconds > query.maxDurationSeconds);
  return invalid
    ? fail(400, ERROR_CODES.badRequest, 'שאילתת החיפוש ארוכה מדי או מכילה מסננים סותרים')
    : null;
}
