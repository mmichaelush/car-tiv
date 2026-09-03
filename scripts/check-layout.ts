/**
 * Does any page scroll sideways?
 *
 * ## Why this exists
 *
 * The footer's grid asked for `minmax(200px, 1.3fr) repeat(auto-fit,
 * minmax(140px, 1fr))` at every width. A grid track does not shrink or wrap
 * below its minimum — it overflows — so on a 390px phone the footer was 27px
 * wider than the screen, and because it is the widest element on the page the
 * *whole document* scrolled sideways. On every page of the site.
 *
 * That bug survived a full visual review of the site, on a phone viewport, with
 * screenshots. It had to: a screenshot is taken at the scroll origin, and the
 * overflow is 27px past the far edge of it. Nothing is visibly wrong. The only
 * way to see it is to ask the browser for a number, which is what this does.
 *
 * It is a browser script rather than a unit test for the same reason the
 * contrast harness is: happy-dom does not do layout, so a unit test here could
 * only assert what someone wrote down, not what the engine computed.
 *
 * ## Running it
 *
 *     npm run build && npm run check:layout
 *
 * It starts the real Worker over the real catalog on port 4180 — the same
 * server `tests/helpers/dev-server.ts` provides — because the elements most
 * likely to overflow (card grids, tag rows, tables, long Hebrew titles) do not
 * exist on a page with no data.
 */

import process from 'node:process';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';

const ORIGIN = 'http://127.0.0.1:4180';

/**
 * The widths that matter.
 *
 * 320 is the narrowest phone still in use and the width every "it overflows"
 * bug shows up at first; 390 is a current iPhone; 768 is a tablet and the width
 * where multi-column layouts start; 1280 is the desktop the site is designed
 * at. A bug that appears only between two of these is possible, but a bug that
 * appears at none of them is rare enough not to be worth the runtime.
 */
const WIDTHS = [320, 390, 768, 1280] as const;

/** Every page a visitor can reach, plus the states that render differently. */
const PATHS = [
  '/',
  '/search',
  '/search?q=' + encodeURIComponent('קורולה'),
  '/search?q=zzzzznope',
  '/channels',
  '/category/review',
  '/library',
  '/about',
  '/contact',
  '/add-video',
  '/privacy',
  '/terms',
  '/no-such-page',
] as const;

/**
 * A pixel of slack.
 *
 * Sub-pixel layout rounds, and a 0.5px seam on a border is not a bug anyone can
 * see or scroll to. Two pixels is where it starts being real.
 */
const TOLERANCE = 1;

interface Overflow {
  readonly path: string;
  readonly width: number;
  readonly overflow: number;
  readonly culprits: readonly string[];
}

/**
 * How far past the viewport the document goes, and what is doing it.
 *
 * Source text, not a callback, for the same reason as `check-contrast.ts`: this
 * is a Node script and `tsconfig.node.json` has no DOM lib, so a typed closure
 * referring to `document` does not compile. A string is handed to the page
 * verbatim.
 */
const MEASURE = `(() => {
  const root = document.documentElement;
  const overflow = root.scrollWidth - root.clientWidth;
  if (overflow <= 1) return { overflow, culprits: [] };

  // Naming the element is most of the fix — but naming the *right* one is the
  // whole fix. A first version ranked by "how far past the edge", which put
  // \`aside.site-rail\` at the top: the rail is parked off-canvas on purpose, so
  // once anything else has widened the document the rail is trivially the
  // furthest thing out. Twenty minutes went into that red herring before the
  // footer turned out to be the cause.
  //
  // So positioned elements are separated out. A \`fixed\` or \`absolute\` box is
  // anchored to the viewport or to an ancestor and is almost never what grew
  // the page; an in-flow box that will not fit almost always is. The positioned
  // ones are still reported, but only when nothing in flow overflows — which is
  // the case where they really are the cause.
  const box = root.getBoundingClientRect();
  const inFlow = [];
  const positioned = [];

  for (const element of document.querySelectorAll('*')) {
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    const past = Math.max(rect.right - box.right, box.left - rect.left);
    if (past <= 1) continue;

    // An unnamed <a> in a report is not actionable, and the footer's links are
    // exactly that — so an element with no class of its own borrows the nearest
    // ancestor that has one. "site-footer__grid > nav > a" is a location; "a"
    // is a shrug.
    const describe = (node) => {
      const cls = typeof node.className === 'string' ? node.className.trim() : '';
      return node.tagName.toLowerCase() + (cls.length > 0 ? '.' + cls.split(/\\s+/)[0] : '');
    };

    let name = describe(element);
    if (!name.includes('.')) {
      for (let parent = element.parentElement; parent != null; parent = parent.parentElement) {
        const described = describe(parent);
        name = described + ' > ' + name;
        if (described.includes('.') || parent === document.body) break;
      }
    }

    // Anything inside a scroll container is *meant* to be wider than the
    // screen — the home page's carousels are exactly that, and without this
    // they drown the report at +3000px each while the 27px that actually
    // moves the document scrolls past unnoticed. Their overflow is contained;
    // it never reaches the document.
    let contained = false;
    let anchored = getComputedStyle(element).position;
    for (let parent = element.parentElement; parent != null; parent = parent.parentElement) {
      if (parent === document.documentElement) break;
      const style = getComputedStyle(parent);
      if (style.overflowX !== 'visible') {
        contained = true;
        break;
      }
      // A child of a fixed box is anchored to the viewport just as much as the
      // box is — the back-to-top button's icon is not what widened the page.
      if (style.position === 'fixed' || style.position === 'absolute') anchored = style.position;
    }
    if (contained) continue;

    const entry = { name: name + ' (+' + String(Math.round(past)) + 'px)', past };
    if (anchored === 'fixed' || anchored === 'absolute') positioned.push(entry);
    else inFlow.push(entry);
  }

  const chosen = inFlow.length > 0 ? inFlow : positioned;
  const culprits = chosen.sort((a, b) => b.past - a.past).slice(0, 4).map((e) => e.name);
  return { overflow, culprits };
})()`;

/**
 * Wait for the server to answer, rather than sleeping a guessed number of
 * seconds. Loading the real catalog takes a few seconds and varies with the
 * machine; a fixed sleep is either wasted time or a flaky failure.
 */
async function waitForServer(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${ORIGIN}/api/stats`);
      if (response.ok) return;
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`the dev server did not start within ${String(timeoutMs / 1000)}s`);
}

async function main(): Promise<void> {
  // Spawned, not imported.
  //
  // `tests/helpers/dev-server.ts` is a script with a top-level `await main()`,
  // so importing it would start the server — but it would also pull the Worker
  // and its test helpers into `tsconfig.node.json`, which has neither the
  // Cloudflare types nor the DOM. A child process keeps the two projects
  // separate, which is the point of having five of them.
  //
  // `--quiet` silences the request log; without it the one line that says
  // whether the check passed is buried under a hundred that do not.
  const server = spawn('npx', ['tsx', 'tests/helpers/dev-server.ts', '--quiet'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    stdio: 'ignore',
  });
  const stop = (): void => {
    server.kill();
  };
  process.on('exit', stop);

  await waitForServer();

  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium',
  });

  const failures: Overflow[] = [];
  let checked = 0;

  for (const width of WIDTHS) {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
      isMobile: width < 600,
      hasTouch: width < 600,
    });
    const page = await context.newPage();

    for (const path of PATHS) {
      await page.goto(ORIGIN + path, { waitUntil: 'networkidle' }).catch(() => undefined);
      // The grids render after their fetch resolves; without this the check
      // measures an empty page and passes for the wrong reason.
      await page.waitForTimeout(350);

      const { overflow, culprits } = await page.evaluate<{
        overflow: number;
        culprits: string[];
      }>(MEASURE);
      checked += 1;
      if (overflow > TOLERANCE) failures.push({ path, width, overflow, culprits });
    }

    await context.close();
  }

  await browser.close();
  stop();

  if (failures.length === 0) {
    console.log(`✓ no horizontal overflow — ${String(checked)} page/width combinations`);
    process.exit(0);
  }

  console.error(`✗ ${String(failures.length)} page/width combinations scroll sideways\n`);
  for (const failure of failures) {
    console.error(
      `  ${String(failure.width)}px  ${failure.path} — ${String(failure.overflow)}px too wide`,
    );
    for (const culprit of failure.culprits) console.error(`      ${culprit}`);
  }
  process.exit(1);
}

await main();
