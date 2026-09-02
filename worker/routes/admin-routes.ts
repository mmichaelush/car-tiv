/**
 * `/api/admin/*` — the management API.
 *
 * Every handler starts with `requireStaff`, and every response is `no-store`:
 * nothing here may be cached at the edge, because it is not public data.
 */

import {
  MODERATION_STATUSES,
  PAGE_REQUEST_COST,
  PLAN_LIMITS,
  TYPICAL_VISIT_REQUESTS,
  RETENTION,
  SUBMISSION_STATUSES,
  VIDEO_STATUSES,
  type VideoStatus,
} from '@shared/constants.js';
import { isoDaysAgo } from '@shared/core/dates.js';
import { z } from 'zod';
import type { RequestContext } from '../context.js';
import { AdminRepository } from '../repositories/admin-repository.js';
import { BadRequestError, NotFoundError } from '../lib/errors.js';
import { CACHE, ok, okList } from '../lib/response.js';
import { requireStaff } from '../middleware/auth.js';
import { get, patch, post, type RouteDefinition } from '../router.js';
import { parseOrThrow } from '../schemas/index.js';
import { MaintenanceService } from '../services/maintenance-service.js';
import { purgeVideo } from '../middleware/edge-cache.js';

/** One repository instance per request, built lazily. */
function admin(context: RequestContext): AdminRepository {
  return new AdminRepository(context.env.DB);
}

// ---------------------------------------------------------------- Schemas

const idsSchema = z.object({
  ids: z.array(z.string().length(11)).min(1, 'יש לבחור לפחות סרטון אחד').max(500),
});

const videoPatchSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  description: z.string().max(10_000).optional(),
  categoryId: z.string().max(50).optional(),
  status: z.enum(VIDEO_STATUSES).optional(),
  isFeatured: z.boolean().optional(),
  isHebrew: z.boolean().optional(),
  adminNote: z.string().max(2_000).optional(),
});

const bulkSchema = idsSchema.extend({
  patch: videoPatchSchema,
});

const tagSchema = idsSchema.extend({
  tag: z.string().trim().min(1).max(80),
});

const moderationSchema = z.object({
  status: z
    .string()
    .refine(
      (value) =>
        (MODERATION_STATUSES as readonly string[]).includes(value) ||
        (SUBMISSION_STATUSES as readonly string[]).includes(value),
      'סטטוס לא מוכר',
    ),
  adminNote: z.string().max(2_000).optional(),
});

// ---------------------------------------------------------------- Handlers

/** `GET /api/admin/overview` — the dashboard. */
async function overview(context: RequestContext): Promise<Response> {
  requireStaff(context);

  const [counters, inbox, activity, zeroResults] = await Promise.all([
    admin(context).overview(),
    context.repositories.engagement.openCounts(),
    admin(context).recentActivity(15),
    context.repositories.search.zeroResultSearches(isoDaysAgo(30), 10),
  ]);

  return ok({ counters, inbox, activity, zeroResults });
}

/** `GET /api/admin/videos` — the videos table. */
async function listVideos(context: RequestContext): Promise<Response> {
  requireStaff(context);
  const params = context.url.searchParams;

  const page = await admin(context).listVideos({
    q: params.get('q') ?? undefined,
    status: params.get('status') ?? undefined,
    category: params.get('category') ?? undefined,
    channel: params.get('channel') ?? undefined,
    hasReports: params.get('hasReports') === '1',
    missingMetadata: params.get('missingMetadata') === '1',
    page: Number(params.get('page') ?? 1),
    limit: Number(params.get('limit') ?? 50),
  });

  return okList(
    page.items.map((row) => ({
      ...row,
      tags: AdminRepository.tagsOf(row),
      isFeatured: row.isFeatured === 1,
      isHebrew: row.isHebrew === 1,
    })),
    page.meta,
  );
}

/**
 * Rebuild the search index for videos an editor just changed.
 *
 * `videos_fts` is a standalone table, not an external-content one, so nothing
 * updates it automatically. Before this existed an editor could rename a video
 * and the site would show the new title while search kept matching the old one
 * — forever, because nothing else ever rewrites the row.
 *
 * Awaited, unlike the counter refresh. A stale counter is a number being one
 * out for an hour; a stale index is a video that cannot be found by its own
 * title, and the editor who just renamed it is the person most likely to search
 * for it a moment later.
 */
async function reindex(context: RequestContext, ids: readonly string[]): Promise<void> {
  await context.repositories.searchIndex.reindex(ids);

  // Drop the cached copies of the videos that changed. Best effort and
  // colo-local — see `purgeVideo` — but it is what makes an editor's own
  // "did that work?" check immediate instead of a five-minute wait.
  context.waitUntil(Promise.all(ids.map((id) => purgeVideo(id, context.env.CACHE_VERSION ?? '1'))));
}

/**
 * Recompute the maintained counters after a write that could have moved one.
 *
 * Changing a video's status or category changes what `categories.video_count`,
 * `tags.video_count` and `catalog_counters` should say, and an editor who
 * publishes twenty videos and then sees the old number on the home page has no
 * way to tell whether their change landed.
 *
 * Not awaited: the refresh takes about 200ms on the full catalog, the editor is
 * waiting on this response, and the hourly cron corrects a failed one. This is
 * a freshness improvement over the cron, never the thing correctness rests on.
 */
function refreshCounters(context: RequestContext): void {
  context.waitUntil(context.repositories.counters.refreshAll());
}

/** `PATCH /api/admin/videos/:id`. */
async function updateVideo(
  context: RequestContext,
  params: Record<string, string>,
): Promise<Response> {
  const identity = requireStaff(context, ['admin', 'editor']);
  const id = params.id;
  if (id?.length !== 11) throw new BadRequestError('מזהה הסרטון אינו תקין');

  const body = parseOrThrow(videoPatchSchema, await context.readJson());
  const updated = await admin(context).updateVideo(id, body, identity.userId);
  if (!updated) throw new NotFoundError('הסרטון לא נמצא');

  await reindex(context, [id]);
  refreshCounters(context);
  return ok({ id, updated: true });
}

/** `POST /api/admin/videos/bulk` — apply one change to many videos. */
async function bulkUpdate(context: RequestContext): Promise<Response> {
  const identity = requireStaff(context, ['admin', 'editor']);
  const body = parseOrThrow(bulkSchema, await context.readJson());

  const changed = await admin(context).bulkUpdate(body.ids, body.patch, identity.userId);
  await reindex(context, body.ids);
  refreshCounters(context);
  return ok({ changed });
}

/** `POST /api/admin/videos/tags` — add or remove a tag across a selection. */
async function bulkTags(context: RequestContext): Promise<Response> {
  const identity = requireStaff(context, ['admin', 'editor']);
  const body = parseOrThrow(tagSchema, await context.readJson());
  const remove = context.url.searchParams.get('mode') === 'remove';

  const changed = remove
    ? await admin(context).removeTag(body.ids, body.tag, identity.userId)
    : await admin(context).addTag(body.ids, body.tag, identity.userId);

  await reindex(context, body.ids);
  refreshCounters(context);
  return ok({ changed });
}

/** `POST /api/admin/videos/delete` and `/restore` — reversible removal. */
async function deleteVideos(context: RequestContext): Promise<Response> {
  const identity = requireStaff(context, ['admin', 'editor']);
  const body = parseOrThrow(idsSchema, await context.readJson());
  const restore = context.url.searchParams.get('mode') === 'restore';

  const changed = restore
    ? await admin(context).restore(body.ids, identity.userId)
    : await admin(context).softDelete(body.ids, identity.userId);

  await reindex(context, body.ids);
  refreshCounters(context);
  return ok({ changed, restored: restore });
}

/** The four inboxes share one handler; the table comes from the path. */
const INBOXES = {
  reports: 'video_reports',
  feedback: 'video_feedback',
  submissions: 'video_submissions',
  contact: 'contact_threads',
} as const;

type InboxName = keyof typeof INBOXES;

function inboxName(value: string | undefined): InboxName {
  if (value == null || !(value in INBOXES)) throw new NotFoundError('תיבה לא מוכרת');
  return value as InboxName;
}

/** `GET /api/admin/inbox/:name`. */
async function listInbox(
  context: RequestContext,
  params: Record<string, string>,
): Promise<Response> {
  requireStaff(context);
  const name = inboxName(params.name);
  const repository = context.repositories.engagement;
  const options = {
    status: context.url.searchParams.get('status') ?? undefined,
    page: Number(context.url.searchParams.get('page') ?? 1),
  };

  const page =
    name === 'reports'
      ? await repository.listReports(options)
      : name === 'feedback'
        ? await repository.listFeedback(options)
        : name === 'submissions'
          ? await repository.listSubmissions(options)
          : await repository.listContactThreads(options);

  return okList(page.items, page.meta);
}

/** `PATCH /api/admin/inbox/:name/:id` — move an item along its workflow. */
async function updateInboxItem(
  context: RequestContext,
  params: Record<string, string>,
): Promise<Response> {
  const identity = requireStaff(context);
  const name = inboxName(params.name);
  const id = params.id;
  if (id == null) throw new BadRequestError('מזהה חסר');

  const body = parseOrThrow(moderationSchema, await context.readJson());
  const updated = await context.repositories.engagement.updateStatus(
    INBOXES[name],
    id,
    body.status,
    body.adminNote ?? '',
    identity.userId,
  );

  if (!updated) throw new NotFoundError('הפריט לא נמצא');
  return ok({ id, status: body.status });
}

/** `GET /api/admin/search-insights` — what people look for and do not find. */
async function searchInsights(context: RequestContext): Promise<Response> {
  requireStaff(context);
  const since = isoDaysAgo(Number(context.url.searchParams.get('days') ?? 30));

  const [zeroResults, popular] = await Promise.all([
    context.repositories.search.zeroResultSearches(since, 50),
    context.repositories.search.popularSearches(since, 25),
  ]);

  return ok({ zeroResults, popular, since });
}

/** `GET /api/admin/session` — "is this token valid?", for the login screen. */
function session(context: RequestContext): Response {
  const identity = requireStaff(context);
  return ok({ displayName: identity.displayName, roles: identity.roles });
}

/**
 * `GET /api/admin/maintenance` — is the link checker alive, and what has it
 * found? A cron job nobody can see is a cron job nobody notices has stopped.
 */
async function maintenanceStatus(context: RequestContext): Promise<Response> {
  requireStaff(context, ['admin', 'editor']);

  const [coverage, runs] = await Promise.all([
    context.repositories.maintenance.checkCoverage(),
    context.repositories.maintenance.recentRuns(),
  ]);

  return ok({ coverage, runs }, {}, { cache: CACHE.none });
}

/**
 * `POST /api/admin/counters/refresh` — recompute the maintained counters now.
 *
 * The numbers the site shows — videos per category, per tag, per channel, and
 * the hero totals — are stored columns refreshed hourly by the cron, after an
 * import, and after an admin write. This endpoint is the fourth way, and it
 * exists for two moments:
 *
 *  * **After a first deploy.** A database that has been migrated and had its
 *    catalog imported by `scripts/import-catalog.ts` has every counter at zero
 *    until the cron first runs. The site works, but it looks empty. One call
 *    here fixes that in about 200ms.
 *  * **When an editor thinks a number is wrong.** Being able to say "press
 *    this and see" is worth more than an explanation of the refresh schedule.
 *
 * Separate from `maintenance/run` on purpose: that one also probes a couple of
 * hundred YouTube links, which is far too heavy for "make the counts right".
 */
async function refreshCountersNow(context: RequestContext): Promise<Response> {
  requireStaff(context, ['admin', 'editor']);

  const report = await context.repositories.counters.refreshAll();
  return ok(report, {}, { cache: CACHE.none });
}

/**
 * `GET /api/admin/resources` — how close is this database to its plan limit?
 *
 * The site runs on Cloudflare's free plan: 500 MB in one D1 database, and
 * 5,000,000 rows read a day. The catalog itself is 18 MiB and barely moves, so
 * the only way to reach 500 MB is a table that grows with traffic — search
 * logs, the audit trail, watch history — quietly, over months.
 *
 * That is precisely the failure mode nobody notices until a write starts
 * failing, which is why it gets a screen. The row counts come from the daily
 * samples the cron records; the byte estimate multiplies them by the measured
 * average in `docs/performance.md`, because D1 reports its own size through the
 * Cloudflare API and not through SQL — a Worker cannot ask how big it is.
 *
 * The estimate is labelled as one. It is meant to answer "are we at 4% or 40%?"
 * and it does that well; it is not an audit.
 */
async function resourceStatus(context: RequestContext): Promise<Response> {
  requireStaff(context, ['admin', 'editor']);

  const [growth, refreshedAt] = await Promise.all([
    context.repositories.counters.growth(),
    context.repositories.counters.lastRefreshedAt(),
  ]);

  const tables = growth.map((sample) => ({
    ...sample,
    estimatedBytes: sample.rows * bytesPerRow(sample.table),
    /** Rows added in the last thirty days, or `null` without enough history. */
    growthPerMonth:
      sample.rowsThirtyDaysAgo == null ? null : sample.rows - sample.rowsThirtyDaysAgo,
  }));

  const estimatedBytes = tables.reduce((sum, table) => sum + table.estimatedBytes, 0);
  const growthPerMonth = tables.reduce(
    (sum, table) => sum + Math.max(0, table.growthPerMonth ?? 0) * bytesPerRow(table.table),
    0,
  );

  // Worker requests, the constraint that now binds first. Not measured — see
  // PAGE_REQUEST_COST for why counting them in D1 would be self-defeating.
  // This is arithmetic on constants, and it answers the only question anyone
  // asks of it: how many visitors a day does this plan hold?
  const perVisitor = TYPICAL_VISIT_REQUESTS;

  return ok(
    {
      requests: {
        limitPerDay: PLAN_LIMITS.workerRequestsPerDay,
        perVisitor,
        /** Visitors a day at that mix before the request cap is reached. */
        visitorsPerDay: Math.floor(PLAN_LIMITS.workerRequestsPerDay / perVisitor),
        pageCosts: PAGE_REQUEST_COST,
      },
      database: {
        estimatedBytes,
        limitBytes: PLAN_LIMITS.databaseBytes,
        usedFraction: estimatedBytes / PLAN_LIMITS.databaseBytes,
        /**
         * Months until the limit at the current rate, or `null` when nothing is
         * growing. This is the number worth looking at: a database at 4% that
         * doubles every month is in more trouble than one at 40% that is flat.
         */
        monthsToLimit:
          growthPerMonth <= 0
            ? null
            : Math.max(0, (PLAN_LIMITS.databaseBytes - estimatedBytes) / growthPerMonth),
      },
      tables,
      counters: { lastRefreshedAt: refreshedAt },
      retention: RETENTION,
      limits: PLAN_LIMITS,
    },
    {},
    { cache: CACHE.none },
  );
}

/**
 * Average bytes per row, measured against the real 7,876-video catalog with
 * SQLite's `dbstat` (see `docs/performance.md`). Table data and its indexes
 * together, which is what counts against the limit.
 *
 * These are estimates and are used only to draw a progress bar. A table not
 * listed gets a deliberately pessimistic default: over-reporting prompts a look
 * at the dashboard, under-reporting hides a problem.
 */
function bytesPerRow(table: string): number {
  return BYTES_PER_ROW[table] ?? 400;
}

const BYTES_PER_ROW: Readonly<Record<string, number>> = {
  // 3,640 KiB of table plus ~1,100 KiB of indexes over 7,876 rows.
  videos: 620,
  // 1,240 KiB plus two indexes of ~1,450 KiB each over 59,255 rows.
  video_tags: 72,
  tags: 90,
  channels: 260,
  // Query text plus its normalised form, and two indexes.
  search_logs: 180,
  // Two JSON snapshots of a video row.
  admin_audit_log: 900,
  watch_history: 90,
  favorites: 70,
  sessions: 200,
  rate_limits: 60,
  import_job_errors: 300,
  maintenance_runs: 80,
};

/**
 * `POST /api/admin/maintenance/run` — run it now.
 *
 * Useful after an import, and the only way to test the job without waiting an
 * hour. Admin only: it makes a couple of hundred outbound requests.
 */
async function runMaintenance(context: RequestContext): Promise<Response> {
  requireStaff(context, ['admin']);

  const service = new MaintenanceService(
    context.repositories.maintenance,
    context.repositories.counters,
    context.logger,
  );
  const report = await service.run(context.env);

  return ok(report, {}, { cache: CACHE.none });
}

export const adminRoutes: RouteDefinition[] = [
  get('/api/admin/session', session),
  get('/api/admin/overview', overview),

  get('/api/admin/videos', listVideos),
  patch('/api/admin/videos/:id', updateVideo),
  post('/api/admin/videos/bulk', bulkUpdate),
  post('/api/admin/videos/tags', bulkTags),
  post('/api/admin/videos/delete', deleteVideos),

  get('/api/admin/inbox/:name', listInbox),
  patch('/api/admin/inbox/:name/:id', updateInboxItem),

  get('/api/admin/maintenance', maintenanceStatus),
  get('/api/admin/resources', resourceStatus),
  post('/api/admin/counters/refresh', refreshCountersNow),
  post('/api/admin/maintenance/run', runMaintenance),

  get('/api/admin/search-insights', searchInsights),
];

/** Video statuses, exported so the admin UI does not hard-code them. */
export const videoStatuses: readonly VideoStatus[] = VIDEO_STATUSES;
