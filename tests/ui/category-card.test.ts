// @vitest-environment happy-dom

/**
 * The category showcase is the first thing on the home page below the hero,
 * and it is driven entirely by database columns — icon name and two gradient
 * colours. These tests pin that wiring, including what happens when a category
 * arrives with an icon name this build has never heard of.
 */

import { describe, expect, it } from 'vitest';
import type { Category } from '@shared/types/catalog.js';
import { categoryCard, categoryGrid } from '@src/ui/components/category-card.js';
import { categoryIconName } from '@src/ui/icons.js';
import { setHtml } from '@src/ui/dom.js';

const category = (overrides: Partial<Category> = {}): Category => ({
  id: 'maintenance',
  name: 'טיפולים',
  description: 'תחזוקה שוטפת ומניעתית',
  icon: 'oil-can',
  colorFrom: '#2563eb',
  colorTo: '#4338ca',
  sortOrder: 20,
  isVisible: true,
  videoCount: 1234,
  ...overrides,
});

function render(value: Category): HTMLElement {
  const container = document.createElement('div');
  setHtml(container, categoryCard(value));
  return container;
}

describe('categoryCard', () => {
  it('links to the category page', () => {
    expect(render(category()).querySelector('a')?.getAttribute('href')).toBe(
      '/category/maintenance',
    );
  });

  it('paints the gradient from the row, not from a hard-coded class', () => {
    const style = render(category()).querySelector('a')?.getAttribute('style') ?? '';
    expect(style).toContain('--category-from:#2563eb');
    expect(style).toContain('--category-to:#4338ca');
  });

  it('shows the video count with Hebrew digit grouping', () => {
    expect(render(category()).querySelector('.category-card__count')?.textContent?.trim()).toBe(
      '1,234',
    );
  });

  it('shows a zero rather than an empty badge when the count is missing', () => {
    const withoutCount = category();
    const { videoCount: _unused, ...rest } = withoutCount;
    expect(
      render(rest as Category)
        .querySelector('.category-card__count')
        ?.textContent?.trim(),
    ).toBe('0');
  });

  it('renders an icon', () => {
    expect(render(category()).querySelector('.category-card__icon svg')).not.toBeNull();
  });

  it('escapes a hostile name', () => {
    const container = render(category({ name: '<script>x</script>' }));
    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toContain('<script>x</script>');
  });
});

describe('categoryGrid', () => {
  it('renders one tile per category', () => {
    const container = document.createElement('div');
    setHtml(container, categoryGrid([category(), category({ id: 'diy', name: 'עשה זאת בעצמך' })]));
    expect(container.querySelectorAll('.category-card')).toHaveLength(2);
  });
});

describe('categoryIconName', () => {
  it('maps the legacy Font Awesome names the database still stores', () => {
    expect(categoryIconName('oil-can')).toBe('oilCan');
    expect(categoryIconName('screwdriver-wrench')).toBe('wrench');
    expect(categoryIconName('magnifying-glass-chart')).toBe('chart');
    expect(categoryIconName('car-side')).toBe('car');
  });

  it('falls back to a neutral glyph for an unknown or missing name', () => {
    expect(categoryIconName('something-nobody-drew')).toBe('film');
    expect(categoryIconName(null)).toBe('film');
    expect(categoryIconName(undefined)).toBe('film');
  });
});
