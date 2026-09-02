/**
 * `/api/admin/imports/*` — bulk import.
 *
 * The Worker never sees the spreadsheet. The admin page parses it, maps its
 * columns and validates each row with the shared functions in
 * `shared/core/import-mapping.ts`; these endpoints take the resulting rows in
 * batches and write them.
 *
 * Every row is validated again here, with those same functions. That is not
 * belt-and-braces for its own sake: the browser is not a trust boundary, and
 * "the preview said it was fine" is not a check.
 */

import { readRow, type ColumnMapping } from '@shared/core/import-mapping.js';
import type { RequestContext } from '../context.js';
import { BadRequestError, NotFoundError } from '../lib/errors.js';
import { CACHE, ok } from '../lib/response.js';
import { get, post, type RouteDefinition, type RouteParams } from '../router.js';
import { requireStaff } from '../middleware/auth.js';
import type { BatchOptions, ImportFormat, ImportRow } from '../repositories/import-repository.js';

/**
 * Rows per batch.
 *
 * Each row costs several small queries, and a Worker request has a CPU budget
 * measured in tens of milliseconds. 100 keeps a batch comfortably inside it
 * while still importing 8,000 videos in eighty requests.
 */
export const IMPORT_BATCH_SIZE = 100;

const FORMATS: readonly ImportFormat[] = ['json', 'csv', 'xlsx', 'youtube-urls'];

/** `GET /api/admin/imports` — recent jobs. */
async function listJobs(context: RequestContext): Promise<Response> {
  requireStaff(context, ['admin', 'editor']);
  const jobs = await context.repositories.imports.listJobs();
  return ok(jobs, { count: jobs.length }, { cache: CACHE.none });
}

/** `GET /api/admin/imports/:id` — one job with its row errors. */
async function getJob(context: RequestContext, params: RouteParams): Promise<Response> {
  requireStaff(context, ['admin', 'editor']);

  const job = await context.repositories.imports.findJob(params.id ?? '');
  if (job == null) throw new NotFoundError('הייבוא לא נמצא');

  const errors = await context.repositories.imports.listErrors(job.id);
  return ok({ job, errors }, {}, { cache: CACHE.none });
}

/** `POST /api/admin/imports` — open a job. Body: filename, format, totalRows, mapping. */
async function createJob(context: RequestContext): Promise<Response> {
  const identity = requireStaff(context, ['admin', 'editor']);

  const body = await context.readJson<{
    filename?: unknown;
    format?: unknown;
    totalRows?: unknown;
    mapping?: unknown;
  }>();

  const format = FORMATS.find((candidate) => candidate === body.format);
  if (format == null) throw new BadRequestError('סוג הקובץ אינו נתמך');

  const id = await context.repositories.imports.createJob(
    typeof body.filename === 'string' ? body.filename : 'import',
    format,
    typeof body.totalRows === 'number' ? Math.max(0, Math.floor(body.totalRows)) : 0,
    body.mapping,
    identity.userId,
  );

  return ok({ id, batchSize: IMPORT_BATCH_SIZE }, {}, { status: 201, cache: CACHE.none });
}

/**
 * `POST /api/admin/imports/:id/rows` — write one batch.
 *
 * Body: `{ rows: [{ rowNumber, values }], mapping, options }`, where `values`
 * is the raw spreadsheet row. Sending raw values rather than a finished draft
 * is what lets the server run the same validation the preview ran.
 */
async function importRows(context: RequestContext, params: RouteParams): Promise<Response> {
  requireStaff(context, ['admin', 'editor']);

  const imports = context.repositories.imports;
  const job = await imports.findJob(params.id ?? '');
  if (job == null) throw new NotFoundError('הייבוא לא נמצא');

  // A finished job is finished.
  //
  // Only the job's existence was checked before, so rows could still be posted
  // to one already marked `completed`, `failed` or `cancelled` — a retry that
  // arrived late, or a second browser tab. The videos would import and the
  // job's counters would keep climbing on a report an editor had already read
  // and closed, which makes the report a record of nothing in particular.
  if (job.status !== 'parsing' && job.status !== 'validated' && job.status !== 'importing') {
    throw new BadRequestError(`הייבוא כבר הסתיים (${job.status}) ואי אפשר להוסיף לו שורות`);
  }

  const body = await context.readJson<{
    rows?: unknown;
    mapping?: unknown;
    options?: unknown;
  }>();

  if (!Array.isArray(body.rows)) throw new BadRequestError('חסרות שורות לייבוא');
  if (body.rows.length > IMPORT_BATCH_SIZE) {
    throw new BadRequestError(`אפשר לשלוח עד ${String(IMPORT_BATCH_SIZE)} שורות בבקשה אחת`);
  }

  const mapping = (body.mapping ?? {}) as ColumnMapping;
  const options = readOptions(body.options);

  const rows: ImportRow[] = [];
  const rejected: { rowNumber: number; field: string; message: string }[] = [];

  for (const entry of body.rows) {
    if (typeof entry !== 'object' || entry == null) continue;

    const { rowNumber, values } = entry as { rowNumber?: unknown; values?: unknown };
    const line = typeof rowNumber === 'number' ? rowNumber : 0;

    if (typeof values !== 'object' || values == null) {
      rejected.push({ rowNumber: line, field: '', message: 'שורה ריקה' });
      continue;
    }

    const result = readRow(values as Record<string, string>, mapping);
    if (result.ok) rows.push({ rowNumber: line, draft: result.draft });
    else {
      for (const problem of result.problems) {
        rejected.push({ rowNumber: line, field: problem.field, message: problem.message });
      }
    }
  }

  await imports.recordRejected(job.id, rejected);
  const outcome = await imports.importBatch(job.id, rows, options);

  return ok({ ...outcome, rejected: rejected.length }, {}, { cache: CACHE.none });
}

/** `POST /api/admin/imports/:id/complete`. */
async function completeJob(context: RequestContext, params: RouteParams): Promise<Response> {
  requireStaff(context, ['admin', 'editor']);

  const imports = context.repositories.imports;
  const jobId = params.id ?? '';

  const body = await context.readJson<{ status?: unknown; message?: unknown }>();
  const status = body.status === 'failed' ? 'failed' : 'completed';

  await imports.completeJob(jobId, status, typeof body.message === 'string' ? body.message : '');

  const job = await imports.findJob(jobId);
  if (job == null) throw new NotFoundError('הייבוא לא נמצא');

  // An import is the largest single change the catalog ever sees, so the
  // maintained counters are recomputed straight away rather than waiting up to
  // an hour for the cron. Importing 500 videos and then seeing the old count on
  // the home page is the kind of thing that makes an editor doubt the import
  // worked at all.
  //
  // `waitUntil`, not `await`: the refresh takes about 200ms on the full
  // catalog, the editor is waiting on this response, and a failed refresh is
  // corrected by the next scheduled run anyway.
  if (status === 'completed') {
    context.waitUntil(context.repositories.counters.refreshAll());
  }

  return ok(job, {}, { cache: CACHE.none });
}

/** Read the batch options, refusing anything the schema cannot store. */
function readOptions(value: unknown): BatchOptions {
  const raw = (typeof value === 'object' && value != null ? value : {}) as Record<string, unknown>;

  const defaultCategoryId = typeof raw.defaultCategoryId === 'string' ? raw.defaultCategoryId : '';
  if (defaultCategoryId.length === 0) {
    throw new BadRequestError('יש לבחור קטגוריית ברירת מחדל לייבוא');
  }

  return {
    updateExisting: raw.updateExisting === true,
    status: raw.status === 'pending' ? 'pending' : 'published',
    defaultCategoryId,
  };
}

export const importRoutes: RouteDefinition[] = [
  get('/api/admin/imports', listJobs),
  post('/api/admin/imports', createJob),
  get('/api/admin/imports/:id', getJob),
  post('/api/admin/imports/:id/rows', importRows),
  post('/api/admin/imports/:id/complete', completeJob),
];
