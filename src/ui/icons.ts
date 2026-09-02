/**
 * Icons.
 *
 * Inline SVG from one small set, not an icon font. The old site loaded ~215 KB
 * of Font Awesome for a handful of glyphs, on the critical path, from a
 * stylesheet that also blocked rendering. These are a few hundred bytes each,
 * they inherit `currentColor`, they scale with the text, and they need no
 * network request at all.
 *
 * Every icon is drawn on a 24×24 grid with a 1.75 stroke, so they look like one
 * family. `aria-hidden` is set here because an icon is always accompanied by a
 * label or an `aria-label` on its control.
 */

import { raw, type SafeHtml } from './dom.js';

/** Paths only — the wrapper is added by `icon()`. */
const PATHS = {
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  play: '<path d="M8 5.5v13l11-6.5z" fill="currentColor" stroke="none"/>',
  filter: '<path d="M3 5h18M6 12h12M10 19h4"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  chevronStart: '<path d="m15 6-6 6 6 6"/>',
  chevronEnd: '<path d="m9 6 6 6-6 6"/>',
  arrowUp: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  heart:
    '<path d="M12 20s-7-4.35-7-9.5A4.5 4.5 0 0 1 12 7a4.5 4.5 0 0 1 7 3.5C19 15.65 12 20 12 20z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  check: '<path d="m5 13 4 4 10-10"/>',
  share:
    '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 10.6 6.8-4M8.6 13.4l6.8 4"/>',
  link: '<path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/>',
  flag: '<path d="M5 21V4m0 0h10l-1.5 3L15 10H5"/>',
  message: '<path d="M20 15a3 3 0 0 1-3 3H8l-4 3V6a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3z"/>',
  playlist: '<path d="M4 6h11M4 11h11M4 16h7"/><path d="M16 13v6M13 16h6"/>',
  library: '<path d="M4 5h4v14H4zM11 5h4v14h-4z"/><path d="m18 6 3 12"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  car: '<path d="M5 17h14M4 17v-4l2-5h12l2 5v4"/><circle cx="7.5" cy="17.5" r="1.5"/><circle cx="16.5" cy="17.5" r="1.5"/>',
  grid: '<path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z"/>',
  list: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20 14A8 8 0 0 1 10 4a8 8 0 1 0 10 10z"/>',
  settings:
    '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"/>',
  external:
    '<path d="M14 5h5v5"/><path d="m19 5-8 8"/><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/>',
  alert: '<path d="M12 8v5M12 16.5v.5"/><circle cx="12" cy="12" r="9"/>',
  tag: '<path d="M3 11V4h7l10 10-7 7z"/><circle cx="7.5" cy="7.5" r="1.2"/>',
  channel: '<rect x="3" y="7" width="18" height="13" rx="3"/><path d="m8 7 3-4M16 7l-3-4"/>',
  inbox:
    '<path d="M3 13h5l2 3h4l2-3h5"/><path d="M5 6h14l2 7v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5z"/>',
  upload:
    '<path d="M12 16V5"/><path d="m8 9 4-4 4 4"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>',
  trash: '<path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/>',
  edit: '<path d="M4 20h4l10-10-4-4L4 16z"/><path d="m14 6 4 4"/>',
  eye: '<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="2.5"/>',
  expand: '<path d="M9 4H4v5M15 4h5v5M15 20h5v-5M9 20H4v-5"/>',
  bookmark: '<path d="M7 3h10a1 1 0 0 1 1 1v17l-6-4-6 4V4a1 1 0 0 1 1-1z"/>',
  command: '<path d="M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3z"/>',
  keyboard:
    '<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6 10h.01M9.5 10h.01M13 10h.01M16.5 10h.01M6 13.5h.01M9.5 13.5h5M18 13.5h.01"/>',
  sparkle:
    '<path d="M12 3.5 13.7 9l5.5 1.7-5.5 1.7L12 18l-1.7-5.6L4.8 10.7 10.3 9z"/><path d="M18.5 4v3M20 5.5h-3"/>',
  text: '<path d="M4 6h16M4 12h11M4 18h7"/>',
  contrast:
    '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none"/>',
  download: '<path d="M12 4v11"/><path d="m8 12 4 4 4-4"/><path d="M4 19h16"/>',

  /* Category glyphs. One per catalog category, plus `film` for "all". */
  film: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7.5 5v14M16.5 5v14M3 12h18"/>',
  chart:
    '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m20 20-4.3-4.3"/><path d="M8 12.5V14M10.5 8.5V14M13 11V14"/>',
  oilCan:
    '<path d="M3 16.5V12h6l3-2h4.5v2H20l1.2 4.5z"/><path d="m13 9.8 6-3.3"/><path d="M6 12V9.2h3"/>',
  wrench:
    '<path d="M17.2 3.4a4.6 4.6 0 0 0-5.5 6l-7.2 7.2a2.1 2.1 0 0 0 3 3l7.2-7.2a4.6 4.6 0 0 0 6-5.5L18 9.4 14.6 6z"/>',
  microscope:
    '<path d="M9.5 4h3.5l1 7.5H9z"/><path d="M7 17h8.5a5.5 5.5 0 0 0-5.5-5.5"/><path d="M4 20.5h16"/><path d="M11 20.5V17"/>',
  gears:
    '<circle cx="9.8" cy="9.8" r="4"/><circle cx="17" cy="16.4" r="2.8"/><path d="M9.8 3.3v1.4M9.8 14.9v1.4M3.3 9.8h1.4M14.9 9.8h1.4"/>',
  shield: '<path d="M12 3 5 6v5.4c0 4.3 3 7.7 7 9.6 4-1.9 7-5.3 7-9.6V6z"/><path d="M12 3v18"/>',
  road: '<path d="M8.5 3 5.5 21M15.5 3l3 18"/><path d="M12 4.2v3M12 10.5v3M12 16.8v3"/>',
  mountain: '<path d="M2.5 19h19L14 5.5l-3.6 6.2L8.2 8.4z"/>',
  rocket:
    '<path d="M12 3c3.4 2.1 5.4 5.6 5.4 9.6L12 18.2 6.6 12.6C6.6 8.6 8.6 5.1 12 3z"/><circle cx="12" cy="10" r="1.7"/><path d="m9.2 18.4-2 2.6M14.8 18.4l2 2.6"/>',
} as const;

/**
 * Legacy Font Awesome names, as stored in `categories.icon`, mapped onto this
 * icon set. Keeping the mapping here means the database can keep the names the
 * old site used — nothing has to be migrated, and an unknown name degrades to a
 * neutral glyph instead of an empty box.
 */
const CATEGORY_ICONS: Readonly<Record<string, IconName>> = {
  film: 'film',
  'magnifying-glass-chart': 'chart',
  'oil-can': 'oilCan',
  'screwdriver-wrench': 'wrench',
  tools: 'wrench',
  microscope: 'microscope',
  gears: 'gears',
  cogs: 'gears',
  'shield-halved': 'shield',
  road: 'road',
  mountain: 'mountain',
  rocket: 'rocket',
  'car-side': 'car',
  car: 'car',
};

/** The icon for a category, by the name stored on the category row. */
export function categoryIconName(stored: string | null | undefined): IconName {
  if (stored == null) return 'film';
  return CATEGORY_ICONS[stored] ?? 'film';
}

export type IconName = keyof typeof PATHS;

export interface IconOptions {
  /** Pixel size of the square box. Defaults to 20. */
  readonly size?: number;
  /** Extra class names. */
  readonly className?: string;
}

/**
 * Render an icon.
 *
 * The result is trusted markup: the paths are literals in this file and the
 * only interpolated values are numbers and a class name from our own code.
 */
export function icon(name: IconName, options: IconOptions = {}): SafeHtml {
  const size = options.size ?? 20;
  const className = options.className == null ? '' : ` class="${options.className}"`;

  return raw(
    `<svg${className} width="${String(size)}" height="${String(size)}" viewBox="0 0 24 24" ` +
      `fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" ` +
      `stroke-linejoin="round" aria-hidden="true" focusable="false">${PATHS[name]}</svg>`,
  );
}

/** `true` when a name is a known icon — used by data-driven markup. */
export function isIconName(value: string): value is IconName {
  return value in PATHS;
}
