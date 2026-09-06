/**
 * Toasts — the one way the product confirms an action.
 *
 * One implementation, one region, `aria-live="polite"` so a screen reader
 * hears "נוסף למועדפים" without being interrupted mid-sentence. The old site
 * mixed SweetAlert dialogs with hand-rolled banners; this replaces both.
 */

import { appendHtml, html, on, prefersReducedMotion } from '../dom.js';
import { icon } from '../icons.js';

export type ToastTone = 'info' | 'success' | 'error';

export interface ToastOptions {
  readonly tone?: ToastTone;
  /** Milliseconds before it disappears. `0` keeps it until dismissed. */
  readonly durationMs?: number;
  /** An optional inline action, e.g. "ביטול". */
  readonly action?: { label: string; onSelect: () => void };
}

const REGION_ID = 'toast-region';

function region(): HTMLElement {
  const existing = document.getElementById(REGION_ID);
  if (existing != null) return existing;

  const created = document.createElement('div');
  created.id = REGION_ID;
  created.className = 'toast-region';
  created.setAttribute('aria-live', 'polite');
  created.setAttribute('aria-atomic', 'false');
  document.body.append(created);
  return created;
}

/**
 * Show a toast.
 * @returns A function that dismisses it early.
 */
export function toast(message: string, options: ToastOptions = {}): () => void {
  const tone = options.tone ?? 'info';
  const duration = options.durationMs ?? (tone === 'error' ? 6000 : 3500);
  const container = region();

  const before = container.lastElementChild;
  appendHtml(
    container,
    html`
      <div class="toast toast--${tone}" role="status">
        ${tone === 'success' ? icon('check', { size: 18 }) : ''}
        ${tone === 'error' ? icon('alert', { size: 18 }) : ''}
        <span>${message}</span>
        ${
          options.action == null
            ? ''
            : html`<button type="button" class="toast__action" data-toast-action>
                ${options.action.label}
              </button>`
        }
      </div>
    `,
  );

  const element = container.lastElementChild;
  if (!(element instanceof HTMLElement) || element === before) return () => undefined;

  let timer: ReturnType<typeof setTimeout> | undefined;

  const dismiss = (): void => {
    if (timer != null) clearTimeout(timer);
    if (!element.isConnected) return;

    if (prefersReducedMotion()) {
      element.remove();
      return;
    }
    element.classList.add('is-leaving');
    on(element, 'animationend', () => element.remove(), { once: true });
    // Belt and braces: remove it even if the animation never fires.
    setTimeout(() => element.remove(), 500);
  };

  const actionButton = element.querySelector('[data-toast-action]');
  if (actionButton != null && options.action != null) {
    const { onSelect } = options.action;
    on(actionButton, 'click', () => {
      onSelect();
      dismiss();
    });
  }

  if (duration > 0) timer = setTimeout(dismiss, duration);
  return dismiss;
}

export const toastSuccess = (message: string, options: ToastOptions = {}): (() => void) =>
  toast(message, { ...options, tone: 'success' });

export const toastError = (message: string, options: ToastOptions = {}): (() => void) =>
  toast(message, { ...options, tone: 'error' });

/**
 * Copy a URL, or hand it to the operating system's share sheet when there is
 * one. Either way the visitor gets a toast, so the action never feels silent.
 *
 * ## Call this synchronously from the click
 *
 * Both `navigator.share` and `navigator.clipboard.writeText` require transient
 * user activation — a flag the browser sets on the click and clears at the
 * first await that yields. `await import('./toast.js')` before calling this is
 * enough to spend it, and the browser then rejects both, which is how a share
 * button ends up doing nothing whatsoever. Import this module statically.
 *
 * ## Every path ends somewhere the visitor can see
 *
 * There is no environment where this gives up silently: the share sheet, then
 * the clipboard, then the deprecated `execCommand` copy that still works in
 * places the async clipboard is blocked, and finally a dialog with the link
 * selected so it can be copied by hand.
 */
export async function shareUrl(url: string, title: string): Promise<void> {
  if (typeof navigator.share === 'function') {
    try {
      await navigator.share({ title, url });
      return;
    } catch (error) {
      // The visitor cancelling the share sheet is not an error worth
      // reporting; anything else falls through to the clipboard.
      if (error instanceof DOMException && error.name === 'AbortError') return;
    }
  }

  try {
    await navigator.clipboard.writeText(url);
    toastSuccess('הקישור הועתק');
    return;
  } catch {
    // Blocked, unavailable over a non-secure origin, or out of activation.
  }

  if (copyWithSelection(url)) {
    toastSuccess('הקישור הועתק');
    return;
  }

  // Nothing automatic worked. Show it, rather than claiming a failure and
  // leaving the visitor with no link at all.
  const { promptDialog } = await import('./dialog.js');
  await promptDialog({
    title: 'העתקת הקישור',
    label: 'הדפדפן לא איפשר העתקה אוטומטית — אפשר להעתיק מכאן',
    value: url,
    confirmLabel: 'סגירה',
  });
}

/**
 * The pre-clipboard-API copy: a hidden field, selected, and `execCommand`.
 *
 * Deprecated and still the only thing that works in a few real places — an
 * iframe without `clipboard-write`, some in-app browsers, Safari once the
 * activation has lapsed. It is synchronous, which is exactly why it survives
 * where the promise-based API does not.
 */
function copyWithSelection(text: string): boolean {
  const field = document.createElement('textarea');
  field.value = text;
  field.setAttribute('readonly', '');
  field.setAttribute('aria-hidden', 'true');
  // Off-screen rather than `display: none`: a hidden element cannot be
  // selected, and scrolling must not jump to it.
  field.style.cssText = 'position:fixed;inset-block-start:-1000px;opacity:0';
  document.body.append(field);

  try {
    field.select();
    field.setSelectionRange(0, text.length);
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    field.remove();
  }
}
