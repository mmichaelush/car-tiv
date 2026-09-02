/**
 * The legal pages are a published commitment to visitors. This suite is the
 * guarantee that migrating them into the new shell cannot lose a word.
 */

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { extractMain, stripPresentation, visibleText } from '../../scripts/build-legal-pages.js';

const SOURCES = ['data/legacy/privacy.html', 'data/legacy/terms.html'] as const;
const OUTPUTS = ['privacy/index.html', 'terms/index.html'] as const;

describe.each(SOURCES.map((source, index) => [source, OUTPUTS[index]] as const))(
  'legal page %s',
  (source, output) => {
    it('keeps every word of the original', async () => {
      const original = visibleText(extractMain(await readFile(source, 'utf8')));
      const migrated = visibleText(await readFile(output ?? '', 'utf8'));

      // The migrated page also contains the shell (skip link, header, footer),
      // so the assertion is containment, not equality.
      expect(migrated).toContain(original);
    });

    it('keeps every heading', async () => {
      const originalHtml = await readFile(source, 'utf8');
      const migratedHtml = await readFile(output ?? '', 'utf8');

      const headings = [...originalHtml.matchAll(/<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/gi)].map(
        (match) => visibleText(match[2] ?? ''),
      );

      expect(headings.length).toBeGreaterThan(3);
      for (const heading of headings) {
        expect(visibleText(migratedHtml)).toContain(heading);
      }
    });

    it('keeps every outbound link', async () => {
      const originalHtml = await readFile(source, 'utf8');
      const migratedHtml = await readFile(output ?? '', 'utf8');

      const links = [...originalHtml.matchAll(/<a[^>]+href="([^"]+)"/gi)]
        .map((match) => match[1] ?? '')
        .filter((href) => href.startsWith('http') || href.startsWith('mailto:'));

      for (const link of new Set(links)) {
        expect(migratedHtml).toContain(link);
      }
    });

    it('keeps the section ids the table of contents links to', async () => {
      const originalHtml = extractMain(await readFile(source, 'utf8'));
      const migratedHtml = await readFile(output ?? '', 'utf8');

      const ids = [...originalHtml.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1] ?? '');
      for (const id of ids) {
        expect(migratedHtml).toContain(`id="${id}"`);
      }
    });
  },
);

describe('stripPresentation', () => {
  it('removes class and style attributes', () => {
    const result = stripPresentation('<p class="text-xl font-bold" style="color:red">שלום</p>');
    expect(result).toBe('<p>שלום</p>');
  });

  it('keeps structural attributes', () => {
    const result = stripPresentation(
      '<section id="rights" class="mb-8" aria-label="זכויות"></section>',
    );
    expect(result).toContain('id="rights"');
    expect(result).toContain('aria-label="זכויות"');
  });

  it('does not touch the text itself', () => {
    const text = 'עודכן לאחרונה: <strong>1 בינואר 2026</strong>';
    expect(stripPresentation(`<p class="x">${text}</p>`)).toContain(text);
  });
});

describe('extractMain', () => {
  it('throws when the document has no main element, rather than emitting half a page', () => {
    expect(() => extractMain('<html><body><p>hi</p></body></html>')).toThrow();
  });
});
