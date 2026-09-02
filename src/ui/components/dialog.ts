/**
 * Dialogs, built on the native `<dialog>` element.
 *
 * `showModal()` gives focus trapping, Escape-to-close, inertness of the page
 * behind and a real backdrop — all things a hand-rolled modal gets wrong. This
 * module adds only what the element does not: creating the markup, returning
 * focus to the element that opened it, and a promise-based confirm.
 */

import { html, on, select, setHtml, type SafeHtml } from '../dom.js';
import { icon } from '../icons.js';

export interface DialogOptions {
  readonly title: string;
  readonly body: SafeHtml;
  /** Buttons for the footer. Omit for a dialog closed only by its × button. */
  readonly footer?: SafeHtml;
  /** Adds the wide variant, for the personal library. */
  readonly wide?: boolean;
  /** An extra class on the dialog, for a variant with its own geometry. */
  readonly className?: string;
  /** Called after the dialog closes, whatever closed it. */
  readonly onClose?: () => void;
}

export interface DialogHandle {
  readonly element: HTMLDialogElement;
  close(): void;
  /** Replace the body without recreating the dialog. */
  setBody(content: SafeHtml): void;
}

/** Create, show and return a modal dialog. */
export function openDialog(options: DialogOptions): DialogHandle {
  const opener = document.activeElement;

  const element = document.createElement('dialog');
  element.className = [
    'dialog',
    options.wide === true ? 'dialog--wide' : '',
    options.className ?? '',
  ]
    .filter((name) => name.length > 0)
    .join(' ');

  setHtml(
    element,
    html`
      <div class="dialog__header">
        <h2>${options.title}</h2>
        <button type="button" class="dialog__close" data-dialog-close aria-label="סגירה">
          ${icon('close', { size: 20 })}
        </button>
      </div>
      <div class="dialog__body" data-dialog-body></div>
      ${options.footer == null ? '' : html`<div class="dialog__footer">${options.footer}</div>`}
    `,
  );

  const body = select('[data-dialog-body]', element);
  setHtml(body, options.body);

  document.body.append(element);
  element.showModal();

  on(select('[data-dialog-close]', element), 'click', () => {
    element.close();
  });

  // Clicking the backdrop closes the dialog. The check compares against the
  // dialog's own box, because a click on the backdrop still targets <dialog>.
  on(element, 'click', (event) => {
    if (event.target !== element) return;
    const box = element.getBoundingClientRect();
    const outside =
      event.clientX < box.left ||
      event.clientX > box.right ||
      event.clientY < box.top ||
      event.clientY > box.bottom;
    if (outside) element.close();
  });

  on(element, 'close', () => {
    element.remove();
    if (opener instanceof HTMLElement) opener.focus();
    options.onClose?.();
  });

  return {
    element,
    close: () => {
      element.close();
    },
    setBody: (content) => {
      setHtml(body, content);
    },
  };
}

export interface ConfirmOptions {
  readonly title: string;
  readonly message: string;
  readonly confirmLabel?: string;
  readonly cancelLabel?: string;
  /** Styles the confirm button as destructive. */
  readonly destructive?: boolean;
}

/**
 * Ask the visitor to confirm something.
 * @returns `true` when confirmed, `false` when cancelled or dismissed.
 */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    let confirmed = false;

    const handle = openDialog({
      title: options.title,
      body: html`<p>${options.message}</p>`,
      footer: html`
        <button type="button" class="btn btn--secondary" data-confirm="no">
          ${options.cancelLabel ?? 'ביטול'}
        </button>
        <button
          type="button"
          class="btn ${options.destructive === true ? 'btn--danger' : 'btn--primary'}"
          data-confirm="yes"
        >
          ${options.confirmLabel ?? 'אישור'}
        </button>
      `,
      onClose: () => {
        resolve(confirmed);
      },
    });

    on(select('[data-confirm="no"]', handle.element), 'click', () => {
      handle.close();
    });
    on(select('[data-confirm="yes"]', handle.element), 'click', () => {
      confirmed = true;
      handle.close();
    });
  });
}

export interface PromptOptions {
  readonly title: string;
  readonly label: string;
  readonly value?: string;
  readonly placeholder?: string;
  readonly maxLength?: number;
  readonly confirmLabel?: string;
}

/**
 * Ask for one line of text.
 *
 * Replaces `window.prompt`, which cannot be styled, cannot be translated, is
 * blocked in several contexts and looks like a phishing attempt. Resolves to
 * `null` when the visitor cancels — an empty string is a real answer and is
 * reported as such.
 */
export function promptDialog(options: PromptOptions): Promise<string | null> {
  return new Promise((resolve) => {
    let answer: string | null = null;

    const handle = openDialog({
      title: options.title,
      body: html`
        <form class="form-grid" data-prompt-form>
          <div class="field">
            <label for="prompt-input">${options.label}</label>
            <input
              class="input"
              id="prompt-input"
              name="value"
              type="text"
              maxlength="${String(options.maxLength ?? 80)}"
              value="${options.value ?? ''}"
              placeholder="${options.placeholder ?? ''}"
              autocomplete="off"
            />
          </div>
        </form>
      `,
      footer: html`
        <button type="button" class="btn btn--secondary" data-prompt="cancel">ביטול</button>
        <button type="button" class="btn btn--primary" data-prompt="ok">
          ${options.confirmLabel ?? 'אישור'}
        </button>
      `,
      onClose: () => {
        resolve(answer);
      },
    });

    const input = select<HTMLInputElement>('#prompt-input', handle.element);
    const accept = (): void => {
      answer = input.value;
      handle.close();
    };

    on(select('[data-prompt="ok"]', handle.element), 'click', accept);
    on(select('[data-prompt="cancel"]', handle.element), 'click', () => {
      handle.close();
    });

    // Enter submits, which is what everyone expects from a one-field dialog.
    on(select<HTMLFormElement>('[data-prompt-form]', handle.element), 'submit', (event) => {
      event.preventDefault();
      accept();
    });

    input.focus();
    input.select();
  });
}
