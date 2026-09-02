/**
 * The account control in the header.
 *
 * Renders nothing at all until the session request answers, and nothing at all
 * on a deployment with no OAuth client configured — an empty slot is better
 * than a "sign in" button that cannot work.
 *
 * Signed in it is an avatar that opens a small menu; signed out it is one
 * link. The link is a real `<a>` to `/api/auth/google/start`, not a button
 * with a click handler, so it works before hydration, middle-clicks sensibly
 * and is announced correctly.
 */

import { ROUTES } from '@shared/core/paths.js';
import { html, on, setHtml } from '../../ui/dom.js';
import { icon } from '../../ui/icons.js';
import type { SessionInfo } from '../../data/account-repository.js';
import { onSessionChange, signInHref, signOut } from './account.js';

export function mountAccountMenu(): void {
  const slot = document.querySelector('[data-account-slot]');
  if (slot == null) return;

  onSessionChange((session) => {
    renderAccountSlot(slot, session);
  });
}

/**
 * Render the control for one session state.
 *
 * Separate from `mountAccountMenu` so it can be tested without a network: the
 * three states (unavailable, signed out, signed in) are exactly the thing worth
 * pinning.
 */
export function renderAccountSlot(slot: Element, session: SessionInfo): void {
  if (session.user == null) {
    if (!session.signInAvailable) {
      setHtml(slot, html``);
      return;
    }

    setHtml(
      slot,
      html`<a class="btn btn--secondary btn--sm" href="${signInHref()}">
        ${icon('user', { size: 16 })} התחברות
      </a>`,
    );
    return;
  }

  const user = session.user;
  const initial = (user.displayName.trim()[0] ?? '?').toUpperCase();

  setHtml(
    slot,
    html`
      <details class="account-menu" data-account-menu>
        <summary aria-label="החשבון שלי" title="${user.displayName}">
          ${
            user.avatarUrl == null
              ? html`<span class="account-menu__initial" aria-hidden="true">${initial}</span>`
              : html`<img
                  class="account-menu__avatar"
                  src="${user.avatarUrl}"
                  alt=""
                  width="28"
                  height="28"
                  referrerpolicy="no-referrer"
                />`
          }
        </summary>
        <div class="account-menu__panel">
          <p class="account-menu__name">${user.displayName}</p>
          ${user.email == null ? '' : html`<p class="account-menu__email">${user.email}</p>`}
          <a href="${ROUTES.library}">הספרייה שלי</a>
          <button type="button" data-sign-out>יציאה</button>
        </div>
      </details>
    `,
  );

  const menu = slot.querySelector<HTMLDetailsElement>('[data-account-menu]');
  const button = slot.querySelector<HTMLButtonElement>('[data-sign-out]');

  if (button != null) {
    on(button, 'click', () => {
      void signOut();
    });
  }

  // Clicking anywhere else, or pressing Escape, closes the menu — the two
  // things a `<details>` does not do for you.
  if (menu != null) {
    on(document, 'click', (event) => {
      if (event.target instanceof Node && !menu.contains(event.target)) menu.open = false;
    });
    on(document, 'keydown', (event) => {
      if (event.key === 'Escape') menu.open = false;
    });
  }
}
