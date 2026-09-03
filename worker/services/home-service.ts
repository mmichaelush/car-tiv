/**
 * Composing the home page.
 *
 * The home page is a list of rows read from `home_sections`, each with its own
 * filter. This service turns that configuration into real content in as few
 * queries as the configuration allows, and quietly drops a row it cannot fill
 * rather than failing the whole page.
 */

import { EMPTY_QUERY, isSortOption } from '@shared/core/query.js';
import { categoryPath } from '@shared/core/paths.js';
import type { CatalogStats, HomeSection, VideoQuery } from '@shared/types/catalog.js';
import type { HomeSectionRow } from '../repositories/catalog-repository.js';
import type { CatalogRepository } from '../repositories/catalog-repository.js';
import type { VideoRepository } from '../repositories/video-repository.js';
import type { Logger } from '../lib/logger.js';

/** Everything the home page needs, in one payload. */
export interface HomePayload {
  readonly stats: CatalogStats;
  readonly categories: Awaited<ReturnType<CatalogRepository['listCategories']>>;
  readonly sections: readonly HomeSection[];
  readonly featuredChannels: Awaited<ReturnType<CatalogRepository['listChannels']>>['items'];
}

export class HomeService {
  readonly #videos: VideoRepository;
  readonly #catalog: CatalogRepository;
  readonly #logger: Logger;

  constructor(videos: VideoRepository, catalog: CatalogRepository, logger: Logger) {
    this.#videos = videos;
    this.#catalog = catalog;
    this.#logger = logger;
  }

  /**
   * Build the home payload.
   *
   * @param includePersonal  Whether to include sections that need an account
   *                         ("continue watching", "for your car"). Those are
   *                         filled by the browser from its local library, so
   *                         the server returns them empty but present.
   */
  async build(includePersonal: boolean): Promise<HomePayload> {
    const [stats, categories, featured, configured] = await Promise.all([
      this.#catalog.stats(),
      this.#catalog.listCategories(),
      this.#catalog.listChannels({ featuredOnly: true, limit: 12 }),
      this.#catalog.listHomeSections(includePersonal),
    ]);

    const sections = await Promise.all(configured.map((row) => this.#fillSection(row)));

    return {
      stats,
      categories,
      featuredChannels: featured.items,
      // A row with no videos and no client-side source is not worth rendering.
      sections: sections.filter((section) => section != null),
    };
  }

  /** Fetch the videos for one configured row. */
  async #fillSection(row: HomeSectionRow): Promise<HomeSection | null> {
    const type = row.type as HomeSection['type'];

    // Personalised rows are populated in the browser from the local library;
    // the server only declares that they exist and in what order.
    if (type === 'continue-watching' || type === 'for-your-car') {
      return { id: row.id, title: row.title, type, href: row.linkHref, videos: [] };
    }

    const query = this.#queryFor(row);
    try {
      const page = await this.#videos.list(query);
      if (page.items.length === 0) return null;
      return {
        id: row.id,
        title: row.title,
        type,
        href: row.linkHref ?? defaultHref(row),
        videos: page.items,
      };
    } catch (cause) {
      // One bad section must not take the home page down with it.
      this.#logger.warn('Home section failed to load', {
        section: row.id,
        error: cause instanceof Error ? cause.message : String(cause),
      });
      return null;
    }
  }

  /** Translate a configured row into a catalog query. */
  #queryFor(row: HomeSectionRow): VideoQuery {
    const overrides = parseFilter(row.filterJson);
    const base: VideoQuery = { ...EMPTY_QUERY, ...overrides, page: 1, limit: row.itemLimit };

    // A sort written into the section's own `filter_json` wins.
    //
    // Every branch below used to end in `sort: 'date-desc'`, which quietly
    // discarded a sort an editor had configured — so a section could be set up
    // to show the archive and would show the newest videos instead, with no
    // error anywhere. The type decides the *filter*; the sort is a setting.
    const configured = overrides.sort;
    const sort = configured != null && isSortOption(configured) ? configured : 'date-desc';

    switch (row.type) {
      case 'featured':
        // Curated rows: only what an editor marked.
        return { ...base, featuredOnly: true, sort };
      case 'popular':
      case 'trending':
        // Kept, and honest about being unimplemented: nothing writes
        // `video_stats.view_count`, because a view counter is a D1 write on the
        // busiest route on the site and the free plan's write budget is the same
        // size as its request budget. A section of this type therefore behaves
        // as its configured sort, and no seeded section uses it — see
        // `migrations/0013`. The day there is a view count worth ordering by,
        // this is where it goes.
        return { ...base, sort };
      case 'recent':
      default:
        return { ...base, sort };
    }
  }
}

/** A section's own filter, stored as JSON by the admin. */
function parseFilter(json: string): Partial<VideoQuery> {
  try {
    const parsed = JSON.parse(json) as Partial<VideoQuery> | null;
    if (parsed == null || typeof parsed !== 'object') return {};
    return parsed;
  } catch {
    return {};
  }
}

/** "See all" target when the row does not define one. */
function defaultHref(row: HomeSectionRow): string | null {
  const filter = parseFilter(row.filterJson);
  return filter.category != null && filter.category !== 'all'
    ? categoryPath(filter.category)
    : null;
}
