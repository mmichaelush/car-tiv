// @vitest-environment happy-dom

/**
 * The session hint cookie, from both ends.
 *
 * The Worker writes it and the browser reads it, and the only thing that makes
 * the optimisation safe is that the two agree on the format. A test that only
 * exercised the reader would keep passing while the writer drifted, so both
 * sides are exercised here against the same strings.
 *
 * What the hint is for: `startPage()` used to call `/api/auth/session` on every
 * page load, including for the overwhelming majority of visitors who have never
 * signed in and never will. On a page making two other API calls that was a
 * third of the site's Worker requests, spent re-establishing that an anonymous
 * visitor is anonymous.
 *
 * What it is not: a credential. It carries two bits, no identity, and nothing
 * on the server reads it.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { serializeHint, SESSION_HINT_COOKIE } from '@worker/lib/cookies.js';
import { clearSessionHint, readSessionHint } from '@src/features/account/session-hint.js';

/** Apply a `Set-Cookie` value the way a browser would, for the read side. */
function receive(setCookie: string): void {
  document.cookie = setCookie.split(';')[0] ?? '';
}

beforeEach(() => {
  clearSessionHint();
});

describe('reading', () => {
  it('reports no hint before the server has ever answered', () => {
    expect(readSessionHint()).toBeNull();
  });

  it('reads a signed-out hint', () => {
    receive(serializeHint({ signedIn: false, signInAvailable: true }));

    expect(readSessionHint()).toEqual({ signedIn: false, signInAvailable: true });
  });

  it('reads a signed-in hint', () => {
    receive(serializeHint({ signedIn: true, signInAvailable: true }));

    expect(readSessionHint()).toEqual({ signedIn: true, signInAvailable: true });
  });

  it('reads a deployment with sign-in switched off', () => {
    receive(serializeHint({ signedIn: false, signInAvailable: false }));

    expect(readSessionHint()).toEqual({ signedIn: false, signInAvailable: false });
  });

  it('treats a malformed value as no hint rather than guessing', () => {
    // A guess here shows the wrong menu. Asking the server is always correct,
    // just not free, so that is the safe direction to fail in.
    for (const value of ['', 'yes', '1', '1.2', 'x.y', '1.1.1']) {
      document.cookie = `${SESSION_HINT_COOKIE}=${value}`;
      expect(readSessionHint()).toBeNull();
      clearSessionHint();
    }
  });

  it('is not confused by other cookies around it', () => {
    document.cookie = 'cartiv_other=1';
    receive(serializeHint({ signedIn: true, signInAvailable: true }));
    document.cookie = 'analytics=abc';

    expect(readSessionHint()?.signedIn).toBe(true);
  });

  it('forgets the hint when told to', () => {
    receive(serializeHint({ signedIn: true, signInAvailable: true }));
    clearSessionHint();

    expect(readSessionHint()).toBeNull();
  });
});

describe('what the Worker writes', () => {
  it('is readable by script, because that is the entire point', () => {
    // `HttpOnly` here would make the cookie invisible to the page and the
    // optimisation would silently do nothing.
    expect(serializeHint({ signedIn: false, signInAvailable: true })).not.toContain('HttpOnly');
  });

  it('carries no identity — only two bits', () => {
    const cookie = serializeHint({ signedIn: true, signInAvailable: true });
    const value = cookie.split(';')[0]?.split('=')[1] ?? '';

    expect(value).toBe('1.1');
    expect(value.length).toBeLessThanOrEqual(3);
  });

  it('expires long before the session does', () => {
    // A stale hint costs one wasted request. A hint that outlived a 60-day
    // session would keep claiming a session that had ended.
    const cookie = serializeHint({ signedIn: true, signInAvailable: true });
    const maxAge = Number(/Max-Age=(\d+)/.exec(cookie)?.[1] ?? '0');

    expect(maxAge).toBeGreaterThan(0);
    expect(maxAge).toBeLessThanOrEqual(86_400);
  });

  it('is scoped to the whole site and not sent cross-site', () => {
    const cookie = serializeHint({ signedIn: false, signInAvailable: true });

    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('SameSite=Lax');
  });
});
