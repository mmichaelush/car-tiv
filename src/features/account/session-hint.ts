/**
 * Reading the session hint cookie.
 *
 * The cookie is written by the Worker (`worker/lib/cookies.ts`) and answers one
 * question: is it worth asking the server who this visitor is?
 *
 * It exists because `startPage()` used to call `/api/auth/session` on every
 * single page load, whether or not anyone had ever signed in. On a page that
 * otherwise makes two API calls that was a third of the site's Worker requests,
 * spent re-confirming that an anonymous visitor is still anonymous. Cloudflare's
 * free plan allows 100,000 Worker requests a day, and that request was the
 * cheapest one to stop making.
 *
 * ## What this is not
 *
 * It is not a credential and it is not authentication. It carries two bits and
 * no identity, the browser can trivially edit it, and nothing on the server
 * reads it. Every protected endpoint reads the real `HttpOnly` session cookie.
 * Forging this one changes which menu a visitor sees on their own screen and
 * nothing else — and the moment they act on that menu, the server says 401 and
 * `initAccount` corrects the display.
 */

/** Two bits of display state, or `null` when the browser has no hint. */
export interface SessionHint {
  readonly signedIn: boolean;
  readonly signInAvailable: boolean;
}

const COOKIE_NAME = 'cartiv_auth';

/** Read the hint, or `null` if it is absent or malformed. */
export function readSessionHint(): SessionHint | null {
  let jar: string;
  try {
    jar = document.cookie;
  } catch {
    // Some embedded browsers throw on `document.cookie`. No hint is a valid
    // answer: the session is fetched, exactly as it was before.
    return null;
  }

  // `document.cookie` can hold more than one entry under the same name — a
  // host-only cookie beside a domain one, or a leftover from a different path.
  // Taking the first match would then read an emptied entry and conclude there
  // is no hint, so every candidate is tried and the first that parses wins.
  for (const pair of jar.split(';')) {
    const trimmed = pair.trim();
    if (!trimmed.startsWith(`${COOKIE_NAME}=`)) continue;

    const parsed = parseHint(trimmed.slice(COOKIE_NAME.length + 1));
    if (parsed != null) return parsed;
  }

  return null;
}

/**
 * `"<signedIn>.<signInAvailable>"` — anything else is `null`.
 *
 * Deliberately strict. A wrong guess here shows the wrong menu; returning
 * `null` only costs one request, so that is the safe direction to fail in.
 */
function parseHint(raw: string): SessionHint | null {
  const parts = raw.split('.');
  if (parts.length !== 2) return null;

  const [signedIn, available] = parts;
  if ((signedIn !== '0' && signedIn !== '1') || (available !== '0' && available !== '1')) {
    return null;
  }

  return { signedIn: signedIn === '1', signInAvailable: available === '1' };
}

/**
 * Forget the hint.
 *
 * Called when the server contradicts it — a 401 from an account endpoint means
 * the session ended elsewhere (signed out on another device, or revoked) while
 * this browser still held a hint saying otherwise. Clearing it makes the next
 * page load ask the server properly instead of trusting a stale answer.
 */
export function clearSessionHint(): void {
  try {
    // Expiring a cookie only removes the entry with a matching path, so both
    // the path the Worker writes and the current-page default are cleared.
    // A hint left behind here would keep asserting a session that has ended.
    document.cookie = `${COOKIE_NAME}=; Path=/; Max-Age=0; SameSite=Lax`;
    document.cookie = `${COOKIE_NAME}=; Max-Age=0; SameSite=Lax`;
  } catch {
    // Nothing to do; the hint expires on its own within a day.
  }
}
