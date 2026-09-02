/**
 * Search behaviour that is more than a database query.
 *
 * Two things happen here that do not belong in a repository:
 *   1. synonym expansion — a search for "מזגן" should also match "מיזוג";
 *   2. the anonymous log, which is what produces the "27 people searched for
 *      this and found nothing" report an editor uses to find missing content.
 *
 * Both are deliberately best-effort: if the synonym table cannot be read, the
 * search still runs unexpanded, and a failed log write never affects the
 * response.
 */

import { SEARCH } from '@shared/constants.js';
import type { Page } from '@shared/types/api.js';
import type { SearchSuggestion, VideoQuery, VideoSummary } from '@shared/types/catalog.js';
import type { Logger } from '../lib/logger.js';
import type { CatalogRepository } from '../repositories/catalog-repository.js';
import type { SearchRepository } from '../repositories/search-repository.js';
import type { VideoRepository } from '../repositories/video-repository.js';
import { buildMatchExpressionWithSynonyms } from '../repositories/search-expression.js';

export class SearchService {
  readonly #videos: VideoRepository;
  readonly #catalog: CatalogRepository;
  readonly #search: SearchRepository;
  readonly #logger: Logger;

  constructor(
    videos: VideoRepository,
    catalog: CatalogRepository,
    search: SearchRepository,
    logger: Logger,
  ) {
    this.#videos = videos;
    this.#catalog = catalog;
    this.#search = search;
    this.#logger = logger;
  }

  /**
   * Run a catalog query, widening the text part with synonyms.
   *
   * Returns the page plus the expression that was used, so the caller can log
   * it or show "showing results for …".
   */
  async search(query: VideoQuery): Promise<Page<VideoSummary>> {
    if (query.q.trim().length < SEARCH.minQueryLength) {
      return this.#videos.list(query);
    }

    const synonyms = await this.#loadSynonyms();
    const expression = buildMatchExpressionWithSynonyms(query.q, synonyms, {
      // A submitted search has a complete last word; prefix matching is for
      // the as-you-type suggestions endpoint.
      prefixLastToken: false,
    });

    return this.#videos.list(query, { matchExpression: expression });
  }

  /** Autocomplete rows for the search box. */
  suggest(query: string): Promise<SearchSuggestion[]> {
    return this.#search.suggest(query);
  }

  /**
   * Record what was searched for and how many results it produced.
   *
   * Call through `ctx.waitUntil` — it must never be awaited on the request
   * path, and a failure is logged rather than propagated.
   */
  async record(query: VideoQuery, resultCount: number): Promise<void> {
    try {
      await this.#search.logSearch(
        query.q,
        resultCount,
        query.category === 'all' ? null : query.category,
      );
    } catch (cause) {
      this.#logger.warn('Search log write failed', {
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  /** Synonyms, loaded at most once per request. */
  #synonyms: Promise<ReadonlyMap<string, readonly string[]>> | null = null;

  #loadSynonyms(): Promise<ReadonlyMap<string, readonly string[]>> {
    this.#synonyms ??= this.#catalog.loadSynonyms().catch((cause: unknown) => {
      this.#logger.warn('Synonym table unavailable; searching without expansion', {
        error: cause instanceof Error ? cause.message : String(cause),
      });
      return new Map<string, string[]>();
    });
    return this.#synonyms;
  }
}
