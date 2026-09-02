/**
 * Shared form handling for the "suggest a video" and "contact" pages.
 *
 * The behaviour both pages need, in one place: disable the button while a
 * request is in flight, show the API's per-field messages next to the fields
 * they belong to, and never leave a form in a state the visitor cannot get out
 * of. Validation messages come from the server, so there is exactly one set of
 * rules rather than two that drift apart.
 */

import { ApiError } from '../data/http-client.js';
import { toastError } from '../ui/components/toast.js';
import { html, on, selectAll, setHtml } from '../ui/dom.js';

export interface FormControllerOptions {
  readonly form: HTMLFormElement;
  /** Submit the collected values. Throw an `ApiError` to show field errors. */
  readonly submit: (values: FormData) => Promise<void>;
  /** Rendered in place of the form once it succeeds. */
  readonly successMessage: string;
  /** Keep the form visible and just show a toast, instead of replacing it. */
  readonly keepFormOnSuccess?: boolean;
  /**
   * Called when the submission failed for a reason that is not the visitor's
   * fault — the API is down, or the network is. Pages use it to surface a way
   * through that does not depend on our own backend (the legacy Google Form,
   * a direct email link), so a visitor with something to tell us is never left
   * at a dead end. Not called for validation errors: those the visitor can fix.
   */
  readonly onServerFailure?: () => void;
}

export function mountForm(options: FormControllerOptions): void {
  const { form } = options;
  const submitButton = form.querySelector<HTMLButtonElement>('[data-submit]');
  const status = form.querySelector<HTMLElement>('[data-form-status]');

  on(form, 'submit', (event) => {
    event.preventDefault();
    clearErrors(form, status);

    if (submitButton != null) {
      submitButton.disabled = true;
      submitButton.dataset.label ??= submitButton.textContent ?? '';
      submitButton.textContent = 'שולח…';
    }

    void options
      .submit(new FormData(form))
      .then(() => {
        if (options.keepFormOnSuccess === true) {
          showStatus(status, options.successMessage, 'success');
          form.reset();
          return;
        }
        replaceWithSuccess(form, options.successMessage);
      })
      .catch((error: unknown) => {
        const recoverable = handleFailure(error, form, status);
        if (!recoverable) options.onServerFailure?.();
      })
      .finally(() => {
        if (submitButton?.isConnected === true) {
          submitButton.disabled = false;
          submitButton.textContent = submitButton.dataset.label ?? 'שליחה';
        }
      });
  });
}

/**
 * Show the failure to the visitor.
 * @returns `true` when the visitor can fix it themselves (a validation error).
 */
function handleFailure(error: unknown, form: HTMLFormElement, status: HTMLElement | null): boolean {
  if (error instanceof ApiError && error.isValidation) {
    let firstInvalid: HTMLElement | null = null;

    for (const [name, message] of Object.entries(error.fields)) {
      const target = form.querySelector(`[data-error-for="${name}"]`);
      if (target != null) target.textContent = message;

      const input = form.querySelector<HTMLElement>(`[name="${name}"]`);
      if (input != null) {
        input.setAttribute('aria-invalid', 'true');
        firstInvalid ??= input;
      }
    }

    showStatus(status, error.message, 'error');
    // Move focus to the first problem, so a keyboard or screen-reader user is
    // not left hunting for what went wrong.
    firstInvalid?.focus();
    return true;
  }

  const message = error instanceof ApiError ? error.message : 'השליחה נכשלה. נסו שוב בעוד רגע';
  showStatus(status, message, 'error');
  toastError(message);
  return false;
}

function clearErrors(form: HTMLFormElement, status: HTMLElement | null): void {
  for (const element of selectAll('[data-error-for]', form)) element.textContent = '';
  for (const input of selectAll('[aria-invalid]', form)) input.removeAttribute('aria-invalid');
  if (status != null) status.hidden = true;
}

function showStatus(status: HTMLElement | null, message: string, tone: 'success' | 'error'): void {
  if (status == null) return;
  setHtml(status, html`${message}`);
  status.dataset.tone = tone;
  status.hidden = false;
}

function replaceWithSuccess(form: HTMLFormElement, message: string): void {
  const panel = form.closest('.panel') ?? form;
  setHtml(
    panel,
    html`
      <div class="empty-state">
        <span class="empty-state__icon">✓</span>
        <h3>${message}</h3>
        <p>תודה שעזרתם לנו לשפר את המאגר.</p>
        <a class="btn btn--secondary" href="/">חזרה לדף הבית</a>
      </div>
    `,
  );
}

/**
 * Read a text field from a form.
 *
 * `FormData.get` returns `string | File | null`; a `File` here would mean the
 * form has a file input the caller did not expect, so it reads as empty rather
 * than stringifying into `[object File]`.
 */
export function field(data: FormData, name: string): string {
  const value = data.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

/** The same, treating an empty field as "not provided". */
export function optionalField(data: FormData, name: string): string | undefined {
  const value = field(data, name);
  return value.length === 0 ? undefined : value;
}
