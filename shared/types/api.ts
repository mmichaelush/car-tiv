/**
 * The single response envelope used by every endpoint.
 *
 * Success and failure have the same top-level shape so the client has exactly
 * one code path for reading a response:
 *
 * ```json
 * { "data": ..., "meta": { ... }, "error": null }
 * { "data": null, "meta": {},     "error": { "code": "...", "message": "..." } }
 * ```
 */

import type { ErrorCode } from '../constants.js';

/** Per-field validation messages, keyed by the field name the client sent. */
export type FieldErrors = Readonly<Record<string, string>>;

export interface ApiErrorBody {
  /** Stable machine-readable code. Branch on this, never on `message`. */
  readonly code: ErrorCode;
  /** Hebrew message safe to show to a visitor. */
  readonly message: string;
  /** Present only for `VALIDATION_ERROR`. */
  readonly fields?: FieldErrors;
}

/** Metadata attached to a paginated list. */
export interface PageMeta {
  readonly page: number;
  readonly limit: number;
  readonly total: number;
  readonly pages: number;
  /** Opaque cursor for the next page, when the endpoint supports cursors. */
  readonly nextCursor?: string | null;
}

export interface ApiSuccess<TData, TMeta = Record<string, unknown>> {
  readonly data: TData;
  readonly meta: TMeta;
  readonly error: null;
}

export interface ApiFailure {
  readonly data: null;
  readonly meta: Record<string, unknown>;
  readonly error: ApiErrorBody;
}

export type ApiEnvelope<TData, TMeta = Record<string, unknown>> =
  ApiSuccess<TData, TMeta> | ApiFailure;

/** Convenience alias for the very common "list + page meta" response. */
export type ApiList<TItem> = ApiSuccess<readonly TItem[], PageMeta>;

/** A page of results after the transport envelope has been unwrapped. */
export interface Page<TItem> {
  readonly items: readonly TItem[];
  readonly meta: PageMeta;
}

/** Narrowing helper: `true` when the envelope carries data. */
export function isApiSuccess<TData, TMeta>(
  envelope: ApiEnvelope<TData, TMeta>,
): envelope is ApiSuccess<TData, TMeta> {
  return envelope.error === null;
}
