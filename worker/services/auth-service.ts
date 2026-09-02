/**
 * Signing in with Google.
 *
 * The standard OAuth 2.0 authorization-code flow, run entirely on the server:
 *
 *   1. `/api/auth/google/start` mints a random `state`, puts it in a
 *      short-lived HttpOnly cookie, and redirects to Google.
 *   2. Google sends the visitor back to `/api/auth/google/callback` with a
 *      `code` and the same `state`.
 *   3. We compare the `state` against the cookie — this is what stops another
 *      site from completing a sign-in on someone's behalf — exchange the code
 *      for tokens over a direct TLS call, and read the identity out of the
 *      `id_token`.
 *   4. A session row is written and its token goes into an HttpOnly cookie.
 *
 * The client secret never leaves the Worker, and no token from Google is
 * stored: we take the identity and discard the rest. There is nothing in the
 * database that could be replayed against Google's API.
 */

import { appOrigin } from '../env.js';
import type { Env } from '../env.js';
import { BadRequestError, ServiceUnavailableError, UnauthorizedError } from '../lib/errors.js';
import { decodeIdToken, IdTokenError } from '../lib/oidc.js';
import type { ProviderProfile } from '../repositories/account-repository.js';

const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** How long the visitor has to complete the Google screen. */
export const OAUTH_STATE_TTL_SECONDS = 600;

/** Where a sign-in may return to. Same-origin paths only — never a full URL. */
export function safeReturnPath(candidate: string | null): string {
  if (candidate == null || candidate.length === 0) return '/';
  // A value starting with `//` is a protocol-relative URL to another host, and
  // is the classic open-redirect. Only a single-slash path is accepted.
  if (!candidate.startsWith('/') || candidate.startsWith('//')) return '/';
  return candidate;
}

export interface GoogleConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
}

/**
 * Read the Google configuration, or explain what is missing.
 * @throws ServiceUnavailableError when sign-in is not configured.
 */
export function googleConfig(env: Env, origin: string): GoogleConfig {
  const clientId = env.GOOGLE_CLIENT_ID ?? '';
  const clientSecret = env.GOOGLE_CLIENT_SECRET ?? '';

  if (clientId.length === 0 || clientSecret.length === 0) {
    throw new ServiceUnavailableError('ההתחברות אינה מוגדרת בשרת', {
      logContext: { reason: 'GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET is not set' },
    });
  }

  return {
    clientId,
    clientSecret,
    // Built from the canonical origin, not from the request host: a redirect
    // URI has to match what is registered with Google exactly, and it must not
    // be something a `Host` header can influence.
    redirectUri: `${appOrigin(env, origin)}/api/auth/google/callback`,
  };
}

/** The URL to send the visitor to. */
export function authorizeUrl(config: GoogleConfig, state: string): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    // Google shows the account chooser rather than silently reusing the last
    // account, which matters on a shared machine.
    prompt: 'select_account',
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

/** A random, URL-safe value for the `state` parameter. */
export function createState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Exchange the authorization code for an identity.
 *
 * @throws UnauthorizedError when Google refuses the code or the token is not
 *         one we can accept.
 */
export async function exchangeCode(config: GoogleConfig, code: string): Promise<ProviderProfile> {
  let response: Response;
  try {
    response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: config.redirectUri,
        grant_type: 'authorization_code',
      }).toString(),
    });
  } catch (cause) {
    throw new ServiceUnavailableError('לא הצלחנו ליצור קשר עם Google', { cause });
  }

  if (!response.ok) {
    // The body carries Google's own error code; it must not reach the visitor,
    // because it can contain parts of the request.
    throw new UnauthorizedError('ההתחברות נכשלה. נסו שוב');
  }

  let payload: { id_token?: unknown };
  try {
    payload = await response.json();
  } catch {
    throw new ServiceUnavailableError('תשובה לא צפויה מ־Google');
  }

  if (typeof payload.id_token !== 'string') {
    throw new UnauthorizedError('ההתחברות נכשלה. נסו שוב');
  }

  let claims;
  try {
    claims = decodeIdToken(payload.id_token, config.clientId);
  } catch (cause) {
    if (cause instanceof IdTokenError) throw new UnauthorizedError('ההתחברות נכשלה. נסו שוב');
    throw cause;
  }

  // An unverified address must not be trusted to match an existing account:
  // anyone can claim an address they do not control.
  const email = claims.email_verified === true ? (claims.email ?? '') : '';

  return {
    provider: 'google',
    providerUserId: claims.sub,
    email,
    displayName: claims.name ?? email.split('@')[0] ?? 'משתמש',
    avatarUrl: claims.picture ?? null,
  };
}

/** Validate the `state` echoed back against the one in the cookie. */
export function assertStateMatches(fromQuery: string | null, fromCookie: string | null): void {
  if (fromQuery == null || fromQuery.length === 0 || fromCookie == null) {
    throw new BadRequestError('בקשת ההתחברות פגה. נסו שוב');
  }
  if (fromQuery !== fromCookie) {
    throw new BadRequestError('בקשת ההתחברות אינה תקינה. נסו שוב');
  }
}
