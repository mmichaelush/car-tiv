/**
 * `/api/auth/*` — signing in and out.
 *
 * Two of these endpoints are not JSON APIs: `start` and `callback` are browser
 * navigations, so they answer with redirects. Everything else on the site talks
 * JSON, and mixing the two in one file is deliberate — this is the OAuth
 * dance, and splitting it across files would make it harder, not easier, to
 * check that it is correct.
 *
 * Failure on the callback never shows a raw error page: the visitor is sent
 * back to where they started with `?auth=failed`, and the page says something
 * useful in Hebrew.
 */

import { ERROR_CODES } from '@shared/constants.js';
import type { RequestContext } from '../context.js';
import {
  OAUTH_STATE_COOKIE,
  SESSION_COOKIE,
  serializeHint,
  clearCookie,
  readCookie,
  serializeCookie,
} from '../lib/cookies.js';
import { HttpError, UnauthorizedError } from '../lib/errors.js';
import { CACHE, ok } from '../lib/response.js';
import { get, post, type RouteDefinition } from '../router.js';
import { SESSION_TTL_SECONDS } from '../repositories/account-repository.js';
import {
  assertStateMatches,
  authorizeUrl,
  createState,
  exchangeCode,
  googleConfig,
  OAUTH_STATE_TTL_SECONDS,
  safeReturnPath,
} from '../services/auth-service.js';

/** `GET /api/auth/google/start?return=/library/` */
function start(context: RequestContext): Response {
  requireAccountsEnabled(context);

  const config = googleConfig(context.env, context.url.origin);
  const state = createState();
  const returnPath = safeReturnPath(context.url.searchParams.get('return'));

  // The return path travels inside the state cookie rather than through
  // Google, so nothing a third party controls decides where we land.
  const cookieValue = `${state}|${returnPath}`;

  return new Response(null, {
    status: 302,
    headers: {
      location: authorizeUrl(config, state),
      'set-cookie': serializeCookie(OAUTH_STATE_COOKIE, cookieValue, {
        maxAgeSeconds: OAUTH_STATE_TTL_SECONDS,
        secure: isSecure(context),
      }),
      'cache-control': 'no-store',
    },
  });
}

/** `GET /api/auth/google/callback?code=…&state=…` */
async function callback(context: RequestContext): Promise<Response> {
  requireAccountsEnabled(context);

  const stored = readCookie(context.request, OAUTH_STATE_COOKIE);
  const [storedState = null, storedReturn = '/'] = stored?.split('|') ?? [];
  const returnPath = safeReturnPath(storedReturn);
  const secure = isSecure(context);

  // Whatever happens next, the state cookie has done its job.
  const dropState = clearCookie(OAUTH_STATE_COOKIE, secure);

  try {
    // Google reports a refusal (the visitor pressed "cancel") as a parameter,
    // not as an HTTP error.
    const denied = context.url.searchParams.get('error');
    if (denied != null) throw new UnauthorizedError('ההתחברות בוטלה');

    assertStateMatches(context.url.searchParams.get('state'), storedState);

    const code = context.url.searchParams.get('code') ?? '';
    if (code.length === 0) throw new UnauthorizedError('ההתחברות נכשלה. נסו שוב');

    const config = googleConfig(context.env, context.url.origin);
    const profile = await exchangeCode(config, code);

    const { token } = await context.repositories.accounts.signIn(
      profile,
      context.request.headers.get('user-agent') ?? '',
    );

    // Housekeeping that must not delay the redirect.
    context.waitUntil(context.repositories.accounts.pruneSessions());

    const headers = new Headers({ location: returnPath, 'cache-control': 'no-store' });
    headers.append('set-cookie', dropState);
    headers.append(
      'set-cookie',
      serializeCookie(SESSION_COOKIE, token, { maxAgeSeconds: SESSION_TTL_SECONDS, secure }),
    );
    headers.append('set-cookie', serializeHint({ signedIn: true, signInAvailable: true }));

    return new Response(null, { status: 302, headers });
  } catch (cause) {
    context.logger.warn('Google sign-in failed', {
      error: cause instanceof Error ? cause.message : String(cause),
    });

    const failureUrl = new URL(returnPath, context.url.origin);
    failureUrl.searchParams.set('auth', cause instanceof HttpError ? 'failed' : 'error');

    const headers = new Headers({ location: failureUrl.toString(), 'cache-control': 'no-store' });
    headers.append('set-cookie', dropState);
    return new Response(null, { status: 302, headers });
  }
}

/**
 * `GET /api/auth/session` — who is signed in, if anyone.
 *
 * Also refreshes the readable hint cookie. That is what lets the *next* page
 * load skip this request entirely: a signed-out visitor reads "0" from the
 * cookie and never asks again for a day. See `SESSION_HINT_COOKIE`.
 */
function session(context: RequestContext): Response {
  const account = context.account;
  const signInAvailable = accountsUsable(context);

  return ok(
    {
      user: account?.user ?? null,
      roles: account?.roles ?? [],
      // The client needs to know whether to show a sign-in button at all.
      signInAvailable,
    },
    {},
    {
      cache: CACHE.none,
      headers: {
        'set-cookie': serializeHint({ signedIn: account != null, signInAvailable }),
      },
    },
  );
}

/** Whether sign-in is both enabled and actually configured. */
function accountsUsable(context: RequestContext): boolean {
  return (
    context.flags.accounts &&
    (context.env.GOOGLE_CLIENT_ID ?? '').length > 0 &&
    (context.env.GOOGLE_CLIENT_SECRET ?? '').length > 0
  );
}

/** `POST /api/auth/logout` */
async function logout(context: RequestContext): Promise<Response> {
  const account = context.account;
  if (account != null) await context.repositories.accounts.revokeSession(account.sessionId);

  return ok({ signedOut: true }, {}, { headers: signedOutHeaders(context) });
}

/** `POST /api/auth/logout-everywhere` — revoke every session of this account. */
async function logoutEverywhere(context: RequestContext): Promise<Response> {
  const account = requireAccount(context);
  await context.repositories.accounts.revokeAllSessions(account.user.id);

  return ok({ signedOut: true }, {}, { headers: signedOutHeaders(context) });
}

/**
 * Clear the session and flip the hint, in that order.
 *
 * Both must change together. Clearing only the session would leave a hint
 * saying "signed in", and every page load would then spend a request
 * rediscovering that the visitor is not.
 */
function signedOutHeaders(context: RequestContext): Headers {
  const headers = new Headers();
  headers.append('set-cookie', clearCookie(SESSION_COOKIE, isSecure(context)));
  headers.append(
    'set-cookie',
    serializeHint({ signedIn: false, signInAvailable: accountsUsable(context) }),
  );
  return headers;
}

/** The signed-in account, or a 401. Shared with the library routes. */
export function requireAccount(context: RequestContext) {
  requireAccountsEnabled(context);
  if (context.account == null) throw new UnauthorizedError('נדרשת התחברות');
  return context.account;
}

function requireAccountsEnabled(context: RequestContext): void {
  if (!context.flags.accounts) {
    throw new HttpError(404, ERROR_CODES.notFound, 'ההתחברות אינה פעילה כרגע');
  }
}

/**
 * Whether cookies should carry `Secure` and the `__Host-` prefix.
 * Local development runs on plain HTTP, where a `Secure` cookie is dropped.
 */
function isSecure(context: RequestContext): boolean {
  return context.url.protocol === 'https:';
}

export const authRoutes: RouteDefinition[] = [
  get('/api/auth/google/start', start),
  get('/api/auth/google/callback', callback),
  get('/api/auth/session', session),
  post('/api/auth/logout', logout),
  post('/api/auth/logout-everywhere', logoutEverywhere),
];
