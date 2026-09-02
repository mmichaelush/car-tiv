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
 */
export async function shareUrl(url: string, title: string): Promise<void> {
  if (typeof navigator.share === 'function') {
    try {
      await navigator.share({ title, url });
      return;
    } catch (error) {
      // The visitor cancelling the share sheet is not an error worth reporting.
      if (error instanceof DOMException && error.name === 'AbortError') return;
    }
  }

  try {
    await navigator.clipboard.writeText(url);
    toastSuccess('הקישור הועתק');
  } catch {
    toastError('לא הצלחנו להעתיק את הקישור');
  }
}
