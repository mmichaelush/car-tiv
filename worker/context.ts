/**
 * The per-request context handed to every route.
 *
 * A route never receives the raw `Env`: it receives this object, which already
 * carries the parsed URL, a request-scoped logger, the feature flags and lazily
 * constructed repositories. That keeps route bodies short and makes them easy
 * to test — a fake context is a plain object.
 */

import type { ExecutionContext } from '@cloudflare/workers-types';
import { MAX_REQUEST_BODY_BYTES } from '@shared/constants.js';
import type { Env, FeatureFlags } from './env.js';
import { readFeatureFlags } from './env.js';
import { PayloadTooLargeError, BadRequestError } from './lib/errors.js';
import { createLogger, silentLogger, type Logger } from './lib/logger.js';
import { fingerprint, requestId } from './lib/crypto.js';
import { CatalogRepository } from './repositories/catalog-repository.js';
import { VideoRepository } from './repositories/video-repository.js';
import { SearchRepository } from './repositories/search-repository.js';
import { EngagementRepository } from './repositories/engagement-repository.js';
import { RateLimitRepository } from './repositories/rate-limit-repository.js';
import { AccountRepository, type Account } from './repositories/account-repository.js';
import { LibraryRepository } from './repositories/library-repository.js';
import { ImportRepository } from './repositories/import-repository.js';
import { MaintenanceRepository } from './repositories/maintenance-repository.js';
import { CountersRepository } from './repositories/counters-repository.js';
import { SearchIndexRepository } from './repositories/search-index-repository.js';
import { SESSION_COOKIE, readCookie } from './lib/cookies.js';

export interface Repositories {
  readonly videos: VideoRepository;
  readonly catalog: CatalogRepository;
  readonly search: SearchRepository;
  readonly engagement: EngagementRepository;
  readonly rateLimits: RateLimitRepository;
  readonly accounts: AccountRepository;
  readonly library: LibraryRepository;
  readonly imports: ImportRepository;
  readonly maintenance: MaintenanceRepository;
  readonly counters: CountersRepository;
  readonly searchIndex: SearchIndexRepository;
}

export interface RequestContext {
  readonly request: Request;
  readonly env: Env;
  readonly url: URL;
  readonly logger: Logger;
  readonly flags: FeatureFlags;
  readonly repositories: Repositories;
  /** Correlation id, echoed back in the `x-request-id` header. */
  readonly requestId: string;
  /**
   * The signed-in visitor, or `null`.
   *
   * Resolved once per request in `worker/index.ts` before any route runs, and
   * only when a session cookie is actually present — anonymous traffic, which
   * is nearly all of it, costs no query. Routes read it synchronously.
   */
  account: Account | null;
  /**
   * Run work after the response has been sent — search logging, counters.
   * Anything passed here must be non-essential: its failure is invisible.
   */
  waitUntil(work: Promise<unknown>): void;
  /** Salted hash of the caller, for rate limiting. Computed on first use. */
  callerFingerprint(): Promise<string>;
  /** Parse and size-check a JSON body. Throws `BadRequestError` on bad JSON. */
  readJson<T>(): Promise<T>;
}

/**
 * The salt for caller fingerprints.
 *
 * `SESSION_SECRET` is the right value and is required in production. When it is
 * missing this falls back to something deployment-specific rather than to the
 * environment name, so a forgotten secret degrades to "weaker" instead of to
 * "publicly known".
 */
function fingerprintSalt(env: Env): string {
  const secret = env.SESSION_SECRET ?? '';
  if (secret.length > 0) return secret;
  return `${env.ENVIRONMENT}:${env.APP_URL}:car-tiv-fingerprint`;
}

export function createContext(
  request: Request,
  env: Env,
  executionContext: Pick<ExecutionContext, 'waitUntil'>,
): RequestContext {
  const url = new URL(request.url);
  const id = requestId(request);
  const logger =
    env.ENVIRONMENT === 'test'
      ? silentLogger
      : createLogger(
          { requestId: id, method: request.method, path: url.pathname },
          env.ENVIRONMENT === 'production' ? 'info' : 'debug',
        );

  const repositories: Repositories = {
    videos: new VideoRepository(env.DB),
    catalog: new CatalogRepository(env.DB),
    search: new SearchRepository(env.DB),
    engagement: new EngagementRepository(env.DB),
    rateLimits: new RateLimitRepository(env.DB),
    accounts: new AccountRepository(env.DB),
    library: new LibraryRepository(env.DB),
    imports: new ImportRepository(env.DB),
    maintenance: new MaintenanceRepository(env.DB),
    counters: new CountersRepository(env.DB),
    searchIndex: new SearchIndexRepository(env.DB),
  };

  let cachedFingerprint: Promise<string> | null = null;

  return {
    request,
    env,
    url,
    logger,
    flags: readFeatureFlags(env),
    repositories,
    requestId: id,
    account: null,

    waitUntil(work: Promise<unknown>): void {
      executionContext.waitUntil(
        work.catch((cause: unknown) => {
          logger.warn('Background work failed', {
            error: cause instanceof Error ? cause.message : String(cause),
          });
        }),
      );
    },

    callerFingerprint(): Promise<string> {
      // The salt is what makes a caller's hash non-reversible. Falling back to
      // `env.ENVIRONMENT` meant that on a deployment where `SESSION_SECRET` was
      // never set, the salt was the literal string "production" — public, and
      // therefore no salt at all: anyone could compute the key for any IP and
      // forge or enumerate rate-limit buckets. An empty secret was used
      // verbatim for the same reason (`??` only catches `undefined`).
      //
      // A per-deployment constant is still not a secret, but it is at least not
      // a guessable one, and `deployment.md` lists SESSION_SECRET as required.
      cachedFingerprint ??= fingerprint(request, fingerprintSalt(env));
      return cachedFingerprint;
    },

    async readJson<T>(): Promise<T> {
      const declared = Number(request.headers.get('content-length') ?? '0');
      if (declared > MAX_REQUEST_BODY_BYTES) throw new PayloadTooLargeError();

      const text = await request.text();
      if (text.length > MAX_REQUEST_BODY_BYTES) throw new PayloadTooLargeError();

      try {
        return JSON.parse(text) as T;
      } catch {
        throw new BadRequestError('גוף הבקשה אינו JSON תקין');
      }
    },
  };
}

/**
 * Populate `context.account` from the session cookie.
 *
 * A bad or expired cookie leaves the visitor anonymous rather than failing the
 * request: an expired session should look like being logged out, not like an
 * error. A database failure does the same, so an outage of the accounts tables
 * cannot take the public catalog down with it.
 */
export async function resolveAccount(context: RequestContext): Promise<void> {
  if (!context.flags.accounts) return;

  const token = readCookie(context.request, SESSION_COOKIE);
  if (token == null || token.length === 0) return;

  try {
    context.account = await context.repositories.accounts.findBySessionToken(token);
  } catch (cause) {
    context.logger.warn('Session lookup failed', {
      error: cause instanceof Error ? cause.message : String(cause),
    });
  }
}
