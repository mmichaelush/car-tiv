/**
 * Typed errors.
 *
 * Route and service code throws these instead of building error responses by
 * hand; `middleware/error-handler.ts` is the single place that turns one into
 * an HTTP response. That keeps the envelope consistent and means an unhandled
 * error can never leak a stack trace or a SQL string to a visitor.
 */

import { ERROR_CODES, type ErrorCode } from '@shared/constants.js';
import type { FieldErrors } from '@shared/types/api.js';

/** Base class for every error the API is willing to describe to a caller. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly fields: FieldErrors | undefined;
  /** Extra detail for the log only. Never serialised into the response. */
  readonly logContext: Record<string, unknown> | undefined;

  constructor(
    status: number,
    code: ErrorCode,
    message: string,
    options: { fields?: FieldErrors; logContext?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.fields = options.fields;
    this.logContext = options.logContext;
  }
}

/** 400 — the request itself is malformed. */
export class BadRequestError extends HttpError {
  constructor(message = 'הבקשה אינה תקינה', code: ErrorCode = ERROR_CODES.badRequest) {
    super(400, code, message);
    this.name = 'BadRequestError';
  }
}

/** 422 — the request is well-formed but the values are not acceptable. */
export class ValidationError extends HttpError {
  constructor(fields: FieldErrors, message = 'יש לתקן את השדות המסומנים') {
    super(422, ERROR_CODES.validation, message, { fields });
    this.name = 'ValidationError';
  }
}

/** 404 — the resource does not exist, or is not visible to this caller. */
export class NotFoundError extends HttpError {
  constructor(message = 'לא נמצא', code: ErrorCode = ERROR_CODES.notFound) {
    super(404, code, message);
    this.name = 'NotFoundError';
  }
}

/** 401 — no credentials, or credentials we do not recognise. */
export class UnauthorizedError extends HttpError {
  constructor(message = 'נדרשת התחברות') {
    super(401, ERROR_CODES.unauthorized, message);
    this.name = 'UnauthorizedError';
  }
}

/** 403 — authenticated, but not allowed to do this. */
export class ForbiddenError extends HttpError {
  constructor(message = 'אין הרשאה לבצע פעולה זו') {
    super(403, ERROR_CODES.forbidden, message);
    this.name = 'ForbiddenError';
  }
}

/** 409 — the resource already exists. */
export class DuplicateError extends HttpError {
  constructor(message = 'הפריט כבר קיים במערכת') {
    super(409, ERROR_CODES.duplicate, message);
    this.name = 'DuplicateError';
  }
}

/** 413 — the body is larger than we are willing to read. */
export class PayloadTooLargeError extends HttpError {
  constructor(message = 'גוף הבקשה גדול מדי') {
    super(413, ERROR_CODES.payloadTooLarge, message);
    this.name = 'PayloadTooLargeError';
  }
}

/** 429 — too many requests in the current window. */
export class RateLimitedError extends HttpError {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number, message = 'נשלחו יותר מדי בקשות. נסו שוב מאוחר יותר') {
    super(429, ERROR_CODES.rateLimited, message);
    this.name = 'RateLimitedError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** 503 — a dependency (currently only D1) is unavailable. */
export class ServiceUnavailableError extends HttpError {
  constructor(
    message = 'השירות אינו זמין כרגע. נסו שוב בעוד רגע',
    options: { cause?: unknown; logContext?: Record<string, unknown> } = {},
  ) {
    super(503, ERROR_CODES.unavailable, message, options);
    this.name = 'ServiceUnavailableError';
  }
}

/** `true` when the value is one of our own errors. */
export function isHttpError(value: unknown): value is HttpError {
  return value instanceof HttpError;
}
