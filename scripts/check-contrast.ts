/**
 * Every theme, in both modes, checked against WCAG contrast.
 *
 * ## Why this is a script and not a unit test
 *
 * The themes are twenty pairs of `light-dark()` values resolved by the browser
 * against `color-scheme`. Nothing in Node resolves `light-dark()`, and nothing
 * short of a real engine resolves the cascade that decides which of the two
 * halves applies — so a unit test here could only re-implement the browser and
 * then agree with itself. This drives the actual built page in the actual
 * browser and reads `getComputedStyle`, which is the only reading that means
 * anything.
 *
 * Two mistakes this exists because of:
 *
 *  * The first version of this harness set `data-theme` on a `<div>` and
 *    reported identical values for all twenty themes, because
 *    `:root[data-theme=…]` only ever matches `<html>`. It sets the attribute on
 *    `document.documentElement` and iterates.
 *  * The second reported a contrast of 1.0 for every chip and status pill,
 *    because those have translucent backgrounds — `rgb(r g b / 15%)` compared
 *    against itself is a comparison of a colour with a colour. Translucent
 *    layers are composited over their parent before the ratio is taken.
 *
 * ## Running it
 *
 *     npm run build && npx tsx scripts/check-contrast.ts
 *
 * Exits non-zero on any failure, so it can gate a release. It is not in `npm
 * test` because it needs a browser and a build; it is the check to run after
 * touching `src/styles/themes.css` or `tokens.css`.
 */

import process from 'node:process';
import path from 'node:path';
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { chromium } from 'playwright';

/**
 * The page the themes are read from. Any built page will do.
 *
 * Served over HTTP rather than opened as a `file://` URL: a stylesheet loaded
 * from `file://` is cross-origin to the document, so `sheet.cssRules` throws
 * and the page silently sees no styles at all.
 */
const DIST = path.resolve(import.meta.dirname, '..', 'dist');

/**
 * Contrast floors.
 *
 * 4.5 is WCAG AA for body text. 3.0 is AA for large text (18.66px bold or
 * 24px) and for the boundary of a user-interface component, which is what a
 * border or a divider is — holding those to 4.5 would produce a site drawn in
 * heavy black lines, which is a different accessibility problem.
 */
const AA_TEXT = 4.5;
const AA_LARGE = 3;

/**
 * Below this many themes, assume the harness is broken rather than the
 * stylesheet empty. `src/styles/themes.css` ships twenty.
 */
const MINIMUM_THEMES = 15;

/**
 * The themes, read from the two files that have to agree about them.
 *
 * Both are read as text rather than imported: `preferences.ts` is browser code
 * and pulling it into this script drags the DOM into the Node project. Reading
 * both also makes the disagreement itself checkable — a theme offered in the
 * settings dialog with no CSS behind it, or a palette in the stylesheet nobody
 * can choose, are both bugs, and neither shows up if only one file is
 * consulted.
 */
function readThemes(): { offered: string[]; styled: string[] } {
  const source = path.resolve(import.meta.dirname, '..', 'src');

  const options = readFileSync(path.join(source, 'features/preferences/preferences.ts'), 'utf8');
  const from = options.indexOf('THEME_OPTIONS');
  // Bounded at the array's own closing bracket: every other option list in that
  // file — accent, density, text size, view mode — has `value:` entries too,
  // and an unbounded slice happily reported `compact` and `xlarge` as themes.
  const to = options.indexOf('\n];', from);
  const block = options.slice(from, to === -1 ? undefined : to);
  const offered = [...block.matchAll(/value:\s*'([a-z-]+)'/g)].map((match) => match[1] ?? '');

  const css = readFileSync(path.join(source, 'styles/themes.css'), 'utf8');
  const styled = [
    ...new Set([...css.matchAll(/\[data-theme=['"]([a-z-]+)['"]\]/g)].map((m) => m[1] ?? '')),
  ];

  return { offered: [...new Set(offered)].sort(), styled: styled.sort() };
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

/** One pair to measure: a foreground token over a background token. */
interface Check {
  readonly name: string;
  readonly foreground: string;
  readonly background: string;
  readonly minimum: number;
}

const CHECKS: readonly Check[] = [
  { name: 'body text', foreground: '--text', background: '--bg', minimum: AA_TEXT },
  { name: 'muted text', foreground: '--text-muted', background: '--bg', minimum: AA_TEXT },
  { name: 'subtle text', foreground: '--text-subtle', background: '--bg', minimum: AA_LARGE },
  { name: 'text on a card', foreground: '--text', background: '--surface', minimum: AA_TEXT },
  {
    name: 'muted on a card',
    foreground: '--text-muted',
    background: '--surface',
    minimum: AA_TEXT,
  },
  { name: 'brand link', foreground: '--brand', background: '--bg', minimum: AA_LARGE },
  { name: 'brand on a card', foreground: '--brand', background: '--surface', minimum: AA_LARGE },
  { name: 'text on the brand', foreground: '--on-brand', background: '--brand', minimum: AA_TEXT },
  { name: 'chip text', foreground: '--text-muted', background: '--surface-2', minimum: AA_TEXT },
  { name: 'danger', foreground: '--danger', background: '--bg', minimum: AA_LARGE },
  { name: 'success', foreground: '--success', background: '--bg', minimum: AA_LARGE },
  { name: 'warning', foreground: '--warning', background: '--bg', minimum: AA_LARGE },
  { name: 'divider', foreground: '--line', background: '--bg', minimum: 1.2 },
];

interface Result {
  readonly theme: string;
  readonly mode: string;
  readonly check: string;
  readonly ratio: number;
  readonly minimum: number;
}

/**
 * The measurement, as source text for the page to evaluate.
 *
 * See the call site for why this is a string rather than a function. The
 * checks are embedded into it, so the page needs no argument, and it returns
 * only the failures.
 */
const browserCheck = (checks: readonly Check[], themes: readonly string[]): string => `(() => {
  const checks = ${JSON.stringify(checks)};
  /** \`rgb(r g b / a)\` or \`rgb(r, g, b)\` to channels. */
  const parse = (value) => {
    const numbers = [...value.matchAll(/[\\d.]+/g)].map((match) => Number(match[0]));
    const [r = 0, g = 0, b = 0, a = 1] = numbers;
    return [r, g, b, a];
  };

  /**
   * Composite a translucent colour over an opaque one.
   *
   * Without this every chip and status pill measured 1.0 — a translucent
   * \`rgb(r g b / 15%)\` compared against itself is a colour compared with
   * itself, which is a ratio of one and tells you nothing.
   */
  const over = (top, bottom) => {
    const alpha = top[3];
    return [
      top[0] * alpha + bottom[0] * (1 - alpha),
      top[1] * alpha + bottom[1] * (1 - alpha),
      top[2] * alpha + bottom[2] * (1 - alpha),
      1,
    ];
  };

  const luminance = ([r, g, b]) => {
    const channel = (value) => {
      const scaled = value / 255;
      return scaled <= 0.03928 ? scaled / 12.92 : Math.pow((scaled + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  };

  const contrast = (a, b) => {
    const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (values[0] + 0.05) / (values[1] + 0.05);
  };

  // The attribute goes on <html>. An earlier version of this put it on a
  // <div> and reported identical numbers for all twenty themes, because
  // \`:root[data-theme=…]\` only ever matches the root element.
  const root = document.documentElement;

  // The list comes from \`THEME_OPTIONS\` — the same array the settings dialog
  // renders — rather than from scraping the stylesheet. Scraping was how an
  // earlier version came back green having measured nothing at all, and this
  // way a theme that is offered to a person but has no CSS behind it is caught
  // by the fingerprint check below instead of quietly skipped.
  const themes = ${JSON.stringify(themes)};

  // A probe inside the document, so it inherits the root's \`color-scheme\` and
  // therefore resolves \`light-dark()\` the way the real page does.
  const probe = document.createElement('span');
  probe.style.display = 'none';
  document.body.append(probe);

  const results = [];
  const fingerprints = [];
  const original = {
    theme: root.getAttribute('data-theme'),
    mode: root.getAttribute('data-mode'),
  };

  for (const theme of themes) {
    for (const mode of ['light', 'dark']) {
      root.setAttribute('data-theme', theme);
      root.setAttribute('data-mode', mode);

      // Read through a real property, not through \`getPropertyValue\`.
      //
      // The computed value of a *custom* property is its token stream, so a
      // token defined as \`light-dark(#1a1a1a, #f0f0f0)\` comes back as that
      // literal text — \`light-dark()\` is only resolved when the value is used
      // by an actual property. Parsing the raw text produced numbers from the
      // hex digits and contrast ratios below zero, and the same answer for
      // light and dark, which is how this harness reported nonsense with
      // complete confidence. Assigning to \`color\` and reading it back is what
      // makes the browser do the resolving.
      const resolve = (name) => {
        probe.style.color = 'var(' + name + ')';
        return parse(getComputedStyle(probe).color);
      };
      const token = resolve;
      const ground = token('--bg');

      fingerprints.push(
        theme + '/' + mode + '=' +
        resolve('--bg').join() + '|' + resolve('--brand').join() + '|' +
        resolve('--surface').join(),
      );

      for (const check of checks) {
        const background = over(token(check.background), ground);
        const foreground = over(token(check.foreground), background);
        const ratio = contrast(foreground, background);

        if (ratio < check.minimum) {
          results.push({
            theme,
            mode,
            check: check.name,
            ratio: Math.round(ratio * 100) / 100,
            minimum: check.minimum,
          });
        }
      }
    }
  }

  if (original.theme !== null) root.setAttribute('data-theme', original.theme);
  if (original.mode !== null) root.setAttribute('data-mode', original.mode);
  probe.remove();
  return { themes, results, fingerprints };
})()`;

async function main(): Promise<void> {
  const { offered, styled } = readThemes();

  const missing = offered.filter((theme) => !styled.includes(theme));
  const orphaned = styled.filter((theme) => !offered.includes(theme));
  if (missing.length > 0 || orphaned.length > 0) {
    if (missing.length > 0) {
      console.error(`✗ offered with no CSS: ${missing.join(', ')}`);
    }
    if (orphaned.length > 0) {
      console.error(`✗ styled but not offered to anyone: ${orphaned.join(', ')}`);
    }
    process.exitCode = 1;
    return;
  }

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const file = path.join(DIST, url.pathname === '/' ? '/index.html' : url.pathname);
    if (!file.startsWith(DIST) || !existsSync(file) || statSync(file).isDirectory()) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': CONTENT_TYPES[path.extname(file)] ?? 'text/plain' });
    response.end(readFileSync(file));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address != null ? address.port : 0;

  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium',
  });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${String(port)}/`, { waitUntil: 'load' });

  // Passed as source text rather than as a function, deliberately. `tsx`
  // transpiles with esbuild's `keepNames`, which rewrites every function
  // declaration to call a `__name` helper that exists in Node and not in the
  // page — so a perfectly ordinary closure handed to `page.evaluate` dies with
  // "__name is not defined" the moment it runs in the browser. A self-calling
  // expression with its input already embedded is evaluated by the page
  // exactly as written, and needs no argument marshalling either.
  const report = await page.evaluate<{
    themes: string[];
    results: Result[];
    fingerprints: string[];
  }>(browserCheck(CHECKS, offered));
  const failures = report.results;

  await browser.close();
  server.close();

  // A harness that measured nothing reports success, which is the worst
  // possible outcome for a check like this — and it is exactly what happened
  // the first time, when the selector never matched. If the themes cannot be
  // found, that is a failure, not a pass.
  if (report.themes.length < MINIMUM_THEMES) {
    console.error(
      `✗ found only ${String(report.themes.length)} themes in the stylesheet — ` +
        `expected at least ${String(MINIMUM_THEMES)}. The harness is measuring nothing.`,
    );
    process.exitCode = 1;
    return;
  }

  // Every theme/mode combination must actually look different. A theme offered
  // in the settings dialog but missing from `themes.css` resolves to the
  // fallback tokens and passes every contrast check — by being an exact copy of
  // another theme. That is a bug a person notices immediately and a ratio never
  // will, so it is checked here rather than trusted.
  const distinct = new Set(report.fingerprints).size;
  const expected = report.themes.length * 2;
  if (distinct < expected) {
    console.error(
      `✗ ${String(expected)} theme/mode combinations resolve to only ` +
        `${String(distinct)} distinct palettes — one of them has no CSS behind it.`,
    );
    process.exitCode = 1;
    return;
  }

  if (failures.length === 0) {
    console.log(
      `✓ ${String(report.themes.length)} themes × 2 modes × ` +
        `${String(CHECKS.length)} checks — all pass, all palettes distinct`,
    );
    return;
  }

  console.error(`✗ ${String(failures.length)} contrast failures\n`);
  for (const failure of failures) {
    console.error(
      `  ${failure.theme} / ${failure.mode}: ${failure.check} — ` +
        `${String(failure.ratio)}:1, needs ${String(failure.minimum)}:1`,
    );
  }
  process.exitCode = 1;
}

await main();
