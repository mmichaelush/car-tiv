/**
 * Cookies.
 *
 * Two of them, both set only by the Worker and never read by JavaScript:
 *
 *  * the session cookie, which is the whole of a visitor's logged-in state;
 *  * a short-lived OAuth `state` cookie, which is what stops a third-party site
 *    from completing a sign-in on someone's behalf (CSRF on the callback).
 *
 * Both use the `__Host-` prefix in production. A browser refuses to accept a
 * `__Host-` cookie unless it is `Secure`, has `Path=/` and carries no `Domain`
 * — which means a subdomain, including one an attacker manages to stand up,
 * cannot overwrite it. Over plain HTTP in development the prefix is dropped,
 * because the browser would reject the cookie outright.
 */

export const SESSION_COOKIE = 'session';
export const OAUTH_STATE_COOKIE = 'oauth_state';

/**
 * The one cookie JavaScript *is* meant to read.
 *
 * It answers a single question — "is it worth asking the server who I am?" —
 * and it exists because the answer used to cost a request on every single page
 * load. `startPage()` called `/api/auth/session` unconditionally, so on a page
 * that otherwise makes two API calls, a third of the site's Worker requests
 * were spent confirming, over and over, that a visitor who has never signed in
 * is still not signed in.
 *
 * It carries no session data and grants no access. Every protected endpoint
 * reads the real `HttpOnly` session cookie and nothing else, so forging this
 * one buys an attacker a misleading menu on their own screen. That is the
 * entire threat model, and it is why the contents are two characters.
 *
 * Its lifetime is deliberately much shorter than the session's: a stale hint
 * costs at most one wasted request, and a day is short enough that turning
 * accounts on or off reaches everyone quickly.
 */
export const SESSION_HINT_COOKIE = 'cartiv_auth';

export const SESSION_HINT_MAX_AGE = 86_400;

/** What the hint says, as the browser will read it. */
export interface SessionHint {
  readonly signedIn: boolean;
  readonly signInAvailable: boolean;
}

/** `"<signedIn>.<signInAvailable>"`, e.g. `"0.1"`. */
export function serializeHint(hint: SessionHint): string {
  const value = `${hint.signedIn ? '1' : '0'}.${hint.signInAvailable ? '1' : '0'}`;

  // Not `HttpOnly` — the whole point is that the page can read it — and never
  // `__Host-` prefixed, because that prefix is about protecting a credential
  // and this is not one. Same name on HTTP and HTTPS keeps the client's read
  // trivial.
  return [
    `${SESSION_HINT_COOKIE}=${value}`,
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${String(SESSION_HINT_MAX_AGE)}`,
  ].join('; ');
}

/** The name a cookie actually gets, given whether the site is on HTTPS. */
export function cookieName(base: string, secure: boolean): string {
  return secure ? `__Host-${base}` : base;
}

export interface CookieOptions {
  readonly maxAgeSeconds: number;
  readonly secure: boolean;
  /**
   * `lax` lets the cookie ride a top-level navigation back from Google, which
   * the OAuth callback needs. `strict` would arrive without it and the sign-in
   * would fail every time.
   */
  readonly sameSite?: 'Lax' | 'Strict';
}

/** Serialise a `Set-Cookie` value. */
export function serializeCookie(base: string, value: string, options: CookieOptions): string {
  const parts = [
    `${cookieName(base, options.secure)}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    `SameSite=${options.sameSite ?? 'Lax'}`,
    `Max-Age=${String(Math.max(0, Math.floor(options.maxAgeSeconds)))}`,
  ];
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

/** A `Set-Cookie` value that deletes the cookie. */
export function clearCookie(base: string, secure: boolean): string {
  return serializeCookie(base, '', { maxAgeSeconds: 0, secure });
}

/**
 * Read one cookie from a request.
 *
 * Looks for the `__Host-` name first, then the bare one, so a request made
 * during a switch between HTTP and HTTPS still finds its cookie.
 */
export function readCookie(request: Request, base: string): string | null {
  const header = request.headers.get('cookie');
  if (header == null || header.length === 0) return null;

  const wanted = [cookieName(base, true), base];
  for (const pair of header.split(';')) {
    const index = pair.indexOf('=');
    if (index < 0) continue;

    const name = pair.slice(0, index).trim();
    if (!wanted.includes(name)) continue;

    // A malformed percent-escape makes `decodeURIComponent` throw. That used to
    // escape all the way out of `resolveAccount` and turn one bad cookie into a
    // 500 for the whole request — the opposite of the documented intent, which
    // is that a bad cookie leaves the visitor anonymous. Anything undecodable is
    // treated as no cookie at all.
    let value: string;
    try {
      value = decodeURIComponent(pair.slice(index + 1).trim());
    } catch {
      return null;
    }
    if (value.length > 0) return value;
  }
  return null;
}
