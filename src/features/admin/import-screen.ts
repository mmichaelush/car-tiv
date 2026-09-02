/**
 * The bulk-import screen.
 *
 * Four steps, in order, each one visible before the next runs:
 *
 *   1. **pick** a CSV or XLSX file;
 *   2. **map** its columns onto catalog fields — guessed, always shown, always
 *      changeable;
 *   3. **preview**: how many rows are usable, which are not and why, and what
 *      the first few will look like;
 *   4. **import**, in batches, with a progress bar and a report at the end.
 *
 * Nothing is written until the editor presses the button on step 4. That is
 * the whole design goal: a bulk import is the single most destructive thing in
 * the admin, so it is impossible to run one without first seeing what it will
 * do.
 */

import {
  guessMapping,
  IMPORT_FIELDS,
  readRow,
  type ColumnMapping,
  type ImportField,
} from '@shared/core/import-mapping.js';
import { adminApi, type ImportJob, type ImportOptions } from '../../data/admin-repository.js';
import { catalog } from '../../data/catalog-repository.js';
import type { Category } from '@shared/types/catalog.js';
import { errorState } from '../../ui/components/video-card.js';
import { toastError, toastSuccess } from '../../ui/components/toast.js';
import { delegate, formatCount, html, on, select, setHtml, type SafeHtml } from '../../ui/dom.js';
import { ImportFileError, readImportFile, type ReadFileResult } from './import-file.js';

/** Hebrew labels for the fields an import can fill. */
const FIELD_LABELS: Readonly<Record<ImportField, string>> = {
  videoId: 'קישור או מזהה *',
  title: 'כותרת *',
  description: 'תיאור',
  category: 'קטגוריה',
  channel: 'שם הערוץ',
  channelUrl: 'קישור לערוץ',
  tags: 'תגיות',
  duration: 'אורך',
  addedAt: 'תאריך הוספה',
  isHebrew: 'בעברית',
};

/** How many rows the preview table shows. */
const PREVIEW_ROWS = 5;

interface State {
  file: ReadFileResult | null;
  mapping: ColumnMapping;
  categories: readonly Category[];
  options: ImportOptions;
  running: boolean;
}

export async function renderImport(container: HTMLElement): Promise<void> {
  const [categories, jobs] = await Promise.all([
    catalog.listCategories().catch((): readonly Category[] => []),
    adminApi.listImports().catch((): readonly ImportJob[] => []),
  ]);

  const state: State = {
    file: null,
    mapping: {},
    categories,
    options: {
      defaultCategoryId: categories[0]?.id ?? '',
      status: 'pending',
      updateExisting: false,
    },
    running: false,
  };

  const draw = (): void => {
    setHtml(container, screen(state, jobs));
    wire(container, state, draw);
  };

  draw();
}

// ------------------------------------------------------------------ Markup

function screen(state: State, jobs: readonly ImportJob[]): SafeHtml {
  return html`
    <section class="panel">
      <h2>ייבוא סרטונים מקובץ</h2>
      <p class="muted">
        אפשר להעלות קובץ CSV או XLSX. הקובץ נקרא כאן בדפדפן — נראה בדיוק מה עומד להיכנס למאגר לפני
        שמשהו נשמר.
      </p>

      <div class="field" style="margin-block-start: var(--space-4); max-width: 30rem">
        <label for="import-file">בחירת קובץ</label>
        <input class="input" id="import-file" type="file" accept=".csv,.tsv,.txt,.xlsx,.xls" />
      </div>

      <div data-import-status></div>
    </section>

    ${state.file == null ? '' : mappingPanel(state)}
    ${state.file == null ? '' : previewPanel(state)} ${jobsPanel(jobs)}
  `;
}

function mappingPanel(state: State): SafeHtml {
  const file = state.file;
  if (file == null) return html``;

  return html`
    <section class="panel">
      <h2>התאמת עמודות</h2>
      <p class="muted">
        ${file.filename} — ${formatCount(file.rows.length)} שורות, ${file.headers.length} עמודות.
        ${
          file.malformedRows.length === 0
            ? ''
            : html`<strong
                >${formatCount(file.malformedRows.length)} שורות עם מספר עמודות חריג.</strong
              >`
        }
      </p>

      <div class="form-grid form-grid--2" style="margin-block-start: var(--space-4)">
        ${IMPORT_FIELDS.map(
          (field) => html`
            <div class="field">
              <label for="map-${field}">${FIELD_LABELS[field]}</label>
              <select class="select" id="map-${field}" data-map="${field}">
                <option value="">— לא מיובא —</option>
                ${file.headers.map(
                  (header) => html`
                    <option value="${header}" ${state.mapping[field] === header ? 'selected' : ''}>
                      ${header}
                    </option>
                  `,
                )}
              </select>
            </div>
          `,
        )}
      </div>
    </section>
  `;
}

function previewPanel(state: State): SafeHtml {
  const file = state.file;
  if (file == null) return html``;

  const results = file.rows.map((row, index) => ({
    rowNumber: index + 2,
    values: row,
    result: readRow(row, state.mapping),
  }));

  const usable = results.filter((entry) => entry.result.ok);
  const broken = results.filter((entry) => !entry.result.ok);

  return html`
    <section class="panel">
      <h2>תצוגה מקדימה</h2>

      <p class="import-summary">
        <span class="badge badge--brand">${formatCount(usable.length)} מוכנות לייבוא</span>
        ${
          broken.length === 0
            ? ''
            : html`<span class="badge">${formatCount(broken.length)} שורות ידולגו</span>`
        }
      </p>

      <div class="form-grid form-grid--2" style="margin-block-start: var(--space-4)">
        <div class="field">
          <label for="import-category">קטגוריית ברירת מחדל</label>
          <select class="select" id="import-category" data-option="defaultCategoryId">
            ${state.categories.map(
              (category) => html`
                <option
                  value="${category.id}"
                  ${state.options.defaultCategoryId === category.id ? 'selected' : ''}
                >
                  ${category.name}
                </option>
              `,
            )}
          </select>
          <span class="hint">לשורות שבהן הקטגוריה ריקה או לא מזוהה.</span>
        </div>

        <div class="field">
          <label for="import-status">מצב הסרטונים לאחר הייבוא</label>
          <select class="select" id="import-status" data-option="status">
            <option value="pending" ${state.options.status === 'pending' ? 'selected' : ''}>
              ממתין לבדיקה
            </option>
            <option value="published" ${state.options.status === 'published' ? 'selected' : ''}>
              מפורסם מיד
            </option>
          </select>
        </div>
      </div>

      <label class="check">
        <input
          type="checkbox"
          data-option="updateExisting"
          ${state.options.updateExisting ? 'checked' : ''}
        />
        לעדכן סרטונים שכבר קיימים במאגר (אחרת הם ידולגו)
      </label>

      ${previewTable(usable.slice(0, PREVIEW_ROWS))} ${problemTable(broken.slice(0, PREVIEW_ROWS))}

      <div class="import-actions">
        <button
          class="btn btn--primary"
          type="button"
          data-start-import
          ${usable.length === 0 || state.running ? 'disabled' : ''}
        >
          ייבוא ${formatCount(usable.length)} סרטונים
        </button>
        <div class="import-progress" data-import-progress hidden>
          <div class="import-progress__bar"><i data-progress-bar style="width:0%"></i></div>
          <p class="muted" data-progress-text></p>
        </div>
      </div>
    </section>
  `;
}

function previewTable(
  rows: readonly { rowNumber: number; result: ReturnType<typeof readRow> }[],
): SafeHtml {
  if (rows.length === 0) return html``;

  return html`
    <div class="table-scroll" style="margin-block-start: var(--space-4)">
      <table class="table">
        <thead>
          <tr>
            <th>שורה</th>
            <th>מזהה</th>
            <th>כותרת</th>
            <th>קטגוריה</th>
            <th>ערוץ</th>
            <th>תגיות</th>
            <th>אורך</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((entry) => {
            if (!entry.result.ok) return html``;
            const draft = entry.result.draft;
            return html`
              <tr>
                <td>${String(entry.rowNumber)}</td>
                <td><code>${draft.videoId}</code></td>
                <td>${draft.title}</td>
                <td>${draft.categoryId ?? '—'}</td>
                <td>${draft.channelName.length === 0 ? '—' : draft.channelName}</td>
                <td>${draft.tags.join(', ')}</td>
                <td>${String(draft.durationSeconds)}s</td>
              </tr>
            `;
          })}
        </tbody>
      </table>
    </div>
  `;
}

function problemTable(
  rows: readonly { rowNumber: number; result: ReturnType<typeof readRow> }[],
): SafeHtml {
  if (rows.length === 0) return html``;

  return html`
    <div class="table-scroll" style="margin-block-start: var(--space-4)">
      <h3>שורות שידולגו</h3>
      <table class="table">
        <thead>
          <tr>
            <th>שורה</th>
            <th>שדה</th>
            <th>הבעיה</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((entry) => {
            if (entry.result.ok) return html``;
            return html`${entry.result.problems.map(
              (problem) => html`
                <tr>
                  <td>${String(entry.rowNumber)}</td>
                  <td>${problem.field}</td>
                  <td>${problem.message}</td>
                </tr>
              `,
            )}`;
          })}
        </tbody>
      </table>
    </div>
  `;
}

function jobsPanel(jobs: readonly ImportJob[]): SafeHtml {
  if (jobs.length === 0) return html``;

  return html`
    <section class="panel">
      <h2>ייבואים אחרונים</h2>
      <div class="table-scroll">
        <table class="table">
          <thead>
            <tr>
              <th>קובץ</th>
              <th>מצב</th>
              <th>יובאו</th>
              <th>דולגו</th>
              <th>שגיאות</th>
              <th>מתי</th>
            </tr>
          </thead>
          <tbody>
            ${jobs.map(
              (job) => html`
                <tr>
                  <td>${job.filename}</td>
                  <td>${job.status}</td>
                  <td>${formatCount(job.importedRows)}</td>
                  <td>${formatCount(job.duplicateRows)}</td>
                  <td>${formatCount(job.invalidRows)}</td>
                  <td>${job.createdAt.slice(0, 16).replace('T', ' ')}</td>
                </tr>
              `,
            )}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

// ----------------------------------------------------------------- Wiring

function wire(container: HTMLElement, state: State, redraw: () => void): void {
  const status = select('[data-import-status]', container);

  on(select<HTMLInputElement>('#import-file', container), 'change', (event) => {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (file == null) return;

    setHtml(status, html`<p class="muted">קורא את הקובץ…</p>`);

    void readImportFile(file)
      .then((parsed) => {
        state.file = parsed;
        state.mapping = guessMapping(parsed.headers);
        redraw();
      })
      .catch((cause: unknown) => {
        const message =
          cause instanceof ImportFileError ? cause.message : 'לא הצלחנו לקרוא את הקובץ';
        setHtml(status, errorState(message));
      });
  });

  delegate(container, 'change', '[data-map]', (_event, element) => {
    const field = element.dataset.map as ImportField | undefined;
    if (field == null) return;

    const value = (element as HTMLSelectElement).value;
    state.mapping = { ...state.mapping, [field]: value.length === 0 ? null : value };
    redraw();
  });

  delegate(container, 'change', '[data-option]', (_event, element) => {
    const key = element.dataset.option;
    if (key === 'updateExisting') {
      state.options = { ...state.options, updateExisting: (element as HTMLInputElement).checked };
      return;
    }
    if (key === 'status') {
      const value = (element as HTMLSelectElement).value;
      state.options = { ...state.options, status: value === 'published' ? 'published' : 'pending' };
      return;
    }
    if (key === 'defaultCategoryId') {
      state.options = {
        ...state.options,
        defaultCategoryId: (element as HTMLSelectElement).value,
      };
    }
  });

  const startButton = container.querySelector<HTMLButtonElement>('[data-start-import]');
  if (startButton != null) {
    on(startButton, 'click', () => {
      void runImport(container, state, redraw);
    });
  }
}

/** Send the rows, one batch at a time, reporting progress as it goes. */
async function runImport(container: HTMLElement, state: State, redraw: () => void): Promise<void> {
  const file = state.file;
  if (file == null || state.running) return;

  const usable = file.rows
    .map((values, index) => ({ rowNumber: index + 2, values }))
    .filter((entry) => readRow(entry.values, state.mapping).ok);

  if (usable.length === 0) return;

  state.running = true;
  const progress = select('[data-import-progress]', container);
  const bar = select('[data-progress-bar]', container);
  const text = select('[data-progress-text]', container);
  progress.hidden = false;

  const totals = { imported: 0, updated: 0, duplicates: 0, failed: 0, rejected: 0 };

  try {
    const job = await adminApi.createImport({
      filename: file.filename,
      format: file.format,
      totalRows: usable.length,
      mapping: state.mapping,
    });

    for (let index = 0; index < usable.length; index += job.batchSize) {
      const batch = usable.slice(index, index + job.batchSize);

      const outcome = await adminApi.importRows(job.id, {
        rows: batch,
        mapping: state.mapping,
        options: state.options,
      });

      totals.imported += outcome.imported;
      totals.updated += outcome.updated;
      totals.duplicates += outcome.duplicates;
      totals.failed += outcome.failed;
      totals.rejected += outcome.rejected;

      const done = Math.min(index + job.batchSize, usable.length);
      bar.setAttribute('style', `width:${String(Math.round((done / usable.length) * 100))}%`);
      setHtml(
        text,
        html`${formatCount(done)} מתוך ${formatCount(usable.length)} — נוספו
        ${formatCount(totals.imported)}, עודכנו ${formatCount(totals.updated)}, דולגו
        ${formatCount(totals.duplicates)}`,
      );
    }

    await adminApi.completeImport(job.id, 'completed');
    toastSuccess(
      `הייבוא הסתיים: ${formatCount(totals.imported)} נוספו, ${formatCount(totals.updated)} עודכנו`,
    );
  } catch (cause) {
    toastError(cause instanceof Error ? cause.message : 'הייבוא נכשל');
  } finally {
    state.running = false;
    state.file = null;
    // Redraw from scratch: the "recent imports" table now has a new row, and
    // leaving a finished file selected invites a second accidental import.
    void renderImport(container).catch(() => {
      redraw();
    });
  }
}
