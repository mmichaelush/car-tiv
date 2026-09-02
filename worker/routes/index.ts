/**
 * The API route table.
 *
 * One file lists every endpoint, so "what does this API expose?" is answered by
 * reading 30 lines rather than by searching for `pathname ===`.
 */

import { ok } from '../lib/response.js';
import { isProduction } from '../env.js';
import { Router, get } from '../router.js';
import { adminRoutes } from './admin-routes.js';
import { importRoutes } from './import-routes.js';
import { authRoutes } from './auth-routes.js';
import { accountRoutes } from './account-routes.js';
import { catalogRoutes } from './catalog-routes.js';
import { engagementRoutes } from './engagement-routes.js';

export const router = new Router();

router.add(
  ...catalogRoutes,
  ...engagementRoutes,
  ...authRoutes,
  ...accountRoutes,
  ...adminRoutes,
  ...importRoutes,

  /**
   * `GET /api` — a machine-readable index, handy in development.
   *
   * In production it returns the name and nothing else. The full version lists
   * every route — including all of `/api/admin/*` — plus the environment name
   * and which feature flags are on, which is a free map of the attack surface
   * handed to anyone who asks. It is genuinely useful while developing, so it
   * is kept there rather than removed.
   */
  get('/api', (context) =>
    ok(
      isProduction(context.env)
        ? { name: 'CAR-טיב API' }
        : {
            name: 'CAR-טיב API',
            environment: context.env.ENVIRONMENT,
            flags: context.flags,
            routes: router.list(),
          },
    ),
  ),

  /** `GET /api/health` — liveness plus a single cheap database probe. */
  get('/api/health', async (context) => {
    const started = Date.now();
    const stats = await context.repositories.catalog.stats();
    return ok({
      status: 'ok',
      environment: context.env.ENVIRONMENT,
      database: { reachable: true, latencyMs: Date.now() - started, videos: stats.videos },
    });
  }),
);
