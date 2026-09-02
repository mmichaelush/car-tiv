/**
 * "Report a problem" and "send a note" — the two ways a visitor can tell us
 * something about a specific video.
 *
 * They are deliberately separate. A report is a defect ("the video is gone");
 * a note is knowledge ("this also fits the i30"). Mixing them into one free-text
 * box is what makes an inbox unusable.
 */

import { REPORT_REASONS, type ReportReason } from '@shared/constants.js';
import type { VideoDetail } from '@shared/types/catalog.js';
import { html, on, select, selectAll, setHtml } from '../../ui/dom.js';
import { openDialog } from '../../ui/components/dialog.js';
import { toastError, toastSuccess } from '../../ui/components/toast.js';
import { engagement } from '../../data/engagement-repository.js';
import { field } from '../../app/forms.js';
import { ApiError } from '../../data/http-client.js';

/** Hebrew labels for the report reasons the API accepts. */
const REASON_LABELS: Readonly<Record<ReportReason, string>> = {
  broken: 'הסרטון לא נטען או לא עובד',
  removed: 'הסרטון הוסר מ־YouTube',
  'wrong-details': 'פרטים לא נכונים',
  'wrong-category': 'הקטגוריה לא מתאימה',
  'inaccurate-title': 'הכותרת לא מדויקת',
  inappropriate: 'תוכן לא מתאים למאגר',
  other: 'משהו אחר',
};

export function openReportDialog(video: VideoDetail): void {
  const handle = openDialog({
    title: 'דיווח על בעיה',
    body: html`
      <p class="muted" style="margin-block-end:var(--space-4)">${video.title}</p>
      <form class="form-grid" data-report-form novalidate>
        <fieldset class="field" style="border:0;padding:0">
          <legend class="label">מה הבעיה?</legend>
          ${REPORT_REASONS.map(
            (reason, index) => html`
              <label class="check">
                <input
                  type="radio"
                  name="reason"
                  value="${reason}"
                  ${index === 0 ? 'checked' : ''}
                />
                ${REASON_LABELS[reason]}
              </label>
            `,
          )}
        </fieldset>

        <div class="field">
          <label for="report-message">פרטים נוספים</label>
          <textarea class="textarea" id="report-message" name="message" rows="4"></textarea>
        </div>

        <div class="field">
          <label for="report-email">אימייל (לא חובה)</label>
          <input class="input" id="report-email" name="email" type="email" />
          <span class="hint">רק אם תרצו שנעדכן אתכם כשהטיפול יסתיים.</span>
        </div>

        <div class="form-status" data-form-status hidden></div>
      </form>
    `,
    footer: html`
      <button type="button" class="btn btn--secondary" data-cancel>ביטול</button>
      <button type="submit" form="" class="btn btn--primary" data-send>שליחת הדיווח</button>
    `,
  });

  wireForm(handle.element, async (form) => {
    const data = new FormData(form);
    await engagement.report({
      videoId: video.id,
      reason: (field(data, 'reason') || 'other') as ReportReason,
      message: field(data, 'message'),
      email: field(data, 'email'),
    });
    handle.close();
    toastSuccess('הדיווח נשלח. תודה שעזרתם לנו לשמור על המאגר');
  });
}

export function openFeedbackDialog(video: VideoDetail): void {
  const handle = openDialog({
    title: 'הערה על הסרטון',
    body: html`
      <p class="muted" style="margin-block-end:var(--space-4)">${video.title}</p>
      <form class="form-grid" data-report-form novalidate>
        <div class="field">
          <label for="feedback-message">מה כדאי שנדע? <span aria-hidden="true">*</span></label>
          <textarea
            class="textarea"
            id="feedback-message"
            name="message"
            rows="5"
            required
            placeholder="לדוגמה: הסרטון הזה מתאים גם ליונדאי i30 של אותן שנים"
          ></textarea>
          <span class="field-error" data-error-for="message"></span>
        </div>

        <div class="field">
          <label for="feedback-email">אימייל (לא חובה)</label>
          <input class="input" id="feedback-email" name="email" type="email" />
        </div>

        <div class="form-status" data-form-status hidden></div>
      </form>
    `,
    footer: html`
      <button type="button" class="btn btn--secondary" data-cancel>ביטול</button>
      <button type="button" class="btn btn--primary" data-send>שליחה</button>
    `,
  });

  wireForm(handle.element, async (form) => {
    const data = new FormData(form);
    await engagement.feedback({
      videoId: video.id,
      message: field(data, 'message'),
      email: field(data, 'email'),
    });
    handle.close();
    toastSuccess('ההערה נשלחה. תודה');
  });
}

/**
 * Shared submit handling: disable the button, show per-field errors from the
 * API, and never leave the visitor looking at a dead button.
 */
function wireForm(scope: HTMLElement, submit: (form: HTMLFormElement) => Promise<void>): void {
  const form = select<HTMLFormElement>('[data-report-form]', scope);
  const sendButton = select<HTMLButtonElement>('[data-send]', scope);
  const status = select('[data-form-status]', scope);

  on(select('[data-cancel]', scope), 'click', () => {
    (scope as HTMLDialogElement).close();
  });

  const run = (): void => {
    for (const element of selectAll('[data-error-for]', form)) element.textContent = '';
    status.hidden = true;
    sendButton.disabled = true;

    void submit(form)
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.isValidation) {
          for (const [field, message] of Object.entries(error.fields)) {
            const target = form.querySelector(`[data-error-for="${field}"]`);
            if (target != null) target.textContent = message;
          }
          setHtml(status, html`${error.message}`);
          status.dataset.tone = 'error';
          status.hidden = false;
          return;
        }
        toastError(error instanceof ApiError ? error.message : 'השליחה נכשלה. נסו שוב');
      })
      .finally(() => {
        sendButton.disabled = false;
      });
  };

  on(sendButton, 'click', run);
  on(form, 'submit', (event) => {
    event.preventDefault();
    run();
  });
}
