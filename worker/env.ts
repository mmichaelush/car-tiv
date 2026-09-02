/**
 * Worker bindings and environment variables.
 *
 * Everything the Worker is allowed to reach from the outside world is declared
 * here. Adding a binding means adding it to `wrangler.jsonc` *and* to this type,
 * so a missing binding is a compile error rather than a runtime `undefined`.
 *
 * Secrets are never listed with a default and never logged. They arrive through
 * `wrangler secret put` and appear on this type as optional strings.
 */

import type { D1Database, Fetcher } from '@cloudflare/workers-types';

/**
 * Values of the `ENVIRONMENT` variable.
 * `test` is used only by the automated tests, where logging is silenced.
 */
export type EnvironmentName = 'development' | 'test' | 'staging' | 'production';

export interface Env {
  // --- Bindings -----------------------------------------------------------
  /** The catalog database. Only `worker/repositories` may touch it. */
  readonly DB: D1Database;
  /** The built front-end in `dist/`, served for everything that is not `/api`. */
  readonly ASSETS: Fetcher;

  // --- Plain variables ----------------------------------------------------
  readonly ENVIRONMENT: EnvironmentName;
  /** Canonical origin, used for redirects, canonical URLs and the sitemap. */
  readonly APP_URL: string;
  /** `"true"` serves the catalog from static snapshots instead of D1. */
  readonly STATIC_CATALOG_MODE: string;
  /**
   * Salt in every edge-cache key. Changing it in the Cloudflare dashboard
   * invalidates every cached API response at once, with no purge API and no
   * deployment — the escape hatch for the day a wrong answer is cached.
   * Optional: absent means `"1"`.
   */
  readonly CACHE_VERSION?: string;

  readonly FEATURE_ACCOUNTS: string;
  readonly FEATURE_PLAYLISTS: string;
  readonly FEATURE_MY_CAR: string;
  readonly FEATURE_RECOMMENDATIONS: string;
  readonly FEATURE_ADMIN: string;

  // --- Secrets (optional; absent until `wrangler secret put` is run) -------
  /** Shared secret protecting `/api/admin/*` until real accounts ship. */
  readonly ADMIN_TOKEN?: string;
  /** Signing key for session cookies. */
  readonly SESSION_SECRET?: string;
  /**
   * Google OAuth client. Both must be present for sign-in to be offered; the
   * client id is public (it appears in the redirect URL), the secret is not and
   * never leaves the Worker.
   */
  readonly GOOGLE_CLIENT_ID?: string;
  readonly GOOGLE_CLIENT_SECRET?: string;
}

/** Parse a `"true"` / `"false"` environment variable. */
export function envFlag(value: string | undefined): boolean {
  return value === 'true' || value === '1';
}

/**
 * The origin this deployment answers on.
 *
 * `APP_URL` is not decoration. It builds the Google OAuth redirect URI — which
 * has to match what is registered in Google Cloud character for character — and
 * every absolute URL in the sitemap. Get it wrong and sign-in fails and search
 * engines are handed a hostname that does not exist, while the site itself
 * keeps loading perfectly, so nothing draws attention to it.
 *
 * The config ships with a placeholder rather than a guess, because a
 * workers.dev address contains the account's own subdomain
 * (`<worker>.<subdomain>.workers.dev`) and no default can be correct. This
 * function makes an unreplaced placeholder harmless: it falls back to the
 * origin the request actually arrived on, which is right in every case except
 * a Worker sitting behind a proxy under a different name.
 *
 * @param requestOrigin  The origin of the incoming request.
 */
export function appOrigin(env: Env, requestOrigin: string): string {
  const configured = (env.APP_URL ?? '').trim().replace(/\/+$/, '');
  if (configured.length === 0 || isPlaceholder(configured)) return requestOrigin;
  return configured;
}

/** Whether a value is still the placeholder shipped in `wrangler.jsonc`. */
export function isPlaceholder(value: string): boolean {
  return value.includes('REPLACE_WITH');
}

/** Feature flags derived from the environment, before any database override. */
export interface FeatureFlags {
  readonly accounts: boolean;
  readonly playlists: boolean;
  readonly myCar: boolean;
  readonly recommendations: boolean;
  readonly admin: boolean;
  readonly staticCatalog: boolean;
}

export function readFeatureFlags(env: Env): FeatureFlags {
  return {
    accounts: envFlag(env.FEATURE_ACCOUNTS),
    playlists: envFlag(env.FEATURE_PLAYLISTS),
    myCar: envFlag(env.FEATURE_MY_CAR),
    recommendations: envFlag(env.FEATURE_RECOMMENDATIONS),
    admin: envFlag(env.FEATURE_ADMIN),
    staticCatalog: envFlag(env.STATIC_CATALOG_MODE),
  };
}

export const isProduction = (env: Env): boolean => env.ENVIRONMENT === 'production';
