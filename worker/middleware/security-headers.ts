/**
 * Security headers.
 *
 * Applied to every HTML document the Worker serves. The Content-Security-Policy
 * is written as data rather than a string so each directive can carry a comment
 * explaining why a host is on the list — an allowlist nobody can explain is an
 * allowlist that only grows.
 */

import type { Env } from '../env.js';

/**
 * Hosts the site legitimately needs.
 *
 * `img-src` covers the two YouTube CDNs: `i.ytimg.com` for video thumbnails and
 * `yt3.googleusercontent.com` for channel avatars. `frame-src` is the embedded
 * player, loaded from the no-cookie domain and only after the visitor presses
 * play.
 */
const CSP_DIRECTIVES: Readonly<Record<string, readonly string[]>> = {
  'default-src': ["'self'"],
  // Google Tag Manager, loaded from `src/app/bootstrap.ts` only when a
  // container id was configured at build time. `dataLayer` is initialised from
  // our own module, which is what keeps `'unsafe-inline'` off this directive.
  'script-src': ["'self'", 'https://www.googletagmanager.com'],
  'style-src': ["'self'", "'unsafe-inline'"],
  'img-src': [
    "'self'",
    'data:',
    'https://i.ytimg.com',
    'https://yt3.googleusercontent.com',
    'https://*.ggpht.com',
    // The Netfree mark shown beside the "filtered and open on Netfree" note,
    // hotlinked from Netfree's own wiki exactly as the legacy site did.
    'https://netfree.link',
  ],
  'font-src': ["'self'"],
  // Same story as `script-src`: analytics beacons, and nothing else.
  'connect-src': [
    "'self'",
    'https://www.googletagmanager.com',
    'https://www.google-analytics.com',
    'https://*.analytics.google.com',
  ],
  'frame-src': ['https://www.youtube-nocookie.com', 'https://www.youtube.com'],
  'media-src': ["'self'"],
  'object-src': ["'none'"],
  'base-uri': ["'self'"],
  'form-action': ["'self'"],
  'frame-ancestors': ["'none'"],
  'upgrade-insecure-requests': [],
};

function buildCsp(): string {
  return Object.entries(CSP_DIRECTIVES)
    .map(([directive, values]) =>
      values.length === 0 ? directive : `${directive} ${values.join(' ')}`,
    )
    .join('; ');
}

const CSP = buildCsp();

/**
 * Copy a response and add the security headers.
 *
 * `upgrade-insecure-requests` is dropped in development, where the site is
 * served over plain HTTP from localhost.
 */
export function withSecurityHeaders(response: Response, env: Env): Response {
  const headers = new Headers(response.headers);

  headers.set(
    'content-security-policy',
    env.ENVIRONMENT === 'development' ? CSP.replace('; upgrade-insecure-requests', '') : CSP,
  );
  headers.set('x-content-type-options', 'nosniff');
  headers.set('referrer-policy', 'strict-origin-when-cross-origin');
  headers.set('x-frame-options', 'DENY');
  headers.set(
    'permissions-policy',
    'accelerometer=(), camera=(), geolocation=(), microphone=(), payment=(), usb=()',
  );

  if (env.ENVIRONMENT !== 'development') {
    headers.set('strict-transport-security', 'max-age=31536000; includeSubDomains');
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
