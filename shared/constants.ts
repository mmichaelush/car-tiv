/**
 * Constants shared by the browser bundle, the Worker and the build scripts.
 *
 * Anything that both sides must agree on lives here so a change cannot drift:
 * page sizes, sort keys, status values, cache lifetimes and the API envelope
 * error codes.
 */

/** Every list endpoint uses the same page-size rules. */
export const PAGINATION = {
  /** Default number of items per page when the caller does not ask. */
  defaultLimit: 24,
  /** Hard ceiling. Protects D1 from a `?limit=100000` request. */
  maxLimit: 60,
  /** Page size used by the admin tables, which are denser than the site grid. */
  adminLimit: 50,
} as const;

/** Search behaviour that the client and the server must agree on. */
export const SEARCH = {
  /** Below this length we do not query the server at all. */
  minQueryLength: 2,
  /** Longer queries are truncated rather than rejected. */
  maxQueryLength: 120,
  /** Number of autocomplete rows shown under the search box. */
  maxSuggestions: 7,
  /** Debounce before a keystroke turns into a request, in milliseconds. */
  suggestDebounceMs: 220,
} as const;

/** Tag lists shown in the filter panel. */
export const TAGS = {
  maxPopular: 40,
  maxSuggestions: 12,
} as const;

/** Number of related videos returned by `/api/videos/:id/related`. */
export const RELATED = {
  min: 6,
  max: 12,
} as const;

/**
 * `Cache-Control` values used by the Worker, in seconds.
 *
 * Public catalog data is cached aggressively because it changes only when an
 * editor changes it; anything user-specific is never cached.
 */
export const CACHE_SECONDS = {
  /**
   * Reference data: categories, channels, tags.
   *
   * An hour, matching the counter refresh in `migrations/0008_counters.sql`.
   * The numbers these endpoints return are recomputed hourly, so caching them
   * for longer would only serve a value the database itself had not updated —
   * and caching them for less would pay for a query whose answer cannot have
   * changed. It used to be a day, from before the cache was real.
   */
  reference: { browser: 900, edge: 3_600 },
  /** Catalog listings and search results. */
  catalog: { browser: 120, edge: 900 },
  /**
   * A single video document.
   *
   * Five minutes at the edge, not an hour. Cloudflare's cache is per-colo and
   * there is no purge API on this plan, so a Worker cannot reliably invalidate
   * an entry it has already written — the only global control over how stale a
   * cached answer can be is this number.
   *
   * That matters most for a takedown. When an editor hides a video, marks it
   * broken, or deletes it, the cached copy keeps being served until it expires;
   * an hour of that is a long time to keep serving something someone asked to
   * have removed. Five minutes is short enough to be defensible and long enough
   * to absorb the traffic a popular video attracts. `worker/routes/admin-routes.ts`
   * additionally deletes the entry in the colo that handled the edit, which
   * makes the editor's own check immediate.
   */
  video: { browser: 120, edge: 300 },
  /** The composed home-page payload. */
  home: { browser: 120, edge: 900 },
} as const;

/**
 * The plan this site has to live inside, and the rules that keep it there.
 *
 * These are not aspirations — they are the numbers every performance decision
 * in the code base was measured against, and `docs/performance.md` shows the
 * measurements. The Cloudflare free plan allows:
 *
 *   * 100,000 Worker requests per day
 *   * 5,000,000 D1 rows read per day
 *   * 100,000 D1 rows written per day
 *   * 500 MB in one D1 database
 *
 * The catalog as it stands is 18 MiB, so storage is not the binding
 * constraint; rows read is. One uncached home page used to cost ~35,000 rows,
 * which is 143 page views a day. That is what `catalog_counters` and the
 * Worker's own cache exist to fix.
 */
export const PLAN_LIMITS = {
  workerRequestsPerDay: 100_000,
  rowsReadPerDay: 5_000_000,
  rowsWrittenPerDay: 100_000,
  databaseBytes: 500 * 1024 * 1024,
  /** Warn in the admin dashboard once usage passes this share of a limit. */
  warnAtFraction: 0.7,
} as const;

/**
 * Worker requests one page view costs, counted in a real browser.
 *
 * After the read work, **this** is the binding constraint: 100,000 Worker
 * requests a day. Rows read are no longer close to their limit, and storage is
 * not close to its.
 *
 * Static assets — the HTML, CSS, JavaScript, fonts and images — are served by
 * Workers Static Assets without invoking the Worker, so they are free and
 * unmetered and are not counted here. What is counted: the routes listed in
 * `run_worker_first` (the rewritten `/video/:id`, `/category/:id` and
 * `/channel/:slug` pages) plus every `/api/*` call.
 *
 * "Repeat" is the honest number for a returning visitor: the session hint
 * cookie removes `/api/auth/session`, and the reference endpoints are still
 * fresh in the browser cache.
 *
 * These are constants, not measurements taken at runtime — deliberately. A
 * counter that wrote to D1 on every request would spend the write budget to
 * measure the request budget, and Cloudflare's own dashboard already reports
 * the exact figure for free. This table exists so the admin screen can answer
 * "how many visitors a day can this take?" with arithmetic instead of a guess.
 */
export const PAGE_REQUEST_COST = {
  /** `/` — `/api/home`, plus the session check on a cold browser. */
  home: { first: 2, again: 0 },
  /**
   * `/video/:id` — the rewrite of the page itself, plus one combined
   * `?include=related,channel` call. It was four before those three calls
   * became one.
   */
  video: { first: 3, again: 2 },
  /**
   * `/category/:id` — the rewrite, the listing, the category's tags, and the
   * category list. Moving to a *different* category costs 3, not 5: the
   * category list is still fresh in the browser.
   */
  category: { first: 5, again: 3 },
  /** `/search?q=` — the rewrite, the listing, tags and categories. */
  search: { first: 4, again: 2 },
} as const;

/**
 * A plausible visit, in Worker requests: the home page, two videos, one
 * category. Measured, not assumed — `again` is what the second and later pages
 * of a kind actually cost once the browser is holding the reference data.
 *
 * The admin dashboard divides the daily limit by this to answer the only
 * question anyone asks of a quota: how many visitors a day does it hold?
 */
export const TYPICAL_VISIT_REQUESTS =
  PAGE_REQUEST_COST.home.first +
  PAGE_REQUEST_COST.video.first +
  PAGE_REQUEST_COST.video.again +
  PAGE_REQUEST_COST.category.again;

/**
 * How long each kind of row is kept.
 *
 * Every table here grows with traffic rather than with the catalog, so without
 * a ceiling each one is an eventual 500 MB problem. The values are generous
 * enough that no report loses data it actually shows — the admin dashboards
 * look back 30 days — and short enough that the tables reach a steady size
 * instead of a slope.
 *
 * `maxRows` is a second, independent bound: a burst of traffic can produce a
 * month of logs in a day, and age alone would not catch it.
 */
export const RETENTION = {
  /** Anonymous search log. Feeds the "what content is missing" report. */
  searchLogs: { days: 90, maxRows: 200_000 },
  /**
   * The daily rollup of that log. Kept far longer than the raw rows it
   * summarises — that is the point of a rollup — but still bounded: one row per
   * distinct query per day is small, and unbounded is not a size.
   */
  searchQueryDaily: { days: 400, maxRows: 100_000 },
  /** Admin audit trail. Long, because it is the record of who changed what. */
  auditLog: { days: 365, maxRows: 100_000 },
  /** Watch history rows nobody has touched in a year. */
  watchHistory: { days: 365, maxRows: 500_000 },
  /** Import jobs and their rejected rows, once the job is long finished. */
  importJobs: { days: 30, maxRows: 20_000 },
  /** The cron's own heartbeat. */
  maintenanceRuns: { days: 30, maxRows: 5_000 },
  /** Daily growth samples, one row per table per day. */
  growthSamples: { days: 400, maxRows: 20_000 },
  /** Daily usage counters. */
  usageDaily: { days: 400, maxRows: 1_000 },
} as const;

export type RetentionTable = keyof typeof RETENTION;

/** Sort orders accepted by `/api/videos`. */
export const SORT_OPTIONS = [
  'date-desc',
  'date-asc',
  'duration-asc',
  'duration-desc',
  'title-asc',
  'title-desc',
  'relevance',
] as const;

export type SortOption = (typeof SORT_OPTIONS)[number];

export const DEFAULT_SORT: SortOption = 'date-desc';

/** Publication states of a catalog video. */
export const VIDEO_STATUSES = [
  'draft',
  'pending',
  'published',
  'hidden',
  'broken',
  'removed',
] as const;

export type VideoStatus = (typeof VIDEO_STATUSES)[number];

/** Reasons a visitor can pick when reporting a problem with a video. */
export const REPORT_REASONS = [
  'broken',
  'removed',
  'wrong-details',
  'wrong-category',
  'inaccurate-title',
  'inappropriate',
  'other',
] as const;

export type ReportReason = (typeof REPORT_REASONS)[number];

/** Lifecycle of a moderation item (report, feedback, submission, contact). */
export const MODERATION_STATUSES = ['new', 'reviewing', 'waiting', 'resolved', 'closed'] as const;

export type ModerationStatus = (typeof MODERATION_STATUSES)[number];

/** Submission review states. */
export const SUBMISSION_STATUSES = [
  'new',
  'reviewing',
  'approved',
  'rejected',
  'duplicate',
] as const;

export type SubmissionStatus = (typeof SUBMISSION_STATUSES)[number];

/** Roles understood by the permission layer, from most to least privileged. */
export const ROLES = ['admin', 'editor', 'moderator', 'user'] as const;

export type Role = (typeof ROLES)[number];

/**
 * Stable machine-readable error codes returned in the API envelope.
 * The UI maps these to Hebrew messages; never branch on the message text.
 */
export const ERROR_CODES = {
  validation: 'VALIDATION_ERROR',
  notFound: 'NOT_FOUND',
  videoNotFound: 'VIDEO_NOT_FOUND',
  invalidVideoId: 'INVALID_VIDEO_ID',
  duplicate: 'DUPLICATE',
  rateLimited: 'RATE_LIMITED',
  unauthorized: 'UNAUTHORIZED',
  forbidden: 'FORBIDDEN',
  badRequest: 'BAD_REQUEST',
  payloadTooLarge: 'PAYLOAD_TOO_LARGE',
  internal: 'INTERNAL_ERROR',
  unavailable: 'SERVICE_UNAVAILABLE',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/** A YouTube video id is always 11 URL-safe characters. */
export const YOUTUBE_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

/** Largest request body the Worker will read, in bytes. */
export const MAX_REQUEST_BODY_BYTES = 32 * 1024;
