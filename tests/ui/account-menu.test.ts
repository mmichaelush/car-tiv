// @vitest-environment happy-dom

/**
 * The header's account control has exactly three states, and getting any of
 * them wrong is visible on every page:
 *
 *  * no OAuth client configured — show nothing, rather than a button that
 *    cannot work;
 *  * signed out — one real link to the sign-in route;
 *  * signed in — the avatar and its menu.
 */

import { describe, expect, it } from 'vitest';
import type { SessionInfo } from '@src/data/account-repository.js';
import { renderAccountSlot } from '@src/features/account/account-menu.js';

const signedOut: SessionInfo = { user: null, roles: [], signInAvailable: true };

const signedIn: SessionInfo = {
  user: {
    id: 'u1',
    email: 'someone@example.com',
    displayName: 'מיכאל כהן',
    avatarUrl: null,
    roles: ['user'],
    createdAt: '2026-01-01',
  },
  roles: ['user'],
  signInAvailable: true,
};

function render(session: SessionInfo): HTMLElement {
  const slot = document.createElement('div');
  renderAccountSlot(slot, session);
  return slot;
}

describe('renderAccountSlot', () => {
  it('renders nothing when sign-in is not configured', () => {
    const slot = render({ ...signedOut, signInAvailable: false });
    expect(slot.innerHTML.trim()).toBe('');
  });

  it('offers a real link, not a button, when signed out', () => {
    const link = render(signedOut).querySelector('a');
    expect(link?.getAttribute('href')).toContain('/api/auth/google/start');
    // Middle-click and "open in new tab" have to work.
    expect(link?.tagName).toBe('A');
  });

  it('sends the visitor back to where they were after signing in', () => {
    const href = render(signedOut).querySelector('a')?.getAttribute('href') ?? '';
    expect(href).toContain(`return=${encodeURIComponent(window.location.pathname)}`);
  });

  it('shows the name and email once signed in', () => {
    const slot = render(signedIn);
    expect(slot.querySelector('.account-menu__name')?.textContent?.trim()).toBe('מיכאל כהן');
    expect(slot.querySelector('.account-menu__email')?.textContent?.trim()).toBe(
      'someone@example.com',
    );
  });

  it('falls back to an initial when the provider sent no picture', () => {
    const slot = render(signedIn);
    expect(slot.querySelector('img')).toBeNull();
    expect(slot.querySelector('.account-menu__initial')?.textContent?.trim()).toBe('מ');
  });

  it('uses the avatar when there is one, without leaking the referrer', () => {
    const slot = render({
      ...signedIn,
      user: { ...signedIn.user!, avatarUrl: 'https://example.test/a.png' },
    });
    const image = slot.querySelector('img');
    expect(image?.getAttribute('src')).toBe('https://example.test/a.png');
    expect(image?.getAttribute('referrerpolicy')).toBe('no-referrer');
  });

  it('offers a way out', () => {
    expect(render(signedIn).querySelector('[data-sign-out]')).not.toBeNull();
  });

  it('escapes a hostile display name', () => {
    const slot = render({
      ...signedIn,
      user: { ...signedIn.user!, displayName: '<img src=x onerror=alert(1)>' },
    });
    expect(slot.querySelector('img[onerror]')).toBeNull();
    expect(slot.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});
