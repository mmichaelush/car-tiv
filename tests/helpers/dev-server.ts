/**
 * The real Worker, the real database, over real HTTP — for looking at the site.
 *
 * `npm run dev` needs `wrangler dev` beside it for the API. This serves the
 * built client from `dist/` and routes every `/api/*` call through the actual
 * Worker entry point, backed by the same `node:sqlite` D1 adapter the tests
 * use, loaded with the real generated catalog when it exists and the test
 * fixture otherwise.
 *
 * It exists because a stubbed API answers whatever the stub was written to
 * answer, which is a good way to prove a bug that is not there and miss one
 * that is. Everything here — the routing, the SQL, the cache middleware, the
 * envelope — is the code that ships.
 *
 *     npx tsx tests/helpers/dev-server.ts          # http://127.0.0.1:4180
 *     npx tsx tests/helpers/dev-server.ts --seed   # small fixture instead
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createTestDatabase, type TestDatabase } from './d1.js';
import { seedCatalog } from './fixtures.js';
import worker from '../../worker/index.js';
import type { Env } from '../../worker/env.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const DIST = path.join(ROOT, 'dist');
const CATALOG = path.join(ROOT, 'build', 'catalog');

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
};

/** Load the generated catalog if it has been built; otherwise the fixture. */
async function database(useFixture: boolean): Promise<TestDatabase> {
  const db = await createTestDatabase();

  if (useFixture || !existsSync(CATALOG)) {
    seedCatalog(db);
    return db;
  }

  const files = readdirSync(CATALOG)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  for (const file of files) await db.exec(readFileSync(path.join(CATALOG, file), 'utf8'));
  return db;
}

function staticFile(pathname: string): { body: Buffer; type: string } | null {
  let file = path.join(DIST, pathname);
  if (existsSync(file) && statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!existsSync(file) || statSync(file).isDirectory()) return null;
  return {
    body: readFileSync(file),
    type: CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream',
  };
}

async function main(): Promise<void> {
  const useFixture = process.argv.includes('--seed');
  const db = await database(useFixture);

  const env = {
    DB: db,
    ASSETS: {
      // The Worker falls back to the asset handler; give it the built file.
      fetch: (input: Request | string) => {
        const url = new URL(typeof input === 'string' ? input : input.url);
        const asset = staticFile(url.pathname) ?? staticFile('/index.html');
        if (asset == null) return Promise.resolve(new Response('not found', { status: 404 }));
        return Promise.resolve(
          new Response(new Uint8Array(asset.body), { headers: { 'content-type': asset.type } }),
        );
      },
    },
    ENVIRONMENT: 'development',
    APP_URL: 'http://127.0.0.1:4180',
    STATIC_CATALOG_MODE: 'false',
    FEATURE_ACCOUNTS: 'true',
    FEATURE_PLAYLISTS: 'true',
    FEATURE_MY_CAR: 'true',
    FEATURE_RECOMMENDATIONS: 'true',
    FEATURE_ADMIN: 'true',
  } as unknown as Env;

  const pending: Promise<unknown>[] = [];
  const executionContext = {
    waitUntil: (work: Promise<unknown>) => pending.push(work),
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext;

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1:4180');

      // Static assets short-circuit; everything else goes through the Worker,
      // exactly as `run_worker_first` arranges in production.
      if (
        !url.pathname.startsWith('/api/') &&
        !url.pathname.startsWith('/sitemap') &&
        url.pathname !== '/robots.txt'
      ) {
        const asset = staticFile(url.pathname);
        if (asset != null) {
          response.writeHead(200, { 'content-type': asset.type });
          response.end(asset.body);
          return;
        }
      }

      const body =
        request.method === 'GET' || request.method === 'HEAD'
          ? undefined
          : await new Promise<string>((resolve) => {
              let text = '';
              request.on('data', (chunk) => (text += String(chunk)));
              request.on('end', () => {
                resolve(text);
              });
            });

      const workerRequest = new Request(url, {
        method: request.method ?? 'GET',
        headers: request.headers as Record<string, string>,
        body,
      });

      const result = await worker.fetch(workerRequest, env, executionContext);
      const headers: Record<string, string> = {};
      result.headers.forEach((value, key) => (headers[key] = value));
      response.writeHead(result.status, headers);
      response.end(new Uint8Array(await result.arrayBuffer()));
    })().catch((cause: unknown) => {
      response.writeHead(500, { 'content-type': 'text/plain' });
      response.end(String(cause));
    });
  });

  await new Promise<void>((resolve) => server.listen(4180, resolve));
  const videos = db.queryRaw<{ n: number }>(`SELECT COUNT(*) AS n FROM videos`)[0]?.n ?? 0;
  console.log(`http://127.0.0.1:4180 — ${String(videos)} videos, real Worker, real SQL`);
}

await main();
