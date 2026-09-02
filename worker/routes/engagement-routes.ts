/**
 * Endpoints that accept input from a visitor.
 *
 * Every one of them follows the same four steps, in this order:
 *   1. same-origin check — these forms are only ever posted from our own pages;
 *   2. rate limit, charged against a salted hash of the caller;
 *   3. schema validation, producing per-field Hebrew messages;
 *   4. the write, with duplicate detection where it applies.
 *
 * Getting the order right matters: validation before the rate limit would let
 * an attacker probe the schema for free.
 */

import { REPORT_REASONS } from '@shared/constants.js';
import type { RequestContext } from '../context.js';
import { DuplicateError, ForbiddenError, NotFoundError } from '../lib/errors.js';
import { isUniqueViolation } from '../repositories/base.js';
import { RateLimitedError } from '../lib/errors.js';
import { ok } from '../lib/response.js';
import type { RateLimitedAction } from '../repositories/rate-limit-repository.js';
import { post, type RouteDefinition } from '../router.js';
import {
  contactSchema,
  feedbackSchema,
  parseOrThrow,
  reportSchema,
  submissionSchema,
} from '../schemas/index.js';

/** `POST /api/reports` — a defect report about an existing video. */
async function createReport(context: RequestContext): Promise<Response> {
  const senderHash = await guard(context, 'report');
  const input = parseOrThrow(reportSchema, await context.readJson());

  const exists = await context.repositories.videos.existsAnywhere(input.videoId);
  if (!exists.published) throw new NotFoundError('הסרטון לא נמצא');

  const id = await context.repositories.engagement.createReport({
    videoId: input.videoId,
    reason: input.reason,
    message: input.message,
    contactEmail: input.email,
    senderHash,
  });

  return ok({ id, reason: input.reason }, {}, { status: 201 });
}

/** `POST /api/feedback` — extra information about a video. */
async function createFeedback(context: RequestContext): Promise<Response> {
  const senderHash = await guard(context, 'feedback');
  const input = parseOrThrow(feedbackSchema, await context.readJson());

  const exists = await context.repositories.videos.existsAnywhere(input.videoId);
  if (!exists.published) throw new NotFoundError('הסרטון לא נמצא');

  const id = await context.repositories.engagement.createFeedback({
    videoId: input.videoId,
    message: input.message,
    contactEmail: input.email,
    senderHash,
  });

  return ok({ id }, {}, { status: 201 });
}

/**
 * `POST /api/submissions` — "please add this video".
 *
 * Duplicates are checked twice: once here, for a clear message, and once by the
 * partial unique index in the database, which is what actually guarantees it
 * under concurrent submissions.
 */
async function createSubmission(context: RequestContext): Promise<Response> {
  const senderHash = await guard(context, 'submission');
  const input = parseOrThrow(submissionSchema, await context.readJson());

  const state = await context.repositories.videos.existsAnywhere(input.url);
  if (state.published) throw new DuplicateError('הסרטון כבר נמצא במאגר');
  if (state.pending) throw new DuplicateError('הסרטון כבר ממתין לבדיקה');

  try {
    const id = await context.repositories.engagement.createSubmission({
      youtubeId: input.url,
      youtubeUrl: `https://www.youtube.com/watch?v=${input.url}`,
      title: input.title,
      suggestedCategory: input.category,
      message: input.message,
      submitterName: input.name,
      submitterEmail: input.email,
      senderHash,
    });
    return ok({ id, youtubeId: input.url }, {}, { status: 201 });
  } catch (cause) {
    if (isUniqueViolation(cause)) throw new DuplicateError('הסרטון כבר ממתין לבדיקה');
    throw cause;
  }
}

/** `POST /api/contact` — the general contact form. */
async function createContact(context: RequestContext): Promise<Response> {
  const senderHash = await guard(context, 'contact');
  const input = parseOrThrow(contactSchema, await context.readJson());

  const threadId = await context.repositories.engagement.createContactThread({
    name: input.name,
    email: input.email,
    subject: input.subject,
    message: input.message,
    senderHash,
  });

  return ok({ threadId }, {}, { status: 201 });
}

/**
 * Same-origin check plus rate limit, shared by every write endpoint.
 *
 * @returns The caller's salted fingerprint, ready to store with the row.
 */
async function guard(context: RequestContext, action: RateLimitedAction): Promise<string> {
  const origin = context.request.headers.get('origin');
  if (origin != null && origin !== context.url.origin) {
    throw new ForbiddenError('מקור הבקשה אינו מורשה');
  }

  const fingerprint = await context.callerFingerprint();
  const verdict = await context.repositories.rateLimits.consume(fingerprint, action);
  if (!verdict.allowed) throw new RateLimitedError(verdict.retryAfterSeconds);

  return fingerprint;
}

/** The reasons the report form offers, so the UI does not hard-code them. */
export const reportReasons = REPORT_REASONS;

export const engagementRoutes: RouteDefinition[] = [
  post('/api/reports', createReport),
  post('/api/feedback', createFeedback),
  post('/api/submissions', createSubmission),
  post('/api/contact', createContact),
];
