/**
 * Driving the Worker's `fetch` handler from a test.
 *
 * Gives the handler a real database (see `d1.ts`), a stub asset server and an
 * execution context whose `waitUntil` work is awaited, so background writes such
 * as the search log are observable instead of racing the assertion.
 */

import worker from '@worker/index.js';
import type { Env } from '@worker/env.js';
import type { TestDatabase } from './d1.js';

export interface TestWorker {
  /** Send a request and get the response. */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /** Send a request and parse the JSON envelope. */
  json<T = unknown>(path: string, init?: RequestInit): Promise<{ status: number; body: T }>;
  /** Resolve every `waitUntil` promise queued so far. */
  drain(): Promise<void>;
  /** Paths requested from the (stubbed) static asset server. */
  readonly assetRequests: string[];
}

export const TEST_ORIGIN = 'https://car-tiv.test';

export function createTestWorker(db: TestDatabase, overrides: Partial<Env> = {}): TestWorker {
  const assetRequests: string[] = [];
  const pending: Promise<unknown>[] = [];

  const env: Env = {
    DB: db,
    ASSETS: {
      fetch: (input: RequestInfo | URL) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        assetRequests.push(new URL(url).pathname);
        return Promise.resolve(
          new Response('<!doctype html><title>stub</title>', {
            headers: { 'content-type': 'text/html; charset=utf-8' },
          }),
        );
      },
    } as unknown as Fetcher,
    // `test` silences the request logger, so a failing assertion is not buried
    // in a hundred lines of structured log output.
    ENVIRONMENT: 'test',
    APP_URL: TEST_ORIGIN,
    STATIC_CATALOG_MODE: 'false',
    FEATURE_ACCOUNTS: 'false',
    FEATURE_PLAYLISTS: 'true',
    FEATURE_MY_CAR: 'true',
    FEATURE_RECOMMENDATIONS: 'true',
    FEATURE_ADMIN: 'true',
    ...overrides,
  };

  const executionContext = {
    waitUntil: (work: Promise<unknown>) => {
      pending.push(work);
    },
    passThroughOnException: () => undefined,
    props: {},
  } as unknown as ExecutionContext;

  const send = (path: string, init: RequestInit = {}): Promise<Response> => {
    const request = new Request(new URL(path, TEST_ORIGIN), {
      // Same-origin by default; a test that checks the origin guard overrides it.
      headers: { origin: TEST_ORIGIN, ...(init.headers as Record<string, string> | undefined) },
      ...init,
    });
    return worker.fetch(request, env, executionContext);
  };

  return {
    fetch: send,
    async json<T>(path: string, init?: RequestInit) {
      const response = await send(path, init);
      return { status: response.status, body: (await response.json()) as T };
    },
    async drain() {
      await Promise.allSettled(pending.splice(0, pending.length));
    },
    assetRequests,
  };
}

/** Build a JSON POST init object. */
export function postJson(body: unknown, headers: Record<string, string> = {}): RequestInit {
  const payload = JSON.stringify(body);
  return {
    method: 'POST',
    body: payload,
    headers: {
      'content-type': 'application/json',
      'content-length': String(new TextEncoder().encode(payload).length),
      ...headers,
    },
  };
}
