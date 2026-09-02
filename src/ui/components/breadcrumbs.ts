/**
 * Breadcrumbs.
 *
 * Two jobs at once: the visible trail a visitor uses to climb back up, and the
 * `BreadcrumbList` structured data that lets a search engine show the same
 * trail under the result. Emitting both from one call is what keeps them from
 * drifting apart — the classic failure is a page whose visible trail and whose
 * markup disagree.
 *
 * The last crumb is the current page: it is rendered as text, not a link, and
 * marked `aria-current="page"`.
 */

import { absoluteUrl } from '@shared/core/paths.js';
import { html, setHtml, type SafeHtml } from '../dom.js';
import { setStructuredData } from '../structured-data.js';

export interface Crumb {
  readonly label: string;
  /** Omitted on the final crumb, which is the page you are already on. */
  readonly href?: string;
}

/** The visible trail. */
export function breadcrumbs(items: readonly Crumb[]): SafeHtml {
  return html`
    <nav class="breadcrumbs" aria-label="מסלול ניווט">
      <ol>
        ${items.map(
          (crumb, index) => html`
            <li>
              ${
                crumb.href == null || index === items.length - 1
                  ? html`<span aria-current="page">${crumb.label}</span>`
                  : html`<a href="${crumb.href}">${crumb.label}</a>`
              }
            </li>
          `,
        )}
      </ol>
    </nav>
  `;
}

/**
 * Render the trail into `container` and publish the matching structured data.
 */
export function mountBreadcrumbs(container: Element, items: readonly Crumb[]): void {
  setHtml(container, breadcrumbs(items));

  setStructuredData('breadcrumbs', {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((crumb, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: crumb.label,
      ...(crumb.href == null ? {} : { item: absoluteUrl(crumb.href, window.location.origin) }),
    })),
  });
}
