/**
 * Request validation.
 *
 * Every request body is parsed by a schema here before any service sees it, so
 * a route never has to check whether a field exists or is the right type. The
 * messages are Hebrew because they are shown next to the field that failed.
 *
 * Query strings are not validated here: they go through
 * `shared/core/query.ts`, which clamps rather than rejects — a hand-edited URL
 * should degrade to sensible defaults, not return a 422.
 */

import { z } from 'zod';
import { REPORT_REASONS, SEARCH } from '@shared/constants.js';
import { extractVideoId } from '@shared/core/youtube.js';
import { ValidationError } from '../lib/errors.js';
import type { FieldErrors } from '@shared/types/api.js';

/** Trimmed, non-empty text with a maximum length. */
const text = (max: number, message: string) =>
  z
    .string()
    .transform((value) => value.trim())
    .pipe(
      z
        .string()
        .min(1, message)
        .max(max, `הטקסט ארוך מדי (עד ${String(max)} תווים)`),
    );

/** Optional text: an empty string becomes `null`. */
const optionalText = (max: number) =>
  z
    .string()
    .max(max, `הטקסט ארוך מדי (עד ${String(max)} תווים)`)
    .transform((value) => {
      const trimmed = value.trim();
      return trimmed.length === 0 ? null : trimmed;
    })
    .nullish()
    .transform((value) => value ?? null);

const email = z
  .string()
  .trim()
  .email('כתובת האימייל אינה תקינה')
  .max(254, 'כתובת האימייל ארוכה מדי');

const optionalEmail = z
  .union([email, z.literal('')])
  .nullish()
  .transform((value) => (value == null || value === '' ? null : value));

/** An 11-character YouTube id, accepted in any URL form the visitor pastes. */
const youtubeId = z
  .string()
  .trim()
  .min(1, 'יש להזין קישור או מזהה של סרטון')
  .transform((value, context) => {
    const id = extractVideoId(value);
    if (id == null) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'הקישור או המזהה אינם תקינים' });
      return z.NEVER;
    }
    return id;
  });

/** POST /api/reports — "something is wrong with this video". */
export const reportSchema = z.object({
  videoId: youtubeId,
  reason: z.enum(REPORT_REASONS, { errorMap: () => ({ message: 'יש לבחור סיבה' }) }),
  message: optionalText(2_000).transform((value) => value ?? ''),
  email: optionalEmail,
});

export type ReportInput = z.infer<typeof reportSchema>;

/** POST /api/feedback — "here is something you should know about this video". */
export const feedbackSchema = z.object({
  videoId: youtubeId,
  message: text(2_000, 'יש לכתוב את ההערה'),
  email: optionalEmail,
});

export type FeedbackInput = z.infer<typeof feedbackSchema>;

/** POST /api/submissions — "please add this video". */
export const submissionSchema = z.object({
  url: youtubeId,
  title: optionalText(300).transform((value) => value ?? ''),
  category: optionalText(50),
  message: optionalText(1_000).transform((value) => value ?? ''),
  name: optionalText(120).transform((value) => value ?? ''),
  email: optionalEmail,
});

export type SubmissionInput = z.infer<typeof submissionSchema>;

/** POST /api/contact — the general contact form. */
export const contactSchema = z.object({
  name: text(120, 'יש להזין שם'),
  email,
  subject: optionalText(200).transform((value) => value ?? ''),
  message: text(4_000, 'יש לכתוב הודעה'),
  /** The privacy checkbox on the form. */
  acceptedPrivacy: z.literal(true, {
    errorMap: () => ({ message: 'יש לאשר את מדיניות הפרטיות' }),
  }),
});

export type ContactInput = z.infer<typeof contactSchema>;

/** GET /api/search/suggestions — the only query string worth rejecting. */
export const suggestionQuerySchema = z.object({
  q: z.string().trim().min(SEARCH.minQueryLength).max(SEARCH.maxQueryLength),
});

/**
 * Parse with a schema, turning a failure into the API's `ValidationError`.
 *
 * @throws ValidationError with one message per offending field.
 */
export function parseOrThrow<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  value: unknown,
): z.infer<TSchema> {
  const result = schema.safeParse(value);
  if (result.success) return result.data as z.infer<TSchema>;

  const fields: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const key = issue.path.join('.') || '_';
    fields[key] ??= issue.message;
  }
  throw new ValidationError(fields satisfies FieldErrors);
}
