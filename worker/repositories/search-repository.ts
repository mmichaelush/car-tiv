/**
 * Search suggestions and search analytics.
 *
 * The catalog search itself lives in `VideoRepository.list` — it is the same
 * query as any other listing, only with a `MATCH` join. This repository covers
 * what search *additionally* needs: the autocomplete rows under the box, and
 * the anonymous log that tells an editor which searches return nothing.
 */

import { SEARCH } from '@shared/constants.js';
import { categoryPath, channelPath, searchPath, videoPath } from '@shared/core/paths.js';
import { indexText } from '@shared/core/text.js';
import type { SearchSuggestion } from '@shared/types/catalog.js';
import { BaseRepository } from './base.js';
import { escapeLike } from './catalog-repository.js';
import { buildMatchExpression } from './search-expression.js';

interface SuggestionRow {
  label: string;
  hint: string | null;
  key: string;
}

export interface ZeroResultSearch {
  readonly query: string;
  readonly rawQuery: string;
  readonly hits: number;
  readonly lastSearchedAt: string;
}

export interface PopularSearch {
  readonly query: string;
  readonly hits: number;
  readonly averageResults: number;
}

export class SearchRepository extends BaseRepository {
  /**
   * Autocomplete rows.
   *
   * Mixes video titles with tags, channels and manufacturers so that typing
   * "יונדאי" offers the manufacturer filter, not only videos whose title
   * happens to contain the word. Ordered by kind, then by how much content sits
   * behind the suggestion.
   */
  async suggest(query: string, limit: number = SEARCH.maxSuggestions): Promise<SearchSuggestion[]> {
    const trimmed = query.trim();
    if (trimmed.length < SEARCH.minQueryLength) return [];

    const pattern = `%${escapeLike(trimmed)}%`;
    const expression = buildMatchExpression(trimmed);
    const suggestions: SearchSuggestion[] = [];

    // 1. Manufacturers and models — the highest-intent match.
    const vehicles = await this.all<SuggestionRow>(
      `SELECT mk.name AS label, 'יצרן' AS hint, mk.slug AS key
       FROM manufacturers mk
       WHERE mk.is_visible = 1
         AND (mk.name LIKE ? ESCAPE ${String.raw`'\'`} OR mk.name_he LIKE ? ESCAPE ${String.raw`'\'`})
       ORDER BY length(mk.name)
       LIMIT 3`,
      [pattern, pattern],
    );
    for (const row of vehicles) {
      suggestions.push({
        type: 'manufacturer',
        label: row.label,
        hint: 'יצרן',
        href: `${searchPath('')}?manufacturer=${encodeURIComponent(row.key)}`,
      });
    }

    // 2. Tags, ordered by how many videos carry them.
    // Reads the maintained `tags.video_count` instead of joining `video_tags`
    // to `videos` and counting. That column exists precisely so this does not
    // have to be recomputed — and this runs on every keystroke that gets past
    // the debounce and misses the cache, which makes it the worst place in the
    // product to be counting anything.
    const tags = await this.all<SuggestionRow>(
      `SELECT t.name AS label, t.video_count || ' סרטונים' AS hint, t.slug AS key
       FROM tags t
       WHERE t.is_visible = 1 AND t.video_count > 0
         AND t.name LIKE ? ESCAPE ${String.raw`'\'`}
       ORDER BY t.video_count DESC
       LIMIT 3`,
      [pattern],
    );
    for (const row of tags) {
      suggestions.push({
        type: 'tag',
        label: row.label,
        hint: row.hint ?? undefined,
        href: `${searchPath('')}?tags=${encodeURIComponent(row.key)}`,
      });
    }

    // 3. Channels.
    const channels = await this.all<SuggestionRow>(
      `SELECT ch.name AS label, 'ערוץ' AS hint, ch.slug AS key
       FROM channels ch
       WHERE ch.is_visible = 1 AND ch.name LIKE ? ESCAPE ${String.raw`'\'`}
       ORDER BY ch.is_featured DESC, ch.name
       LIMIT 2`,
      [pattern],
    );
    for (const row of channels) {
      suggestions.push({
        type: 'channel',
        label: row.label,
        hint: 'ערוץ',
        href: channelPath(row.key),
      });
    }

    // 4. Categories.
    const categories = await this.all<SuggestionRow>(
      `SELECT c.name AS label, 'קטגוריה' AS hint, c.id AS key
       FROM categories c
       WHERE c.is_visible = 1 AND c.name LIKE ? ESCAPE ${String.raw`'\'`}
       ORDER BY c.sort_order
       LIMIT 2`,
      [pattern],
    );
    for (const row of categories) {
      suggestions.push({
        type: 'category',
        label: row.label,
        hint: 'קטגוריה',
        href: categoryPath(row.key),
      });
    }

    // 5. Fill the rest with actual videos.
    if (expression != null && suggestions.length < limit) {
      const videos = await this.all<SuggestionRow>(
        `SELECT v.title AS label, ch.name AS hint, v.id AS key
         FROM videos_fts fts
         JOIN videos v ON v.id = fts.video_id AND v.status = 'published' AND v.deleted_at IS NULL
         LEFT JOIN channels ch ON ch.id = v.channel_id
         WHERE videos_fts MATCH ?
         ORDER BY bm25(videos_fts, 0.0, 10.0, 8.0, 8.0, 4.0, 2.0, 1.0)
         LIMIT ?`,
        [expression, limit],
      );
      for (const row of videos) {
        suggestions.push({
          type: 'video',
          label: row.label,
          hint: row.hint ?? undefined,
          href: videoPath(row.key),
        });
      }
    }

    return suggestions.slice(0, limit);
  }

  /**
   * Record a search, anonymously.
   *
   * Called with `waitUntil` so it never delays the response. The normalised
   * form is stored alongside the raw text so spelling variants aggregate
   * together while an editor can still read what was actually typed.
   */
  async logSearch(rawQuery: string, resultCount: number, category: string | null): Promise<void> {
    const trimmed = rawQuery.trim();
    if (trimmed.length < SEARCH.minQueryLength) return;

    // A counter per (day, normalised query), not a row per search.
    //
    // `/api/videos?q=` is public and unauthenticated, and every distinct query
    // misses the edge cache and reaches this code. One row per search meant
    // anyone could walk `?q=a00001`, `?q=a00002`, … and mint a D1 **write** per
    // request — the free plan's whole 100,000-a-day write budget, spendable in
    // minutes by something indistinguishable from ordinary search traffic.
    //
    // As a counter, a repeat of a query that has already been seen today is an
    // UPDATE of a row that exists rather than another INSERT, and the table is
    // bounded by distinct searches per day instead of by total traffic.
    await this.run(
      `INSERT INTO search_query_daily
         (day, query, raw_query, hits, result_count, zero_hits, category_id, updated_at)
       VALUES (date('now'), ?, ?, 1, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT (day, query) DO UPDATE SET
         hits         = hits + 1,
         result_count = excluded.result_count,
         zero_hits    = zero_hits + excluded.zero_hits,
         updated_at   = CURRENT_TIMESTAMP`,
      [
        indexText(trimmed),
        trimmed.slice(0, SEARCH.maxQueryLength),
        resultCount,
        resultCount === 0 ? 1 : 0,
        category,
      ],
    );
  }

  /**
   * Searches that returned nothing — the "what content is missing" report.
   *
   * Reads the daily rollup, so this is a few hundred rows rather than a
   * `GROUP BY` over every search ever made.
   */
  async zeroResultSearches(sinceIso: string, limit = 50): Promise<ZeroResultSearch[]> {
    return this.all<ZeroResultSearch>(
      `SELECT query,
              MAX(raw_query) AS rawQuery,
              SUM(zero_hits) AS hits,
              MAX(day) AS lastSearchedAt
       FROM search_query_daily
       WHERE zero_hits > 0 AND day >= ?
       GROUP BY query
       ORDER BY hits DESC, lastSearchedAt DESC
       LIMIT ?`,
      [sinceIso.slice(0, 10), limit],
    );
  }

  /** The most frequent searches, for the admin dashboard. */
  async popularSearches(sinceIso: string, limit = 25): Promise<PopularSearch[]> {
    return this.all<PopularSearch>(
      `SELECT query, SUM(hits) AS hits,
              CAST(AVG(result_count) AS INTEGER) AS averageResults
       FROM search_query_daily
       WHERE day >= ?
       GROUP BY query
       ORDER BY hits DESC
       LIMIT ?`,
      [sinceIso.slice(0, 10), limit],
    );
  }
}
