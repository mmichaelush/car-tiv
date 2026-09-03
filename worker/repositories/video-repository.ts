/**
 * Catalog queries: listing, filtering, a single video, related videos.
 *
 * The listing query is the hottest path in the product, so it is built once,
 * here, from a `VideoQuery`, and every page (home, category, channel, search,
 * "for your car") goes through it rather than growing its own SQL.
 */

import { RELATED, SEARCH } from '@shared/constants.js';
import { RELATED_WEIGHTS } from '@shared/core/relevance.js';
import { buildPageMeta, clampLimit, clampPage, offsetFor } from '@shared/core/pagination.js';
import { indexText } from '@shared/core/text.js';
import type { Page } from '@shared/types/api.js';
import type {
  VideoDetail,
  VideoId,
  VideoQuery,
  VideoSummary,
  VideoVehicle,
} from '@shared/types/catalog.js';
import {
  BaseRepository,
  ConditionBuilder,
  LIST_SEPARATOR,
  type Binding,
  chunkForBindings,
  placeholders,
  splitList,
  toBoolean,
} from './base.js';
import { buildMatchExpression } from './search-expression.js';

/** Columns selected for a card. Kept in one constant so every query agrees. */
/**
 * Characters of the description a listing row carries. Two lines of text.
 *
 * The list view on a wide screen has a column of empty space beside the
 * thumbnail, and the obvious fix — send the description — means shipping 7,876
 * of them through a listing endpoint that is cached at the edge and read on
 * every page. Capping it in SQL with substr() means the row never carries more
 * than this however long the description is, so a page of 24 costs a couple of
 * kilobytes rather than tens.
 */
const EXCERPT_LENGTH = 180;

const SUMMARY_COLUMNS = `
  v.id                AS id,
  v.title             AS title,
  v.category_id       AS categoryId,
  cat.name            AS categoryName,
  ch.slug             AS channelSlug,
  ch.name             AS channelName,
  ch.image_url        AS channelImage,
  v.duration_seconds  AS durationSeconds,
  v.added_at          AS addedAt,
  v.published_at      AS publishedAt,
  v.thumbnail_url     AS thumbnailUrl,
  v.is_hebrew         AS isHebrew,
  v.is_featured       AS isFeatured,
  (
    SELECT group_concat(t.name, '${LIST_SEPARATOR}')
    FROM video_tags vt JOIN tags t ON t.id = vt.tag_id
    WHERE vt.video_id = v.id AND t.is_visible = 1
  ) AS tagNames,
  -- A short excerpt, not the description. See EXCERPT_LENGTH above.
  substr(v.description, 1, ${String(EXCERPT_LENGTH)}) AS excerpt`;

const SUMMARY_FROM = `
  FROM videos v
  JOIN categories cat ON cat.id = v.category_id
  LEFT JOIN channels ch ON ch.id = v.channel_id`;

/** Only published, non-deleted rows are ever visible to the public API. */
const LIVE = `v.status = 'published' AND v.deleted_at IS NULL`;

/**
 * How many videos each arm of the "related videos" candidate search may
 * contribute.
 *
 * Five arms, so at most 750 rows are ever scored — in practice far fewer,
 * because the arms overlap heavily. Twelve are returned. The number is a
 * deliberate over-supply: it is large enough that the top twelve are the true
 * top twelve for any realistic video, and small enough that the cost of the
 * endpoint no longer depends on the size of the catalog.
 *
 * Interpolated into the SQL rather than bound because SQLite will not accept a
 * parameter in the `LIMIT` of a compound-select arm. It is a module constant,
 * never a value from a request.
 */
const CANDIDATE_POOL = 150;

/**
 * The related-video weights, as SQL literals.
 *
 * Interpolated from `shared/core/relevance.ts` rather than written into the
 * statement, so the query and the module that documents the rule cannot drift.
 * They already had: the module carried a `recencyBonus` the SQL never applied
 * and `docs/api.md` described as if it did.
 *
 * These are numbers from a frozen `as const` object, never from a request, so
 * interpolating them does not weaken the no-string-concatenation rule — a
 * weight cannot be a bound parameter, because SQLite would then have to
 * re-plan the arithmetic on every call.
 */
const W: Readonly<Record<keyof typeof RELATED_WEIGHTS, string>> = Object.fromEntries(
  Object.entries(RELATED_WEIGHTS).map(([name, weight]) => [name, String(weight)]),
) as Readonly<Record<keyof typeof RELATED_WEIGHTS, string>>;

interface SummaryRow {
  id: string;
  title: string;
  categoryId: string;
  categoryName: string;
  channelSlug: string | null;
  channelName: string | null;
  channelImage: string | null;
  durationSeconds: number;
  addedAt: string;
  publishedAt: string | null;
  thumbnailUrl: string | null;
  isHebrew: number;
  isFeatured: number;
  tagNames: string | null;
  excerpt: string | null;
}

interface DetailRow extends SummaryRow {
  description: string;
  status: string;
  language: string;
  updatedAt: string;
}

interface VehicleRow {
  manufacturer: string;
  model: string;
  yearFrom: number | null;
  yearTo: number | null;
}

/** A `VideoQuery` translated into SQL fragments and their bindings. */
interface Filters {
  readonly where: string;
  readonly bindings: Binding[];
  readonly ftsJoin: string;
  readonly ftsBindings: Binding[];
}

/** Extra knobs the search service uses; every page otherwise passes nothing. */
export interface ListOptions {
  /**
   * A ready-made FTS5 `MATCH` expression, replacing the one derived from
   * `query.q`. Used to widen a search with synonyms.
   */
  readonly matchExpression?: string | null;
}

export class VideoRepository extends BaseRepository {
  /**
   * A page of the catalog.
   *
   * The page itself is one index-driven statement that stops at `LIMIT`. The
   * total is the expensive half — see `#total` for how it is avoided.
   */
  async list(query: VideoQuery, options: ListOptions = {}): Promise<Page<VideoSummary>> {
    const page = clampPage(query.page);
    const limit = clampLimit(query.limit);
    const filters = this.#buildFilters(query, options);
    const { where, bindings, ftsJoin, ftsBindings } = filters;
    const order = orderBy(query);

    const rows = await this.all<SummaryRow>(
      `SELECT ${SUMMARY_COLUMNS}
       ${SUMMARY_FROM}
       ${ftsJoin}
       ${where}
       ORDER BY ${order}
       LIMIT ? OFFSET ?`,
      [...ftsBindings, ...bindings, limit, offsetFor(page, limit)],
    );

    const total = await this.#total(query, filters, page, limit, rows.length);

    return { items: rows.map(toSummary), meta: buildPageMeta(page, limit, total) };
  }

  /**
   * How many videos the query matches in total.
   *
   * This number is only ever used to draw a pager and a "N results" line, and
   * it used to cost more than the page it accompanied: a second pass over the
   * same join, reading every matching row to return one integer. On the
   * unfiltered listing — the busiest query on the site — that was 7,876 rows
   * read on every single request, for a number that is the same for everybody.
   *
   * Three cases, cheapest first:
   *
   *  1. **The whole catalog, one category, or one tag.** The answer is already
   *     stored, maintained by `CountersRepository`. One row read. These are the
   *     shapes the site's own navigation produces — the header, the category
   *     grid, and every chip in the filter panel — so they are the ones worth
   *     having an answer ready for.
   *  2. **A first page that came back short.** Fewer rows than the limit means
   *     there is nothing behind them; the total is what we are holding. Covers
   *     every narrow filter that fits on one screen, for free.
   *  3. **Anything else** — a text search, a tag combination, a vehicle
   *     filter, a deep page. Counted for real, because there is no honest way
   *     to know otherwise, and these are the queries a visitor actually varies.
   *
   * The API contract is unchanged: `meta.total` still means what it always
   * meant. A stored count can lag the catalog by up to an hour, which for a
   * pager label is invisible — and the list of videos it labels is unaffected,
   * since those still come from the live tables on every request.
   */
  async #total(
    query: VideoQuery,
    filters: Filters,
    page: number,
    limit: number,
    rowsOnThisPage: number,
  ): Promise<number> {
    // 1. A shape whose count is maintained.
    if (isCountableByCounter(query)) {
      const stored = await this.#storedTotal(query.category, query.tags[0] ?? null);
      if (stored != null) return stored;
    }

    // 2. A short first page cannot have more behind it.
    if (page === 1 && rowsOnThisPage < limit) return rowsOnThisPage;

    // 3. No shortcut applies.
    return this.count(
      `SELECT COUNT(*) AS value ${SUMMARY_FROM} ${filters.ftsJoin} ${filters.where}`,
      [...filters.ftsBindings, ...filters.bindings],
    );
  }

  /**
   * The maintained total for one of the four shapes that has one.
   *
   * Returns `null` — meaning "count it properly" — whenever the stored value is
   * missing or zero. A counter that has never been refreshed reads zero, and
   * rendering that as an empty catalog would turn a stalled cron job into an
   * apparently empty site. Falling back costs one full count on a cold
   * database and nothing at all after the first refresh.
   */
  async #storedTotal(category: string, tag: string | null): Promise<number | null> {
    // Whole catalog.
    if (category === 'all' && tag == null) {
      return this.#nonZero(`SELECT value FROM catalog_counters WHERE key = 'videos.live'`);
    }

    // One category.
    if (tag == null) {
      return this.#nonZero(`SELECT video_count AS value FROM categories WHERE id = ?`, [category]);
    }

    // One tag, across the catalog.
    if (category === 'all') {
      return this.#nonZero(`SELECT video_count AS value FROM tags WHERE slug = ?`, [tag]);
    }

    // One tag inside one category. Absent from `category_tag_counts` means the
    // pair is below the storage threshold, not that it has no videos, so this
    // falls through to a real count like any other unmaintained shape.
    return this.#nonZero(
      `SELECT ctc.video_count AS value
       FROM category_tag_counts ctc JOIN tags t ON t.id = ctc.tag_id
       WHERE ctc.category_id = ? AND t.slug = ?`,
      [category, tag],
    );
  }

  /** A stored counter, or `null` when it is absent or zero. */
  async #nonZero(sql: string, bindings: readonly Binding[] = []): Promise<number | null> {
    const row = await this.first<{ value: number }>(sql, bindings);
    return row == null || row.value === 0 ? null : row.value;
  }

  /** One video, with its tags and the vehicles it applies to. */
  async findById(id: VideoId): Promise<VideoDetail | null> {
    const row = await this.first<DetailRow>(
      `SELECT ${SUMMARY_COLUMNS},
              v.description AS description,
              v.status      AS status,
              v.language    AS language,
              v.updated_at  AS updatedAt
       ${SUMMARY_FROM}
       WHERE v.id = ? AND ${LIVE}`,
      [id],
    );
    if (row == null) return null;

    const vehicles = await this.all<VehicleRow>(
      `SELECT mk.name AS manufacturer, m.name AS model,
              vvm.year_from AS yearFrom, vvm.year_to AS yearTo
       FROM video_vehicle_models vvm
       JOIN vehicle_models m  ON m.id = vvm.model_id
       JOIN manufacturers mk  ON mk.id = m.manufacturer_id
       WHERE vvm.video_id = ?
       ORDER BY mk.name, m.name`,
      [id],
    );

    return {
      ...toSummary(row),
      description: row.description,
      status: row.status as VideoDetail['status'],
      language: row.language,
      updatedAt: row.updatedAt,
      vehicles: vehicles.map((vehicle): VideoVehicle => ({
        manufacturer: vehicle.manufacturer,
        model: vehicle.model,
        yearFrom: vehicle.yearFrom,
        yearTo: vehicle.yearTo,
      })),
    };
  }

  /**
   * Videos related to `id`.
   *
   * The score is the one in `shared/core/relevance.ts`: same model 5, same
   * manufacturer 4, same category 3, shared tag 2 (capped at three tags), same
   * channel 1.
   *
   * The shape of this query is the whole story. The obvious way to write it —
   * score every video, keep the best twelve — is what it used to do, and it
   * meant computing four correlated subqueries against all 7,876 live videos
   * for every video page view: tens of thousands of rows read, and 75 ms, to
   * return twelve cards. Almost all of that work was spent proving that
   * unrelated videos score zero.
   *
   * So the candidates come first. A video can only score above zero if it
   * shares a model, a manufacturer, a category, a tag or a channel with the
   * source — and every one of those is an index lookup. The `candidates` CTE
   * unions those five sets, each capped, and scoring runs over that few hundred
   * rows instead of the catalog.
   *
   * The caps are what make the cost bounded rather than merely smaller: the
   * category arm alone would otherwise pull 4,354 rows for a "review" video.
   * Taking the newest `CANDIDATE_POOL` of them is not a compromise on quality —
   * the tie-break for equally-scored videos is `added_at DESC` anyway, so the
   * rows dropped are exactly the ones that would have lost.
   */
  async findRelated(id: VideoId, limit: number = RELATED.max): Promise<VideoSummary[]> {
    const rows = await this.all<SummaryRow>(
      `WITH source AS (
         SELECT v.id, v.category_id, v.channel_id FROM videos v WHERE v.id = ?
       ),
       source_tags AS (
         SELECT tag_id FROM video_tags WHERE video_id = ?
       ),
       source_models AS (
         SELECT model_id FROM video_vehicle_models WHERE video_id = ?
       ),
       source_makes AS (
         SELECT DISTINCT m.manufacturer_id
         FROM video_vehicle_models vvm JOIN vehicle_models m ON m.id = vvm.model_id
         WHERE vvm.video_id = ?
       ),
       -- Every model made by those manufacturers, resolved to a plain list of
       -- ids before it is used.
       --
       -- This is not a stylistic preference. Written the obvious way — joining
       -- video_vehicle_models to vehicle_models and filtering on
       -- manufacturer_id — SQLite turns the join around and drives from
       -- videos, walking all 7,876 live rows to find the hundred that match:
       -- 11 ms, and the single most expensive step in this query. Given a list
       -- of model ids it seeks idx_video_vehicles_model instead, and the same
       -- rows come back in 0.2 ms.
       make_models AS (
         SELECT m.id FROM vehicle_models m
         WHERE m.manufacturer_id IN (SELECT manufacturer_id FROM source_makes)
       ),
       -- Every video that could possibly score above zero, and nothing else.
       --
       -- UNION (not UNION ALL) so a video reachable three ways is scored once.
       -- Every arm is capped: a tag like "רכב" sits on thousands of videos and
       -- an uncapped arm would put the catalog back in the pool through the
       -- side door. Each cap takes the newest rows, which is the same
       -- tie-break the final ORDER BY applies, so a capped-out row is one that
       -- would have lost anyway.
       candidates AS (
         SELECT id FROM (
           SELECT v.id, v.added_at FROM video_vehicle_models x
             JOIN videos v ON v.id = x.video_id
             WHERE x.model_id IN (SELECT model_id FROM source_models) AND ${LIVE}
             ORDER BY v.added_at DESC LIMIT ${String(CANDIDATE_POOL)}
         )
         UNION
         SELECT id FROM (
           SELECT v.id, v.added_at FROM video_vehicle_models x
             JOIN videos v ON v.id = x.video_id
             WHERE x.model_id IN (SELECT id FROM make_models) AND ${LIVE}
             ORDER BY v.added_at DESC LIMIT ${String(CANDIDATE_POOL)}
         )
         UNION
         SELECT id FROM (
           SELECT v.id, v.added_at FROM video_tags x
             JOIN videos v ON v.id = x.video_id
             WHERE x.tag_id IN (SELECT tag_id FROM source_tags) AND ${LIVE}
             ORDER BY v.added_at DESC LIMIT ${String(CANDIDATE_POOL)}
         )
         UNION
         SELECT id FROM (
           SELECT v.id, v.added_at FROM videos v
           WHERE v.category_id = (SELECT category_id FROM source) AND ${LIVE}
           ORDER BY v.added_at DESC LIMIT ${String(CANDIDATE_POOL)}
         )
         UNION
         SELECT id FROM (
           SELECT v.id, v.added_at FROM videos v
           WHERE v.channel_id IS NOT NULL
             AND v.channel_id = (SELECT channel_id FROM source) AND ${LIVE}
           ORDER BY v.added_at DESC LIMIT ${String(CANDIDATE_POOL)}
         )
       ),
       scored AS (
         SELECT v.id,
           ${W.sameModel} * (SELECT COUNT(*) > 0 FROM video_vehicle_models x
                WHERE x.video_id = v.id AND x.model_id IN (SELECT model_id FROM source_models))
         + ${W.sameManufacturer} * (SELECT COUNT(*) > 0 FROM video_vehicle_models x
                WHERE x.video_id = v.id AND x.model_id IN (SELECT id FROM make_models))
         + ${W.sameCategory} * (v.category_id = (SELECT category_id FROM source))
         + ${W.sharedTag} * MIN(${String(RELATED_WEIGHTS.maxSharedTags)}, (SELECT COUNT(*) FROM video_tags x
                       WHERE x.video_id = v.id AND x.tag_id IN (SELECT tag_id FROM source_tags)))
         + ${W.sameChannel} * (v.channel_id IS NOT NULL AND v.channel_id = (SELECT channel_id FROM source))
           AS score
         FROM videos v
         JOIN candidates c ON c.id = v.id
         WHERE v.id <> ? AND ${LIVE}
       )
       SELECT ${SUMMARY_COLUMNS}
       ${SUMMARY_FROM}
       JOIN scored s ON s.id = v.id
       WHERE s.score > 0 AND ${LIVE}
       ORDER BY s.score DESC, v.added_at DESC
       LIMIT ?`,
      [id, id, id, id, id, clampLimit(limit, RELATED.max)],
    );
    return rows.map(toSummary);
  }

  /** More videos from the same channel, excluding the one being watched. */
  async findByChannel(
    channelSlug: string,
    excludeId: VideoId | null,
    limit: number,
  ): Promise<VideoSummary[]> {
    const rows = await this.all<SummaryRow>(
      `SELECT ${SUMMARY_COLUMNS}
       ${SUMMARY_FROM}
       WHERE ch.slug = ? AND ${LIVE} AND (? IS NULL OR v.id <> ?)
       ORDER BY v.added_at DESC
       LIMIT ?`,
      [channelSlug, excludeId, excludeId, clampLimit(limit)],
    );
    return rows.map(toSummary);
  }

  /**
   * Look up several videos at once, preserving the caller's order.
   *
   * Chunked here rather than by the caller. It was safe only by coincidence:
   * `account-routes.ts` sliced the list by `PAGINATION.maxLimit`, which is 60
   * and therefore under D1's 100-parameter limit — but that constant exists to
   * cap a page size, and raising it for a perfectly good pagination reason
   * would have broken a query in another file with no visible connection to it.
   * The repository is the layer that knows about the database's limits, so it
   * is the layer that keeps them.
   */
  async findManyByIds(ids: readonly VideoId[]): Promise<VideoSummary[]> {
    if (ids.length === 0) return [];

    const byId = new Map<string, VideoSummary>();
    for (const chunk of chunkForBindings(ids)) {
      const rows = await this.all<SummaryRow>(
        `SELECT ${SUMMARY_COLUMNS} ${SUMMARY_FROM}
         WHERE v.id IN (${placeholders(chunk.length)}) AND ${LIVE}`,
        [...chunk],
      );
      for (const row of rows) byId.set(row.id, toSummary(row));
    }

    return ids.map((id) => byId.get(id)).filter((video): video is VideoSummary => video != null);
  }

  /**
   * Ids and dates for the sitemap.
   *
   * Deliberately not `list()`: that endpoint caps `limit` at 60 to protect D1
   * from a hostile query string, while the sitemap legitimately needs 5,000
   * rows of two columns at a time.
   */
  async listForSitemap(offset: number, limit: number): Promise<{ id: string; addedAt: string }[]> {
    return this.all<{ id: string; addedAt: string }>(
      `SELECT v.id, v.added_at AS addedAt
       FROM videos v
       WHERE ${LIVE}
       ORDER BY v.added_at DESC, v.id
       LIMIT ? OFFSET ?`,
      [Math.min(Math.max(1, limit), 10_000), Math.max(0, offset)],
    );
  }

  /**
   * Whether a YouTube id is already known, either published or waiting for
   * review. Used by the duplicate check on the "suggest a video" form.
   */
  async existsAnywhere(id: VideoId): Promise<{ published: boolean; pending: boolean }> {
    const row = await this.first<{ published: number; pending: number }>(
      `SELECT
         (SELECT COUNT(*) FROM videos WHERE id = ? AND deleted_at IS NULL) AS published,
         (SELECT COUNT(*) FROM video_submissions
          WHERE youtube_id = ? AND status IN ('new', 'reviewing')) AS pending`,
      [id, id],
    );
    return { published: (row?.published ?? 0) > 0, pending: (row?.pending ?? 0) > 0 };
  }

  // -------------------------------------------------------------------------
  // Filter construction
  // -------------------------------------------------------------------------

  /**
   * Translate a `VideoQuery` into a WHERE clause plus the optional full-text
   * join. The FTS bindings come first because the join precedes the WHERE in
   * the statement, and D1 binds `?` positionally.
   */
  #buildFilters(query: VideoQuery, options: ListOptions): Filters {
    const conditions = new ConditionBuilder().add(LIVE);

    conditions.addIf(query.category !== 'all', 'v.category_id = ?', query.category);
    conditions.addIf(query.channel != null, 'ch.slug = ?', query.channel);
    conditions.addIf(query.hebrewOnly, 'v.is_hebrew = 1');
    conditions.addIf(query.featuredOnly, 'v.is_featured = 1');
    conditions.addIf(
      query.minDurationSeconds != null,
      'v.duration_seconds >= ?',
      query.minDurationSeconds,
    );
    conditions.addIf(
      query.maxDurationSeconds != null,
      'v.duration_seconds <= ?',
      query.maxDurationSeconds,
    );

    // Tags are combined with AND: selecting two tags narrows the result.
    //
    // `IN` rather than the `EXISTS` this used to be, and the difference is
    // larger than it looks. `EXISTS` walks `idx_videos_live_added` newest-first
    // and tests each row, so its cost is inversely proportional to how common
    // the tag is: 0.1 ms for the most-used tag in the catalog, but 11.9 ms for
    // a tag with six videos, because it reads every live row to find them.
    // Almost every tag is a rare tag. `IN` starts from the tag instead — an
    // index seek into `idx_video_tags_tag` — so it reads that tag's videos and
    // nothing else: 0.07 ms for the rare tag, and a worst case of 5.2 ms on the
    // most common one. Better where it matters, and a better ceiling.
    // An explicit id list — the offline library and playlists hydrating a saved
    // set in one request. Bounded by `PAGINATION.maxLimit` in `parseQuery`, so
    // this can never approach D1's 100-parameter ceiling.
    if (query.ids.length > 0) {
      conditions.add(`v.id IN (${placeholders(query.ids.length)})`, ...query.ids);
    }

    for (const tag of query.tags) {
      conditions.add(
        `v.id IN (SELECT vt.video_id FROM video_tags vt
                  JOIN tags t ON t.id = vt.tag_id WHERE t.slug = ?)`,
        tag,
      );
    }

    if (query.manufacturer != null || query.model != null || query.year != null) {
      const vehicle = new ConditionBuilder().add('vvm.video_id = v.id');
      vehicle.addIf(query.manufacturer != null, 'mk.slug = ?', query.manufacturer);
      vehicle.addIf(query.model != null, 'm.slug = ?', query.model);
      vehicle.addIf(
        query.year != null,
        '(vvm.year_from IS NULL OR vvm.year_from <= ?) AND (vvm.year_to IS NULL OR vvm.year_to >= ?)',
        query.year,
        query.year,
      );
      conditions.add(
        `EXISTS (SELECT 1 FROM video_vehicle_models vvm
                 JOIN vehicle_models m ON m.id = vvm.model_id
                 JOIN manufacturers mk ON mk.id = m.manufacturer_id
                 ${vehicle.whereClause()})`,
        ...vehicle.bindings(),
      );
    }

    // The search service may supply a synonym-expanded expression; otherwise
    // build the plain one from the query text.
    const expression = options.matchExpression ?? buildMatchExpression(query.q);
    const useFts = expression != null && query.q.trim().length >= SEARCH.minQueryLength;

    return {
      where: conditions.whereClause(),
      bindings: conditions.bindings(),
      ftsJoin: useFts
        ? `JOIN (
             SELECT video_id, bm25(videos_fts, 0.0, 10.0, 8.0, 8.0, 4.0, 2.0, 1.0) AS score
             FROM videos_fts WHERE videos_fts MATCH ?
           ) fts ON fts.video_id = v.id`
        : '',
      ftsBindings: useFts ? [expression] : [],
    };
  }
}

/**
 * Whether a maintained counter answers this query's total exactly.
 *
 * Only when the query narrows by nothing beyond a category and at most one tag
 * — the four shapes `CountersRepository` maintains. Every field of
 * `VideoQuery` is listed explicitly rather than checked with a spread or a key
 * count, so adding a filter without deciding what it means here is a compile
 * error rather than a wrong number in production.
 */
function isCountableByCounter(query: VideoQuery): boolean {
  return (
    query.q.trim().length < SEARCH.minQueryLength &&
    query.tags.length <= 1 &&
    // An id list is a set of exactly known size, so the maintained counter for
    // the category would be the wrong number entirely.
    query.ids.length === 0 &&
    query.channel == null &&
    query.manufacturer == null &&
    query.model == null &&
    query.year == null &&
    query.minDurationSeconds == null &&
    query.maxDurationSeconds == null &&
    !query.hebrewOnly &&
    !query.featuredOnly
  );
}

/**
 * ORDER BY for a query.
 *
 * With a text query the default is relevance; `bm25` returns a *negative*
 * score where more negative is better, hence `ASC`.
 */
function orderBy(query: VideoQuery): string {
  const hasText = query.q.trim().length >= SEARCH.minQueryLength;

  switch (query.sort) {
    case 'date-asc':
      return 'v.added_at ASC, v.id ASC';
    case 'duration-asc':
      return 'v.duration_seconds ASC, v.added_at DESC';
    case 'duration-desc':
      return 'v.duration_seconds DESC, v.added_at DESC';
    case 'title-asc':
      return 'v.title ASC';
    case 'title-desc':
      return 'v.title DESC';
    case 'relevance':
      return hasText ? 'fts.score ASC, v.added_at DESC' : 'v.added_at DESC, v.id DESC';
    case 'date-desc':
    default:
      // A text search without an explicit sort should answer by relevance.
      return hasText ? 'fts.score ASC, v.added_at DESC' : 'v.added_at DESC, v.id DESC';
  }
}

/** Map a row onto the API shape. */
function toSummary(row: SummaryRow): VideoSummary {
  return {
    id: row.id as VideoId,
    title: row.title,
    categoryId: row.categoryId,
    categoryName: row.categoryName,
    channel:
      row.channelSlug == null
        ? null
        : {
            slug: row.channelSlug,
            name: row.channelName ?? row.channelSlug,
            imageUrl: row.channelImage,
          },
    durationSeconds: row.durationSeconds,
    addedAt: row.addedAt,
    publishedAt: row.publishedAt,
    thumbnailUrl: row.thumbnailUrl,
    isHebrew: toBoolean(row.isHebrew),
    isFeatured: toBoolean(row.isFeatured),
    tags: splitList(row.tagNames).slice(0, 6),
    excerpt: row.excerpt ?? '',
  };
}

/** Exposed for the search service, which indexes the same normalised text. */
export const normalizeForIndex = indexText;
