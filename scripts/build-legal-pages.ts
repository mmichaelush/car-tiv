/**
 * Rebuild `/privacy/` and `/terms/` from the legacy documents.
 *
 *     npm run legal:build
 *
 * The legal text is the one part of the old site that must survive the rewrite
 * word for word: it is a published commitment to visitors, not copy. So it is
 * never retyped. This script takes `data/legacy/*.html`, keeps the semantic
 * structure (headings, sections, lists, links) and drops only the presentation
 * — the Tailwind class soup the old pages carried — then wraps the result in
 * the new page shell.
 *
 * `tests/scripts/legal-pages.test.ts` compares the visible text of the source
 * and the output character for character, so a change in this script cannot
 * quietly lose a clause.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');

interface LegalPage {
  readonly source: string;
  readonly outputDir: string;
  readonly title: string;
  readonly description: string;
  readonly canonical: string;
}

const PAGES: readonly LegalPage[] = [
  {
    source: 'data/legacy/privacy.html',
    outputDir: 'privacy',
    title: 'מדיניות פרטיות | CAR־טיב',
    description: 'מדיניות הפרטיות של CAR־טיב: איזה מידע נשמר, למה, ואיך אפשר להסיר אותו.',
    canonical: '/privacy/',
  },
  {
    source: 'data/legacy/terms.html',
    outputDir: 'terms',
    title: 'תנאי שימוש | CAR־טיב',
    description: 'תנאי השימוש באתר CAR־טיב.',
    canonical: '/terms/',
  },
];

/**
 * Extract the inner HTML of `<main>`.
 * The legacy pages always have exactly one; anything else is a source change
 * that should fail loudly rather than produce a half page.
 */
export function extractMain(html: string): string {
  const match = /<main[^>]*>([\s\S]*?)<\/main>/i.exec(html);
  if (match?.[1] == null) throw new Error('No <main> element found in the source document');
  return match[1];
}

/**
 * Remove presentation, keep meaning.
 *
 * `class` and `style` attributes are stripped wholesale — every one of them is
 * a Tailwind utility that no longer has a stylesheet behind it. Structural
 * attributes (`id`, `href`, `lang`, `dir`, `aria-*`) are kept, because the
 * table of contents links to the section ids.
 */
export function stripPresentation(html: string): string {
  return (
    html
      .replace(/\s(?:class|style)="[^"]*"/gi, '')
      .replace(/\s(?:class|style)='[^']*'/gi, '')
      // Collapse the whitespace the old build left behind, without touching text.
      .replace(/\n\s*\n\s*\n+/g, '\n\n')
      .trim()
  );
}

/**
 * Give the migrated markup back the two hooks the stylesheet is waiting for.
 *
 * `stripPresentation` removes every `class`, which is right — they were
 * Tailwind utilities with no stylesheet behind them any more — but it also
 * took the structure with them. The table of contents is a `<nav>` holding a
 * bare `<div>` of eight `<a>`s, and an `<a>` is inline: with the classes gone
 * the eight entries ran together into one wrapped paragraph of blue text with
 * no line breaks, which is what "the contents section is missing a line break"
 * describes.
 *
 * Nothing here is new design. `.toc` already exists in `pages.css` — a grid of
 * bordered cards, used by the pages that were written rather than migrated —
 * and the migration simply never connected the two. This reconnects them, so
 * the fix is a class name rather than a second set of rules that would drift.
 *
 * `<i></i>` is the other leftover: icon-font placeholders whose class carried
 * the glyph. They hold no text, and an empty inline box between a bullet and
 * its sentence is a stray gap. Removed here rather than in
 * `stripPresentation`, which is deliberately only about attributes.
 */
export function restoreStructure(html: string): string {
  return (
    html
      // Empty icon placeholders: `<i></i>`, and the whitespace-only variants
      // the reflow left behind.
      .replace(/<i>\s*<\/i>\s*/gi, '')
      // The container of the contents links — the first `<div>` after the
      // "תוכן עניינים" heading. Anchored to the heading text so it cannot
      // match a `<div>` anywhere else in the document.
      .replace(
        /(<h2>\s*תוכן עניינים\s*<\/h2>\s*)<div>/i,
        (_match, heading: string) => `${heading}<div class="toc">`,
      )
      .replace(
        /<nav>(\s*<h2>\s*תוכן עניינים)/i,
        '<nav class="legal-toc" aria-label="תוכן עניינים">$1',
      )
  );
}

/** Visible text, used by the regression test to prove nothing was lost. */
export function visibleText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Wrap the migrated content in the new page shell. */
export function renderPage(page: LegalPage, content: string): string {
  return `<!doctype html>
<html lang="he" dir="rtl">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>${page.title}</title>
    <meta name="description" content="${page.description}" />
    <meta name="theme-color" content="#0e0916" />
    <link rel="icon" href="/assets/images/favicon.ico" />
    <link rel="manifest" href="/manifest.webmanifest" />
    <link rel="preload" href="/assets/fonts/rubik/rubik-regular.woff2" as="font" type="font/woff2" crossorigin />
    <script src="/theme-bootstrap.js"></script>
    <script type="module" src="/src/app/static-page.ts"></script>
  </head>

  <body>
    <a class="skip-link" href="#main">דילוג לתוכן</a>
    <header class="site-header" data-site-header></header>

    <main id="main" class="shell section">
      <div class="prose">
${indent(content, 8)}
      </div>
    </main>

    <footer class="site-footer" data-site-footer></footer>
  </body>
</html>
`;
}

function indent(value: string, spaces: number): string {
  const pad = ' '.repeat(spaces);
  return value
    .split('\n')
    .map((line) => (line.trim().length === 0 ? '' : pad + line.trim()))
    .join('\n');
}

async function main(): Promise<void> {
  for (const page of PAGES) {
    const source = await readFile(path.join(ROOT, page.source), 'utf8');
    const content = restoreStructure(stripPresentation(extractMain(source)));

    const before = visibleText(source);
    const after = visibleText(content);
    if (!before.includes(after.slice(0, 200))) {
      throw new Error(`Content check failed for ${page.source}: the extracted text does not match`);
    }

    const outputDir = path.join(ROOT, page.outputDir);
    await mkdir(outputDir, { recursive: true });
    await writeFile(path.join(outputDir, 'index.html'), renderPage(page, content), 'utf8');

    console.log(
      `  ${page.outputDir}/index.html — ${String(after.length)} characters of legal text preserved`,
    );
  }
}

// Only run when executed directly; the tests import the helpers above.
if (process.argv[1]?.endsWith('build-legal-pages.ts') === true) {
  await main();
}
