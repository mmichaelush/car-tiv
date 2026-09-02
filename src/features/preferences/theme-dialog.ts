/**
 * The appearance and preferences dialog.
 *
 * Everything is applied the moment it changes — there is no "save" button,
 * because there is nothing to save to: the change is written to local storage
 * and onto `<html>` in the same call, and the dialog is sitting on top of the
 * page it just restyled. Choosing a theme *is* the preview.
 *
 * Themes are picked from swatches rather than a dropdown for the same reason.
 * "אוקיינוס" tells you nothing; two squares of the actual colours tell you
 * everything, and the list stops being a memory test.
 */

import { html, on, select, selectAll, setAttribute } from '../../ui/dom.js';
import { openDialog } from '../../ui/components/dialog.js';
import { icon } from '../../ui/icons.js';
import { toastSuccess } from '../../ui/components/toast.js';
import {
  ACCENT_OPTIONS,
  DENSITY_OPTIONS,
  TEXT_SIZE_OPTIONS,
  THEME_OPTIONS,
  readPreferences,
  resetPreferences,
  updatePreferences,
} from './preferences.js';
import type { AccentName, Density, TextSize, ThemeName } from '@shared/types/user.js';

export function openThemeDialog(): void {
  const preferences = readPreferences();

  const handle = openDialog({
    title: 'עיצוב והעדפות',
    body: html`
      <div class="form-grid">
        <div class="field">
          <span class="label">${icon('sparkle', { size: 16 })} ערכת נושא</span>
          <div class="theme-picker" role="radiogroup" aria-label="ערכת נושא">
            ${THEME_OPTIONS.map(
              (option) => html`
                <button
                  type="button"
                  class="theme-swatch"
                  role="radio"
                  data-theme-choice="${option.value}"
                  aria-checked="${option.value === preferences.theme ? 'true' : 'false'}"
                  title="${option.label}"
                >
                  <span
                    class="theme-swatch__preview"
                    aria-hidden="true"
                    style="--swatch-bg:${option.swatch[0]};--swatch-fg:${option.swatch[1]}"
                  ></span>
                  <span class="theme-swatch__label">${option.label}</span>
                </button>
              `,
            )}
          </div>
          <span class="hint">הבחירה נשמרת בדפדפן שלכם ונטענת מיד עם פתיחת האתר.</span>
        </div>

        <div class="field">
          <span class="label">צבע הדגשה</span>
          <div class="accent-picker" role="radiogroup" aria-label="צבע הדגשה">
            ${ACCENT_OPTIONS.map(
              (option) => html`
                <button
                  type="button"
                  class="accent-swatch"
                  role="radio"
                  data-accent="${option.value}"
                  aria-checked="${option.value === preferences.accent ? 'true' : 'false'}"
                  aria-label="${option.label}"
                  title="${option.label}"
                  style="--swatch:${option.color}"
                >
                  ${icon('check', { size: 14 })}
                </button>
              `,
            )}
          </div>
        </div>

        <div class="field">
          <span class="label">${icon('text', { size: 16 })} גודל הטקסט</span>
          <div class="tag-cloud">
            ${TEXT_SIZE_OPTIONS.map(
              (option) => html`
                <button
                  type="button"
                  class="chip"
                  data-textSize="${option.value}"
                  aria-pressed="${option.value === preferences.textSize ? 'true' : 'false'}"
                >
                  ${option.label}
                </button>
              `,
            )}
          </div>
          <span class="hint">משנה את הטקסט בלבד — הכרטיסים נשארים באותו גודל.</span>
        </div>

        <div class="field">
          <span class="label">צפיפות הממשק</span>
          <div class="tag-cloud">
            ${DENSITY_OPTIONS.map(
              (option) => html`
                <button
                  type="button"
                  class="chip"
                  data-density="${option.value}"
                  aria-pressed="${option.value === preferences.density ? 'true' : 'false'}"
                >
                  ${option.label}
                </button>
              `,
            )}
          </div>
        </div>

        <div class="field">
          <span class="label">קריאה וגלישה</span>
          <label class="check">
            <input
              type="checkbox"
              data-pref="hebrewOnly"
              ${preferences.hebrewOnly ? 'checked' : ''}
            />
            להציג כברירת מחדל תוכן בעברית בלבד
          </label>
          <label class="check">
            <input
              type="checkbox"
              data-pref="infiniteScroll"
              ${preferences.infiniteScroll ? 'checked' : ''}
            />
            טעינה אוטומטית בגלילה, במקום כפתור "הצגת סרטונים נוספים"
          </label>
          <label class="check">
            <input
              type="checkbox"
              data-pref="saveHistory"
              ${preferences.saveHistory ? 'checked' : ''}
            />
            לשמור היסטוריית צפייה במכשיר הזה
          </label>
          <label class="check">
            <input
              type="checkbox"
              data-pref="reduceMotion"
              ${preferences.reduceMotion ? 'checked' : ''}
            />
            להפחית אנימציות ומעברים
          </label>
        </div>
      </div>
    `,
    footer: html`
      <button type="button" class="btn btn--ghost" data-reset>איפוס להגדרות ברירת המחדל</button>
      <button type="button" class="btn btn--primary" data-done>סיום</button>
    `,
  });

  const { element } = handle;

  bindRadioGroup(element, '[data-theme-choice]', 'themeChoice', (value) => {
    updatePreferences({ theme: value as ThemeName });
  });
  bindRadioGroup(element, '[data-accent]', 'accent', (value) => {
    updatePreferences({ accent: value as AccentName });
  });
  bindRadioGroup(element, '[data-textSize]', 'textsize', (value) => {
    updatePreferences({ textSize: value as TextSize });
  });
  bindRadioGroup(element, '[data-density]', 'density', (value) => {
    updatePreferences({ density: value as Density });
  });

  for (const checkbox of selectAll<HTMLInputElement>(
    'input[type="checkbox"][data-pref]',
    element,
  )) {
    on(checkbox, 'change', () => {
      const key = checkbox.dataset.pref;
      if (key == null) return;
      updatePreferences({ [key]: checkbox.checked });
    });
  }

  on(select('[data-reset]', element), 'click', () => {
    resetPreferences();
    handle.close();
    toastSuccess('ההעדפות אופסו');
  });

  on(select('[data-done]', element), 'click', () => {
    handle.close();
  });
}

/**
 * Wire a group of buttons so exactly one is selected.
 *
 * Both `aria-pressed` (used by the chips) and `aria-checked` (used by the
 * swatches, which are real radios) are updated, so the same helper serves
 * both without either lying to a screen reader.
 */
function bindRadioGroup(
  scope: ParentNode,
  selector: string,
  datasetKey: string,
  onSelect: (value: string) => void,
): void {
  const buttons = selectAll<HTMLButtonElement>(selector, scope);

  for (const button of buttons) {
    on(button, 'click', () => {
      const value = button.dataset[datasetKey];
      if (value == null) return;

      for (const other of buttons) {
        const selected = String(other === button);
        if (other.hasAttribute('aria-checked')) setAttribute(other, 'aria-checked', selected);
        else setAttribute(other, 'aria-pressed', selected);
      }

      onSelect(value);
    });
  }
}
