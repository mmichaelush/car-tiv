// @vitest-environment happy-dom

/**
 * Breadcrumbs carry two things that have to agree: what a visitor sees and
 * what a search engine reads. These tests pin both, and the escaping of a
 * label that came out of the catalog.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { breadcrumbs, mountBreadcrumbs } from '@src/ui/components/breadcrumbs.js';
import { setHtml } from '@src/ui/dom.js';

function render(): HTMLElement {
  const container = document.createElement('div');
  setHtml(
    container,
    breadcrumbs([
      { label: 'דף הבית', href: '/' },
      { label: 'טיפולים', href: '/category/maintenance' },
      { label: 'החלפת שמן' },
    ]),
  );
  return container;
}

describe('breadcrumbs', () => {
  it('links every crumb except the current page', () => {
    const container = render();
    expect(container.querySelectorAll('a')).toHaveLength(2);
    expect(container.querySelector('[aria-current="page"]')?.textContent?.trim()).toBe('החלפת שמן');
  });

  it('is announced as a navigation landmark with a name', () => {
    expect(render().querySelector('nav')?.getAttribute('aria-label')).toBe('מסלול ניווט');
  });

  it('never links the last crumb, even when a href is supplied', () => {
    const container = document.createElement('div');
    setHtml(container, breadcrumbs([{ label: 'ערוצים', href: '/channels/' }]));
    expect(container.querySelector('a')).toBeNull();
  });

  it('escapes a label that came from the catalog', () => {
    const container = document.createElement('div');
    setHtml(container, breadcrumbs([{ label: '<img src=x onerror=alert(1)>' }]));
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});

describe('mountBreadcrumbs', () => {
  beforeEach(() => {
    document.head.querySelectorAll('script[data-ld]').forEach((node) => {
      node.remove();
    });
  });

  it('publishes a BreadcrumbList with absolute item URLs', () => {
    const container = document.createElement('div');
    mountBreadcrumbs(container, [
      { label: 'דף הבית', href: '/' },
      { label: 'טיפולים', href: '/category/maintenance' },
      { label: 'החלפת שמן' },
    ]);

    const script = document.head.querySelector('script[data-ld="breadcrumbs"]');
    expect(script).not.toBeNull();

    const data = JSON.parse(script?.textContent ?? '{}') as {
      '@type': string;
      itemListElement: { position: number; name: string; item?: string }[];
    };

    expect(data['@type']).toBe('BreadcrumbList');
    expect(data.itemListElement.map((entry) => entry.position)).toEqual([1, 2, 3]);
    expect(data.itemListElement[1]?.item).toMatch(/^https?:\/\/.+\/category\/maintenance$/);
    // The current page carries no `item`: it is where the visitor already is.
    expect(data.itemListElement[2]).not.toHaveProperty('item');
  });

  it('replaces the previous block instead of stacking a second one', () => {
    const container = document.createElement('div');
    mountBreadcrumbs(container, [{ label: 'א' }]);
    mountBreadcrumbs(container, [{ label: 'ב' }]);

    expect(document.head.querySelectorAll('script[data-ld="breadcrumbs"]')).toHaveLength(1);
    expect(document.head.querySelector('script[data-ld="breadcrumbs"]')?.textContent).toContain(
      'ב',
    );
  });
});
