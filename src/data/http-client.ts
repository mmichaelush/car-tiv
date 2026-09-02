/**
 * The browser's only door to the network.
 *
 * Everything the UI knows about HTTP is here: the envelope is unwrapped, an
 * error becomes a typed `ApiError` with a Hebrew message, GET requests are
 * retried once on a transient failure, and every request can be cancelled.
 *
 * A component never calls `fetch`; it calls a repository, which calls this.
 * An ESLint rule enforces the first half of that sentence.
 */

import { ERROR_CODES, type ErrorCode } from '@shared/constants.js';
import { isApiSuccess } from '@shared/types/api.js';
import type {
  ApiEnvelope,
  ApiFailure,
  ApiSuccess,
  FieldErrors,
  PageMeta,
} from '@shared/types/api.js';

/** A failure the API described, or a network failure we describe ourselves. */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly fields: FieldErrors;

  constructor(
    message: string,
    options: { code?: ErrorCode; status?: number; fields?: FieldErrors } = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = options.code ?? ERROR_CODES.internal;
    this.status = options.status ?? 0;
    this.fields = options.fields ?? {};
  }

  /** `true` when retrying later could plausibly succeed. */
  get isTransient(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }

  /** `true` when the caller should show messages next to form fields. */
  get isValidation(): boolean {
    return this.code === ERROR_CODES.validation;
  }
}

export interface RequestOptions {
  /** Query parameters. `null` and `undefined` values are dropped. */
  readonly params?: Record<string, string | number | boolean | null | undefined>;
  /** JSON body. Presence of a body implies POST unless `method` says otherwise. */
  readonly body?: unknown;
  readonly method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Abort signal, so a superseded search request does not land after a newer one. */
  readonly signal?: AbortSignal;
  /** Retries for a transient failure. GET defaults to 1, writes to 0. */
  readonly retries?: number;
}

/** A page of results, already unwrapped. */
export interface PagedResult<T> {
  readonly items: readonly T[];
  readonly meta: PageMeta;
}

const DEFAULT_TIMEOUT_MS = 12_000;

export class HttpClient {
  readonly #baseUrl: string;

  /** @param baseUrl Prefix for every path. Same-origin `/api` in every environment. */
  constructor(baseUrl = '/api') {
    this.#baseUrl = baseUrl;
  }

  /** Request a single value. */
  async get<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const envelope = await this.#send<T>(path, { ...options, method: 'GET' });
    return envelope.data;
  }

  /** Request a list, keeping its pagination metadata. */
  async getPage<T>(path: string, options: RequestOptions = {}): Promise<PagedResult<T>> {
    const envelope = await this.#send<T[], PageMeta>(path, { ...options, method: 'GET' });
    return { items: envelope.data ?? [], meta: envelope.meta };
  }

  /** Send a write request. */
  async post<T>(path: string, body: unknown, options: RequestOptions = {}): Promise<T> {
    return this.request<T>('POST', path, body, options);
  }

  /**
   * Any write verb.
   *
   * Writes are never retried, whatever the caller asks: a `POST` that timed out
   * may well have been applied, and sending it again would double it.
   */
  async request<T>(
    method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    body: unknown = null,
    options: RequestOptions = {},
  ): Promise<T> {
    const envelope = await this.#send<T>(path, { ...options, method, body, retries: 0 });
    return envelope.data;
  }

  async #send<TData, TMeta = Record<string, unknown>>(
    path: string,
    options: RequestOptions,
  ): Promise<ApiSuccess<TData, TMeta>> {
    const method = options.method ?? 'GET';
    const retries = options.retries ?? (method === 'GET' ? 1 : 0);
    let lastError: ApiError | null = null;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        return await this.#attempt<TData, TMeta>(path, options, method);
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error;
        if (!(error instanceof ApiError) || !error.isTransient) throw error;

        lastError = error;
        // A short, growing pause. Long enough to clear a blip, short enough
        // that the visitor does not notice a retry happened.
        if (attempt < retries) await delay(250 * (attempt + 1));
      }
    }

    throw lastError ?? new ApiError('הבקשה נכשלה');
  }

  async #attempt<TData, TMeta>(
    path: string,
    options: RequestOptions,
    method: string,
  ): Promise<ApiSuccess<TData, TMeta>> {
    const url = new URL(`${this.#baseUrl}${path}`, window.location.origin);
    for (const [key, value] of Object.entries(options.params ?? {})) {
      if (value != null && value !== '') url.searchParams.set(key, String(value));
    }

    // Our own timeout, combined with any signal the caller passed.
    const timeout = AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
    const signal = options.signal == null ? timeout : AbortSignal.any([options.signal, timeout]);

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        signal,
        headers: options.body == null ? {} : { 'content-type': 'application/json' },
        body: options.body == null ? undefined : JSON.stringify(options.body),
      });
    } catch (cause) {
      if (
        cause instanceof DOMException &&
        cause.name === 'AbortError' &&
        options.signal?.aborted === true
      ) {
        throw cause;
      }
      throw new ApiError('אין חיבור לשרת. בדקו את החיבור לאינטרנט ונסו שוב', { status: 0 });
    }

    // The response is read as the union, then narrowed: a caller only ever
    // receives the success shape, because a failure is thrown.
    let envelope: ApiEnvelope<TData, TMeta>;
    try {
      envelope = (await response.json()) as ApiEnvelope<TData, TMeta>;
    } catch {
      throw new ApiError('התקבלה תשובה לא תקינה מהשרת', { status: response.status });
    }

    if (!isApiSuccess(envelope)) {
      // `envelope.error` is typed as present here, but the body came off the
      // wire: a proxy, a CDN error page or a future version of the API could
      // hand us something else entirely, and a `TypeError` on `.message` would
      // surface as "משהו השתבש" with nothing to go on.
      const failure = envelope.error as Partial<ApiFailure['error']> | null | undefined;
      throw new ApiError(failure?.message ?? 'התקבלה תשובה לא תקינה מהשרת', {
        code: failure?.code,
        status: response.status === 200 ? 502 : response.status,
        fields: failure?.fields,
      });
    }

    if (!response.ok) {
      throw new ApiError('הבקשה נכשלה', { status: response.status });
    }

    return envelope;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The shared client. Repositories take one in their constructor for tests. */
export const httpClient = new HttpClient();
