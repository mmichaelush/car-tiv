/**
 * Reference data: categories, channels, tags and the counters shown in the hero.
 *
 * These endpoints are the most cacheable in the product — they change only when
 * an editor changes them — so they are deliberately simple queries with no
 * per-visitor variation.
 */

import { PAGINATION, TAGS } from '@shared/constants.js';
import { buildPageMeta, clampLimit, clampPage, offsetFor } from '@shared/core/pagination.js';
import type { Page } from '@shared/types/api.js';
import type { CatalogStats, Category, Channel, Tag } from '@shared/types/catalog.js';
import { BaseRepository, ConditionBuilder, likePattern, toBoolean } from './base.js';

interface CategoryRow {
  id: string;
  name: string;
  description: string;
  icon: string;
  colorFrom: string | null;
  colorTo: string | null;
  sortOrder: number;
  isVisible: number;
  videoCount: number;
}

interface ChannelRow {
  id: number;
  slug: string;
  name: string;
  description: string;
  imageUrl: string | null;
  youtubeUrl: string | null;
  youtubeChannelId: string | null;
  isFeatured: number;
  isVisible: number;
  videoCount: number;
}

interface TagRow {
  id: number;
  slug: string;
  name: string;
  videoCount: number;
}

/** A configured home-page row, before its videos are fetched. */
export interface HomeSectionRow {
  id: string;
  title: string;
  subtitle: string;
  type: string;
  /** Serialised `VideoQuery` fragment. */
  filterJson: string;
  itemLimit: number;
  linkHref: string | null;
  requiresAccount: number;
}

export class CatalogRepository extends BaseRepository {
  /**
   * Visible categories in display order, each with its live video count.
   *
   * `video_count` is a stored column maintained by `CountersRepository`, not a
   * subquery. It used to be one correlated `COUNT(*)` per category, which
   * together walked the whole catalog — about 7,900 rows read — on every call,
   * and this is the endpoint the home page, every category page and the
   * suggest form all ask for. Now it reads ten rows.
   */
  /**
   * The categories a visitor can browse.
   *
   * `withVideos` drops the empty ones, which is the default for every public
   * listing: a category chip reading "0" is a filter that leads to an empty
   * page, and the home grid was showing a card for one. It stays available
   * unfiltered for `findCategory`, so a direct link to a category that has
   * just been emptied still resolves rather than 404ing.
   */
  async listCategories(options: { withVideos?: boolean } = {}): Promise<Category[]> {
    const onlyWithVideos = options.withVideos !== false;
    const rows = await this.all<CategoryRow>(
      `SELECT c.id, c.name, c.description, c.icon,
              c.color_from AS colorFrom, c.color_to AS colorTo,
              c.sort_order AS sortOrder, c.is_visible AS isVisible,
              c.video_count AS videoCount
       FROM categories c
       WHERE c.is_visible = 1
       ORDER BY c.sort_order, c.name`,
    );

    const visible = onlyWithVideos ? rows.filter((row) => row.videoCount > 0) : rows;

    return visible.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      icon: row.icon,
      // Fall back to the brand purple so a category added without colours
      // still renders as a card rather than a transparent hole.
      colorFrom: row.colorFrom ?? '#7c3aed',
      colorTo: row.colorTo ?? '#4c1d95',
      sortOrder: row.sortOrder,
      isVisible: toBoolean(row.isVisible),
      videoCount: row.videoCount,
    }));
  }

  /** A single category, or `null` when it does not exist or is hidden. */
  async findCategory(id: string): Promise<Category | null> {
    // Unfiltered: a direct link to a category that has just been emptied should
    // load and say it is empty, not 404.
    const categories = await this.listCategories({ withVideos: false });
    return categories.find((category) => category.id === id) ?? null;
  }

  /**
   * A page of channels.
   * Featured channels come first, then the ones with the most videos, so the
   * first page is useful without any sorting UI.
   */
  async listChannels(options: {
    q?: string;
    featuredOnly?: boolean;
    page?: number;
    limit?: number;
  }): Promise<Page<Channel>> {
    const page = clampPage(options.page ?? 1);
    const limit = clampLimit(options.limit ?? PAGINATION.defaultLimit);

    const conditions = new ConditionBuilder().add('ch.is_visible = 1');
    conditions.addIf(options.featuredOnly === true, 'ch.is_featured = 1');
    conditions.addIf(
      options.q != null && options.q.length > 0,
      'ch.name LIKE ? ESCAPE ' + String.raw`'\'`,
      likePattern(options.q ?? ''),
    );

    const where = conditions.whereClause();
    const bindings = conditions.bindings();

    // `video_count` is the maintained column, and the ORDER BY below is exactly
    // `idx_channels_ranked`, so this walks the index to LIMIT rather than
    // counting 7,876 videos across 416 correlated subqueries and then sorting.
    const rows = await this.all<ChannelRow>(
      `SELECT ch.id, ch.slug, ch.name, ch.description,
              ch.image_url AS imageUrl, ch.youtube_url AS youtubeUrl,
              ch.youtube_channel_id AS youtubeChannelId,
              ch.is_featured AS isFeatured, ch.is_visible AS isVisible,
              ch.video_count AS videoCount
       FROM channels ch
       ${where}
       ORDER BY ch.is_featured DESC, ch.featured_order, ch.video_count DESC, ch.name
       LIMIT ? OFFSET ?`,
      [...bindings, limit, offsetFor(page, limit)],
    );

    const total = await this.count(`SELECT COUNT(*) AS value FROM channels ch ${where}`, bindings);

    return { items: rows.map(toChannel), meta: buildPageMeta(page, limit, total) };
  }

  /**
   * Every channel that has a page worth crawling — slug and video count only.
   *
   * Separate from `listChannels` because that method is paginated for a
   * *browser*: `clampLimit` caps it at `PAGINATION.maxLimit`, which is 60. The
   * sitemap asked it for 60 and got 60, so 356 of the site's 416 channel pages
   * were never advertised to a search engine — silently, because 60 rows is a
   * successful response.
   *
   * `featuredOnly` deliberately plays no part here. That flag records whether a
   * channel's *YouTube* page opens behind the NetFree filter, which is a fact
   * about YouTube; the channel page on this site works for every channel, and
   * is exactly the page a crawler should have.
   *
   * A channel with no published videos is excluded: its page is an empty state,
   * and a sitemap full of empty pages is how a site teaches a crawler to trust
   * it less.
   */
  async listChannelSlugs(limit = 5_000): Promise<{ slug: string; videoCount: number }[]> {
    return this.all<{ slug: string; videoCount: number }>(
      `SELECT slug, video_count AS videoCount
       FROM channels
       WHERE is_visible = 1 AND video_count > 0
       ORDER BY video_count DESC, name
       LIMIT ?`,
      [limit],
    );
  }

  /** One channel by slug. */
  async findChannel(slug: string): Promise<Channel | null> {
    const row = await this.first<ChannelRow>(
      `SELECT ch.id, ch.slug, ch.name, ch.description,
              ch.image_url AS imageUrl, ch.youtube_url AS youtubeUrl,
              ch.youtube_channel_id AS youtubeChannelId,
              ch.is_featured AS isFeatured, ch.is_visible AS isVisible,
              ch.video_count AS videoCount
       FROM channels ch
       WHERE ch.slug = ? AND ch.is_visible = 1`,
      [slug],
    );
    return row == null ? null : toChannel(row);
  }

  /**
   * The most-used tags, optionally within one category.
   *
   * This was the most expensive statement in the product by a wide margin. It
   * joined 7,876 live videos to 59,255 `video_tags` rows, grouped, sorted in a
   * temp B-tree and returned forty rows — about 127,000 rows read, per request,
   * to answer a question whose answer changes only when an editor changes it.
   * D1's free plan allows 5,000,000 rows read a day, so thirty-nine calls to
   * this one endpoint would have spent the entire budget.
   *
   * Both shapes now read a maintained table and stop at LIMIT:
   *   * `all`      — `tags.video_count`, ordered by `idx_tags_popular`.
   *   * a category — `category_tag_counts`, ordered by
   *     `idx_category_tag_counts_popular`.
   *
   * Forty rows read either way.
   */
  async listPopularTags(category: string, limit: number = TAGS.maxPopular): Promise<Tag[]> {
    const capped = clampLimit(limit, TAGS.maxPopular);

    if (category === 'all') {
      const rows = await this.all<TagRow>(
        `SELECT t.id, t.slug, t.name, t.video_count AS videoCount
         FROM tags t
         WHERE t.is_visible = 1 AND t.video_count > 0
         ORDER BY t.video_count DESC, t.name
         LIMIT ?`,
        [capped],
      );
      return rows.map(toTag);
    }

    const rows = await this.all<TagRow>(
      `SELECT t.id, t.slug, t.name, ctc.video_count AS videoCount
       FROM category_tag_counts ctc
       JOIN tags t ON t.id = ctc.tag_id
       WHERE ctc.category_id = ? AND t.is_visible = 1
       ORDER BY ctc.video_count DESC, t.name
       LIMIT ?`,
      [category, capped],
    );
    return rows.map(toTag);
  }

  /**
   * Tags whose name contains `q`, for the "add another tag" box.
   *
   * `LIKE '%…%'` cannot use an index, so this necessarily walks the 10,732 tag
   * rows — but that is now the whole cost, rather than the previous walk over
   * 59,255 relations and a `GROUP BY` on top of it. Scoping to a category
   * narrows the walk to that category's tag rows instead of widening it.
   */
  async searchTags(
    q: string,
    category: string,
    limit: number = TAGS.maxSuggestions,
  ): Promise<Tag[]> {
    if (q.trim().length === 0) return [];
    const capped = clampLimit(limit, TAGS.maxSuggestions);
    const pattern = likePattern(q);

    if (category === 'all') {
      const rows = await this.all<TagRow>(
        `SELECT t.id, t.slug, t.name, t.video_count AS videoCount
         FROM tags t
         WHERE t.is_visible = 1 AND t.video_count > 0
           AND t.name LIKE ? ESCAPE ${String.raw`'\'`}
         ORDER BY t.video_count DESC, t.name
         LIMIT ?`,
        [pattern, capped],
      );
      return rows.map(toTag);
    }

    const rows = await this.all<TagRow>(
      `SELECT t.id, t.slug, t.name, ctc.video_count AS videoCount
       FROM category_tag_counts ctc
       JOIN tags t ON t.id = ctc.tag_id
       WHERE ctc.category_id = ? AND t.is_visible = 1
         AND t.name LIKE ? ESCAPE ${String.raw`'\'`}
       ORDER BY ctc.video_count DESC, t.name
       LIMIT ?`,
      [category, pattern, capped],
    );
    return rows.map(toTag);
  }

  /**
   * Counters for the hero strip and the admin dashboard.
   *
   * Read from `catalog_counters`, which the maintenance job refreshes. Four
   * `COUNT(*)`s over the catalog — around 16,000 rows read on every home page —
   * became one statement returning five rows.
   *
   * A counter that has never been refreshed reads as 0. That is the honest
   * answer to "we have not computed this yet", and the admin dashboard shows
   * `lastRefreshedAt` beside the numbers so a stalled refresh is visible rather
   * than merely quietly wrong.
   */
  async stats(): Promise<CatalogStats> {
    const rows = await this.all<{ key: string; value: number }>(
      `SELECT key, value FROM catalog_counters`,
    );
    const counters = new Map(rows.map((row) => [row.key, row.value]));

    return {
      videos: counters.get('videos.live') ?? 0,
      channels: counters.get('channels.visible') ?? 0,
      categories: counters.get('categories.visible') ?? 0,
      addedThisWeek: counters.get('videos.addedThisWeek') ?? 0,
    };
  }

  /**
   * The rows that make up the home page, in display order.
   *
   * Reading the composition from the database is what lets an editor reorder
   * the home page, or add "New safety reviews", without a deployment.
   */
  async listHomeSections(includeAccountOnly: boolean): Promise<HomeSectionRow[]> {
    return this.all<HomeSectionRow>(
      `SELECT id, title, subtitle, type,
              filter_json AS filterJson, item_limit AS itemLimit,
              link_href AS linkHref, requires_account AS requiresAccount
       FROM home_sections
       WHERE is_visible = 1 ${includeAccountOnly ? '' : 'AND requires_account = 0'}
       ORDER BY sort_order, title`,
    );
  }

  /** Synonym groups, as a normalised term -> alternatives map. */
  async loadSynonyms(): Promise<Map<string, string[]>> {
    const rows = await this.all<{ term: string; synonym: string }>(
      `SELECT term, synonym FROM search_synonyms`,
    );
    const map = new Map<string, string[]>();
    for (const row of rows) {
      const existing = map.get(row.term);
      if (existing == null) map.set(row.term, [row.synonym]);
      else existing.push(row.synonym);
    }
    return map;
  }
}

/**
 * `channels.is_featured` means "this channel's YouTube page opens in NetFree".
 *
 * It was populated from `data/featured_channels.json`, the old site's list of
 * channels whose *homepage* — not just the individual videos — is reachable
 * behind the filter. It was rendered as a "מומלץ" badge, which said something
 * the data does not mean and implied the other channels were worse.
 *
 * Two things follow from it, and nothing else:
 *
 *   * The channels directory lists only these. Sending someone to a channel
 *     page whose every outward link is blocked is a dead end.
 *   * `youtubeUrl` is withheld for the rest. A direct link to any channel still
 *     works and still lists that channel's videos — those play fine — but there
 *     is no button offering a page the visitor cannot open. Withheld here, in
 *     the one place a channel is built, rather than in each template that might
 *     forget.
 */
function toChannel(row: ChannelRow): Channel {
  const netfreeOpen = toBoolean(row.isFeatured);

  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    imageUrl: row.imageUrl,
    youtubeUrl: netfreeOpen ? row.youtubeUrl : null,
    youtubeChannelId: row.youtubeChannelId,
    isFeatured: netfreeOpen,
    isVisible: toBoolean(row.isVisible),
    videoCount: row.videoCount,
  };
}

function toTag(row: TagRow): Tag {
  return { id: row.id, slug: row.slug, name: row.name, videoCount: row.videoCount };
}

