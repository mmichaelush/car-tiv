/**
 * The single place an exception becomes an HTTP response.
 *
 * Route and service code throws; nothing there builds an error response by
 * hand. That guarantees the envelope is consistent, that a 500 never leaks a
 * stack trace or a SQL fragment to a visitor, and that every failure is logged
 * once with the same fields.
 */

import { ERROR_CODES } from '@shared/constants.js';
import { type HttpError, isHttpError } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';
import { fail } from '../lib/response.js';

/**
 * Run `handler`, converting any thrown value into a response.
 *
 * @param logger  Request-scoped logger; the error is logged here, not rethrown.
 */
export async function handleErrors(
  handler: () => Promise<Response>,
  logger: Logger,
): Promise<Response> {
  try {
    return await handler();
  } catch (error) {
    return toResponse(error, logger);
  }
}

function toResponse(error: unknown, logger: Logger): Response {
  if (isHttpError(error)) {
    // 4xx is the caller's problem and is normal traffic; 5xx is ours.
    const level = error.status >= 500 ? 'error' : 'warn';
    logger[level](error.message, {
      status: error.status,
      code: error.code,
      ...error.logContext,
      cause: describeCause(error),
    });

    return fail(error.status, error.code, error.message, {
      fields: error.fields,
      headers: retryHeaders(error),
    });
  }

  logger.error('Unhandled error', {
    status: 500,
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });

  // Deliberately generic: the visitor gets no detail about what broke.
  return fail(500, ERROR_CODES.internal, 'אירעה שגיאה זמנית. נסו שוב בעוד רגע');
}

function retryHeaders(error: HttpError): Record<string, string> | undefined {
  const retryAfter = (error as { retryAfterSeconds?: number }).retryAfterSeconds;
  return retryAfter == null ? undefined : { 'retry-after': String(retryAfter) };
}

function describeCause(error: HttpError): string | undefined {
  const { cause } = error;
  if (cause == null) return undefined;
  if (cause instanceof Error) return cause.message;
  return typeof cause === 'string' ? cause : 'unknown cause';
}
