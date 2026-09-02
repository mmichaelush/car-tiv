/**
 * `/add-video/` — suggest a video for the catalog.
 *
 * The duplicate check runs before the visitor fills anything else in, because
 * "this is already in the catalog" is the most common answer and the cheapest
 * one to give early.
 */

import { extractVideoId } from '@shared/core/youtube.js';
import { videoPath } from '@shared/core/paths.js';
import { startPage } from './bootstrap.js';
import { catalog } from '../data/catalog-repository.js';
import { engagement } from '../data/engagement-repository.js';
import { field, mountForm, optionalField } from './forms.js';
import { html, on, select, setHtml } from '../ui/dom.js';

startPage({ active: 'add-video' });

const checkForm = select<HTMLFormElement>('[data-duplicate-form]');
const checkResult = select('[data-check-result]');
const categorySelect = select<HTMLSelectElement>('[data-category-select]');

// Populate the category list from the API, so a new category appears here
// without a code change.
void catalog
  .listCategories()
  .then((categories) => {
    for (const category of categories) {
      const option = document.createElement('option');
      option.value = category.id;
      option.textContent = category.name;
      categorySelect.append(option);
    }
  })
  .catch(() => {
    // The field is optional; leaving it as "not sure" is fine.
  });

on(checkForm, 'submit', (event) => {
  event.preventDefault();
  void runDuplicateCheck(field(new FormData(checkForm), 'url'));
});

async function runDuplicateCheck(value: string): Promise<void> {
  const id = extractVideoId(value);
  if (id == null) {
    show('הקישור או המזהה אינם נראים תקינים. אפשר להדביק קישור מלא מ־YouTube.', 'error');
    return;
  }

  try {
    const state = await catalog.videoExists(value);

    if (state.published) {
      setHtml(
        checkResult,
        html`הסרטון כבר נמצא במאגר. <a href="${videoPath(id)}">אפשר לצפות בו כאן</a>.`,
      );
      checkResult.dataset.tone = 'warning';
      checkResult.hidden = false;
      return;
    }

    if (state.pending) {
      show('הסרטון כבר הוצע וממתין לבדיקה. תודה!', 'warning');
      return;
    }

    show('הסרטון עדיין לא במאגר — אפשר לשלוח אותו בטופס שלמטה.', 'success');
  } catch {
    show('לא הצלחנו לבדוק כרגע. אפשר פשוט לשלוח את ההצעה ואנחנו נבדוק.', 'warning');
  }
}

function show(message: string, tone: 'success' | 'warning' | 'error'): void {
  setHtml(checkResult, html`${message}`);
  checkResult.dataset.tone = tone;
  checkResult.hidden = false;
}

mountForm({
  form: select<HTMLFormElement>('[data-submission-form]'),
  successMessage: 'ההצעה נשלחה',
  // If our own API cannot take the suggestion, point at the Google Form the
  // site used before it. A visitor who took the trouble to find a video should
  // not lose it to an outage of ours.
  onServerFailure: () => {
    const fallback = document.querySelector<HTMLElement>('[data-legacy-form]');
    if (fallback == null) return;
    fallback.dataset.highlighted = 'true';
    fallback.scrollIntoView({ behavior: 'smooth', block: 'center' });
  },
  submit: async (data) => {
    await engagement.submitVideo({
      url: field(data, 'url'),
      category: optionalField(data, 'category'),
      name: optionalField(data, 'name'),
      email: optionalField(data, 'email'),
      message: optionalField(data, 'message'),
    });
  },
});
