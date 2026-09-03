/**
 * Illustrations.
 *
 * Bigger drawings than `icons.ts` — the things that fill an empty state or sit
 * beside a heading, where a 24px glyph is too small to say anything. The site
 * is a car catalog and had nothing of its own subject anywhere in it: an empty
 * search result showed a magnifying glass, which is what every site shows.
 *
 * The rules that keep them from becoming a maintenance problem:
 *
 *   * **Every colour is a theme token**, so an illustration works in all twenty
 *     themes and in both modes without a second copy. Nothing here is a hex
 *     value.
 *   * **No text**, so nothing needs translating and nothing breaks in RTL.
 *   * **`aria-hidden`**, always. An illustration beside a heading that already
 *     says "no results" is decoration; announcing it twice is worse than not
 *     announcing it.
 *   * **A `viewBox` and no fixed size**, so the caller decides how big it is.
 *
 * `preserveAspectRatio` is left at the default: these are drawings, not
 * backgrounds, and squashing one looks like a rendering bug.
 */

import { raw, type SafeHtml } from './dom.js';

export interface IllustrationOptions {
  /** Width in pixels. Height follows the aspect ratio. */
  readonly width?: number;
  readonly className?: string;
}

/**
 * A car in three-quarter view — the site's own subject, for the hero and for
 * "nothing here yet" states.
 *
 * Drawn with a filled body and stroked detail rather than as an outline: at the
 * size an empty state uses it, a pure outline reads as thin and unfinished
 * against a large empty area.
 */
const CAR_SCENE = `
  <ellipse cx="100" cy="82" rx="74" ry="7" fill="var(--brand-soft)"/>
  <path d="M28 70V56.5c0-2 .7-3.9 2-5.4l9.6-11.4A12 12 0 0 1 48.8 35h42.6c3 0 5.9 1.1 8.1 3.1l14 12.6H160a12 12 0 0 1 12 12V70a4 4 0 0 1-4 4H32a4 4 0 0 1-4-4z"
        fill="var(--surface-2)" stroke="var(--line-strong)" stroke-width="2.5" stroke-linejoin="round"/>
  <path d="M50.5 41.5h39.8c2 0 3.9.7 5.4 2l10 9H49.5a2 2 0 0 1-1.9-2.6l1.1-6.8a2 2 0 0 1 1.8-1.6z"
        fill="var(--brand-soft)" stroke="var(--brand)" stroke-width="2" stroke-linejoin="round"/>
  <path d="M36 62.5h16M150 62.5h14" stroke="var(--line-strong)" stroke-width="2.5" stroke-linecap="round"/>
  <circle cx="63" cy="74" r="13.5" fill="var(--surface-3)" stroke="var(--text)" stroke-width="2.5"/>
  <circle cx="63" cy="74" r="5" fill="var(--brand)"/>
  <circle cx="141" cy="74" r="13.5" fill="var(--surface-3)" stroke="var(--text)" stroke-width="2.5"/>
  <circle cx="141" cy="74" r="5" fill="var(--brand)"/>
  <path d="M12 60h10M6 68h16M16 52h6" stroke="var(--brand)" stroke-width="2.5" stroke-linecap="round" opacity=".65"/>`;

/**
 * A car with its bonnet up — for "nothing found" and error states.
 *
 * A broken-down car is a friendlier picture than a warning triangle for a
 * search that returned nothing: it says the site is looking, not that the
 * visitor did something wrong.
 */
const CAR_OPEN_BONNET = `
  <ellipse cx="100" cy="84" rx="70" ry="6.5" fill="var(--brand-soft)"/>
  <path d="M44 72V60c0-1.9.7-3.7 1.9-5.1l9-10.6a11 11 0 0 1 8.4-3.8h38c2.8 0 5.4 1 7.4 2.9L121 55h33a11 11 0 0 1 11 11v6a3.5 3.5 0 0 1-3.5 3.5h-114A3.5 3.5 0 0 1 44 72z"
        fill="var(--surface-2)" stroke="var(--line-strong)" stroke-width="2.5" stroke-linejoin="round"/>
  <path d="M118 55 96 26.5a3 3 0 0 1 1.8-4.8l6-1.1a3 3 0 0 1 3.1 1.4L131 55z"
        fill="var(--surface-3)" stroke="var(--line-strong)" stroke-width="2.5" stroke-linejoin="round"/>
  <path d="M64.5 47h34.2c1.8 0 3.5.6 4.9 1.8L112 55H63.6a1.8 1.8 0 0 1-1.8-2.3l1-4.3a1.8 1.8 0 0 1 1.7-1.4z"
        fill="var(--brand-soft)" stroke="var(--brand)" stroke-width="2"/>
  <circle cx="72" cy="76" r="12" fill="var(--surface-3)" stroke="var(--text)" stroke-width="2.5"/>
  <circle cx="72" cy="76" r="4.5" fill="var(--brand)"/>
  <circle cx="144" cy="76" r="12" fill="var(--surface-3)" stroke="var(--text)" stroke-width="2.5"/>
  <circle cx="144" cy="76" r="4.5" fill="var(--brand)"/>
  <path d="M138 26v6M148 30l4.5-4M132 34l-5-3.5" stroke="var(--warning)" stroke-width="2.5" stroke-linecap="round"/>`;

/** A wrench and a spanner crossed — for maintenance and admin empty states. */
const TOOLS = `
  <circle cx="100" cy="54" r="42" fill="var(--brand-soft)"/>
  <path d="M78 32a13 13 0 0 0 15.6 17.2l25 25a6 6 0 0 0 8.5-8.5l-25-25A13 13 0 0 0 85 25l7.4 7.4-3.6 9-9 3.6z"
        fill="var(--surface-2)" stroke="var(--line-strong)" stroke-width="2.5" stroke-linejoin="round"/>
  <path d="M124 34a9 9 0 0 1 0 12.7l-8 8-9.9-9.9 8-8A9 9 0 0 1 124 34z"
        fill="var(--brand-soft)" stroke="var(--brand)" stroke-width="2.5" stroke-linejoin="round"/>
  <path d="m78.5 82 6-6M70 74l4-4" stroke="var(--brand)" stroke-width="2.5" stroke-linecap="round" opacity=".7"/>`;

const DRAWINGS = {
  /** viewBox is 200×95 for the car scenes, 200×100 for the tools. */
  car: { box: '0 0 200 95', paths: CAR_SCENE },
  carBonnet: { box: '0 0 200 95', paths: CAR_OPEN_BONNET },
  tools: { box: '0 0 200 100', paths: TOOLS },
} as const;

export type IllustrationName = keyof typeof DRAWINGS;

/**
 * Render an illustration.
 *
 * Trusted markup: every path is a literal in this file and the only
 * interpolated values are a number and a class name from our own code.
 */
export function illustration(name: IllustrationName, options: IllustrationOptions = {}): SafeHtml {
  const drawing = DRAWINGS[name];
  const width = options.width ?? 200;
  const className = options.className == null ? '' : ` class="${options.className}"`;

  return raw(
    `<svg${className} viewBox="${drawing.box}" width="${String(width)}" ` +
      `fill="none" aria-hidden="true" focusable="false">${drawing.paths}</svg>`,
  );
}
