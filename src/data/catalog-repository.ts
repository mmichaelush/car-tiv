/**
 * The catalog, as the browser sees it.
 *
 * This is the abstraction the architecture notes ask for: pages and components
 * depend on `CatalogRepository`, never on an endpoint. Swapping the API for
 * static JSON snapshots (the "emergency static mode") or for IndexedDB means
 * writing another class with these methods — no page changes.
 */

import { serializeQuery } from '@shared/core/query.js';
import type { PagedResult } from './http-client.js';
import { httpClient, type HttpClient } from './http-client.js';
import type {
  CatalogStats,
  Category,
  Channel,
  HomeSection,
  SearchSuggestion,
  Tag,
  VideoDetail,
  VideoId,
  VideoQuery,
  VideoSummary,
} from '@shared/types/catalog.js';

/** Everything the home page renders, in one request. */
export interface HomePayload {
  readonly stats: CatalogStats;
  readonly categories: readonly Category[];
  readonly sections: readonly HomeSection[];
  readonly featuredChannels: readonly Channel[];
}

/** A channel page: the channel plus its newest videos. */
export interface ChannelPayload {
  readonly channel: Channel;
  readonly videos: readonly VideoSummary[];
}

/** The duplicate check behind the "suggest a video" form. */
export interface VideoExistence {
  readonly id: string;
  readonly exists: boolean;
  readonly published: boolean;
  readonly pending: boolean;
}

export class CatalogRepository {
  readonly #http: HttpClient;

  constructor(client: HttpClient = httpClient) {
    this.#http = client;
  }

  /**
   * A page of the catalog.
   *
   * The query is serialised by the same function that writes the address bar,
   * so what the visitor can share is exactly what the server receives.
   */
  listVideos(query: VideoQuery, signal?: AbortSignal): Promise<PagedResult<VideoSummary>> {
    const params = Object.fromEntries(serializeQuery(query));
    // `page` and `limit` are omitted from a shareable URL when they are the
    // default, but the API still needs them.
    params.page = String(query.page);
    params.limit = String(query.limit);
    return this.#http.getPage<VideoSummary>('/videos', { params, signal });
  }

  getVideo(id: VideoId | string, signal?: AbortSignal): Promise<VideoDetail> {
    return this.#http.get<VideoDetail>(`/videos/${encodeURIComponent(id)}`, { signal });
  }

  /**
   * One video plus everything its page shows around it, in a single request.
   *
   * The video page used to make three calls — the video, its related videos,
   * and the channel's other videos — which with the page's own HTML came to
   * four Worker requests. On a free plan capped at 100,000 requests a day, and
   * with none of the three reusable on the next video, that was the most
   * expensive page on the site. This makes it two.
   */
  getVideoPage(id: VideoId | string, signal?: AbortSignal): Promise<VideoDetail> {
    return this.#http.get<VideoDetail>(`/videos/${encodeURIComponent(id)}`, {
      params: { include: 'related,channel' },
      signal,
    });
  }

  getRelated(id: VideoId | string, signal?: AbortSignal): Promise<readonly VideoSummary[]> {
    return this.#http.get<VideoSummary[]>(`/videos/${encodeURIComponent(id)}/related`, { signal });
  }

  getVideosByIds(ids: readonly string[], signal?: AbortSignal): Promise<readonly VideoSummary[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return this.#http
      .getPage<VideoSummary>('/videos', { params: { ids: ids.join(',') }, signal })
      .then((page) => page.items);
  }

  videoExists(value: string, signal?: AbortSignal): Promise<VideoExistence> {
    return this.#http.get<VideoExistence>('/videos/exists', { params: { value }, signal });
  }

  listCategories(signal?: AbortSignal): Promise<readonly Category[]> {
    return this.#http.get<Category[]>('/categories', { signal });
  }

  /**
   * The channel directory.
   *
   * Only channels whose own YouTube page opens in NetFree, unless `all` is
   * passed — see `toChannel` in the Worker's catalog repository for what that
   * flag records and why the rest are omitted.
   */
  listChannels(
    options: { q?: string; all?: boolean; page?: number; limit?: number } = {},
    signal?: AbortSignal,
  ): Promise<PagedResult<Channel>> {
    return this.#http.getPage<Channel>('/channels', {
      params: {
        q: options.q,
        all: options.all === true ? '1' : undefined,
        page: options.page,
        limit: options.limit,
      },
      signal,
    });
  }

  getChannel(slug: string, signal?: AbortSignal): Promise<ChannelPayload> {
    return this.#http.get<ChannelPayload>(`/channels/${encodeURIComponent(slug)}`, { signal });
  }

  listPopularTags(category: string, signal?: AbortSignal): Promise<readonly Tag[]> {
    return this.#http.get<Tag[]>('/tags', { params: { category }, signal });
  }

  searchTags(q: string, category: string, signal?: AbortSignal): Promise<readonly Tag[]> {
    return this.#http.get<Tag[]>('/tags/search', { params: { q, category }, signal });
  }

  suggest(q: string, signal?: AbortSignal): Promise<readonly SearchSuggestion[]> {
    return this.#http.get<SearchSuggestion[]>('/search/suggestions', { params: { q }, signal });
  }

  getHome(signal?: AbortSignal): Promise<HomePayload> {
    return this.#http.get<HomePayload>('/home', { signal });
  }

  getStats(signal?: AbortSignal): Promise<CatalogStats> {
    return this.#http.get<CatalogStats>('/stats', { signal });
  }
}

/** The instance pages use. */
export const catalog = new CatalogRepository();
