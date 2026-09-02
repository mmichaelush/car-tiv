/**
 * The category showcase — the "גלה את עולם הרכב" grid on the home page.
 *
 * Each card is a gradient tile with the category's icon, name, description and
 * a count of published videos. The gradient comes from the `categories` row
 * (`color_from` / `color_to`), not from a hard-coded class list, so an editor
 * can restyle a category, and adding one needs no deployment.
 *
 * Rendering is pure — the card is a plain link, so it works before any
 * JavaScript has run beyond the initial render, and middle-click behaves.
 */

import { categoryPath } from '@shared/core/paths.js';
import type { Category } from '@shared/types/catalog.js';
import { formatCount, html, type SafeHtml } from '../dom.js';
import { categoryIconName, icon } from '../icons.js';

/** One category tile. */
export function categoryCard(category: Category): SafeHtml {
  const count = category.videoCount ?? 0;

  return html`
    <a
      class="category-card"
      href="${categoryPath(category.id)}"
      style="--category-from:${category.colorFrom};--category-to:${category.colorTo}"
    >
      <span class="category-card__icon" aria-hidden="true">
        ${icon(categoryIconName(category.icon), { size: 30 })}
      </span>
      <h3 class="category-card__title">${category.name}</h3>
      <p class="category-card__description">${category.description}</p>
      <span class="category-card__count">${formatCount(count)}</span>
    </a>
  `;
}

/** The whole grid. */
export function categoryGrid(categories: readonly Category[]): SafeHtml {
  return html`${categories.map((category) => categoryCard(category))}`;
}
