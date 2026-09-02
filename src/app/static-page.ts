/**
 * Pages that are only content: about, privacy, terms.
 *
 * They need the shell and the theme, nothing more. The one enhancement is a
 * table of contents for the long legal documents, built from the headings that
 * are already in the markup rather than maintained by hand.
 */

import { startPage } from './bootstrap.js';
import { html, select, selectAll } from '../ui/dom.js';

startPage({ active: window.location.pathname.startsWith('/about') ? 'about' : null });

buildTableOfContents();

/**
 * Insert a table of contents above a long document.
 *
 * Only runs when the page has four or more `<h2>` elements with ids — which is
 * true of the legal pages and of nothing else.
 */
function buildTableOfContents(): void {
  const prose = document.querySelector('.prose');
  if (prose == null) return;

  const headings = selectAll<HTMLHeadingElement>('h2[id]', prose);
  if (headings.length < 4) return;

  const nav = document.createElement('nav');
  nav.className = 'toc';
  nav.setAttribute('aria-label', 'תוכן העניינים');
  nav.innerHTML = html`${headings.map(
    (heading) => html`<a href="#${heading.id}">${heading.textContent ?? ''}</a>`,
  )}`.value;

  const firstHeading = headings[0];
  if (firstHeading?.parentElement != null) {
    firstHeading.parentElement.insertBefore(nav, firstHeading);
  } else {
    select('.prose').prepend(nav);
  }
}
