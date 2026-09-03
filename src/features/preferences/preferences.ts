/**
 * Visitor preferences: theme, accent, density, view mode, sorting defaults.
 *
 * These are read synchronously — the theme has to be applied before the first
 * paint or the page flashes the wrong colours — so they live in `localStorage`
 * rather than IndexedDB. They are also the settings a signed-in account will
 * sync, which is why the shape matches `user_settings` column for column.
 */

import type {
  AccentName,
  ColorMode,
  Density,
  TextSize,
  ThemeName,
  UserPreferences,
  ViewMode,
} from '@shared/types/user.js';
import { DEFAULT_SORT } from '@shared/constants.js';
import { PAGINATION } from '@shared/constants.js';
import { LocalStore } from '../../data/local-store.js';

export const DEFAULT_PREFERENCES: UserPreferences = {
  theme: 'purple',
  colorMode: 'auto',
  accent: 'theme',
  density: 'comfortable',
  textSize: 'medium',
  viewMode: 'grid',
  defaultSort: DEFAULT_SORT,
  resultsPerPage: PAGINATION.defaultLimit,
  hebrewOnly: false,
  autoplay: false,
  infiniteScroll: false,
  saveHistory: true,
  reduceMotion: false,
  highContrast: false,
  underlineLinks: false,
  reduceTransparency: false,
  navCollapsed: false,
};

/**
 * Light, dark, or the device's own setting.
 *
 * A separate control from the theme, because "which colours" and "how bright"
 * are separate questions. `auto` is the default and follows
 * `prefers-color-scheme` through the `light-dark()` pairs in `themes.css`.
 */
export const COLOR_MODE_OPTIONS: readonly {
  value: ColorMode;
  label: string;
  icon: 'sun' | 'moon' | 'contrast';
}[] = [
  { value: 'light', label: 'בהיר', icon: 'sun' },
  { value: 'dark', label: 'כהה', icon: 'moon' },
  { value: 'auto', label: 'לפי המכשיר', icon: 'contrast' },
];

/**
 * The themes offered in settings.
 *
 * `swatch` is the pair the picker paints — the theme's surface and its accent —
 * so the choice is made by looking rather than by reading a name and guessing.
 * They are literals rather than read from the stylesheet because a preview has
 * to render before the theme is applied, which rules out asking the document
 * for its own tokens. The values are the dark half of each pair in
 * `themes.css`; the picker shows the same swatch in either mode, since what it
 * identifies is the family, not the brightness.
 *
 * `group` is only for how the picker arranges them.
 */
export const THEME_OPTIONS: readonly {
  value: ThemeName;
  label: string;
  group: 'core' | 'brand';
  swatch: readonly [string, string];
}[] = [
  // The names describe the palette, not a mood. "חצות" said nothing about a
  // navy-and-gold theme and "נייר" said nothing about a warm sepia, so each one
  // now names its two actual colours where that is what distinguishes it.
  { value: 'purple', label: 'סגול', group: 'core', swatch: ['#1a1128', '#a855f7'] },
  { value: 'midnight', label: 'כחול וזהב', group: 'core', swatch: ['#131722', '#f5bd38'] },
  { value: 'ocean', label: 'טורקיז', group: 'core', swatch: ['#0f1f24', '#22d3c5'] },
  { value: 'forest', label: 'ירוק יער', group: 'core', swatch: ['#101c16', '#4ade80'] },
  { value: 'sunset', label: 'כתום חם', group: 'core', swatch: ['#241610', '#fb923c'] },
  { value: 'rose', label: 'ורוד', group: 'core', swatch: ['#22131a', '#fb7185'] },
  { value: 'amber', label: 'חום וזהב', group: 'core', swatch: ['#241a10', '#f0b24a'] },
  { value: 'sepia', label: 'חול ונייר', group: 'core', swatch: ['#241c12', '#d4a373'] },
  { value: 'nord', label: 'תכלת קרירה', group: 'core', swatch: ['#161a20', '#88c0d0'] },
  { value: 'classic', label: 'כחול קלאסי', group: 'core', swatch: ['#161a1f', '#60a5fa'] },
  { value: 'mono', label: 'אפור בלבד', group: 'core', swatch: ['#1f1f1f', '#d4d4d4'] },
  { value: 'contrast', label: 'ניגודיות גבוהה', group: 'core', swatch: ['#000000', '#ffd400'] },

  { value: 'youtube', label: 'יוטיוב', group: 'brand', swatch: ['#1f1e1e', '#ff3b30'] },
  { value: 'tiktok', label: 'טיקטוק', group: 'brand', swatch: ['#161d1e', '#25f4ee'] },
  { value: 'instagram', label: 'אינסטגרם', group: 'brand', swatch: ['#221a1e', '#e1306c'] },
  { value: 'vimeo', label: 'וימיאו', group: 'brand', swatch: ['#141d21', '#1ab7ea'] },
  { value: 'whatsapp', label: 'וואטסאפ', group: 'brand', swatch: ['#131f1b', '#25d366'] },
  { value: 'telegram', label: 'טלגרם', group: 'brand', swatch: ['#141c21', '#2aabee'] },
  { value: 'spotify', label: 'ספוטיפיי', group: 'brand', swatch: ['#151b17', '#1ed760'] },
  { value: 'x', label: 'שחור־לבן', group: 'brand', swatch: ['#1f1f1f', '#ffffff'] },
];

export const TEXT_SIZE_OPTIONS: readonly { value: TextSize; label: string }[] = [
  { value: 'small', label: 'קטן' },
  { value: 'medium', label: 'רגיל' },
  { value: 'large', label: 'גדול' },
  { value: 'xlarge', label: 'גדול מאוד' },
];

export const ACCENT_OPTIONS: readonly { value: AccentName; label: string; color: string }[] = [
  // Overrides nothing, and is the default — otherwise picking the YouTube
  // theme and leaving the accent at purple would give you a purple YouTube.
  { value: 'theme', label: 'לפי הערכה', color: 'var(--brand)' },
  { value: 'purple', label: 'סגול', color: '#a855f7' },
  { value: 'blue', label: 'כחול', color: '#60a5fa' },
  { value: 'green', label: 'ירוק', color: '#4ade80' },
  { value: 'teal', label: 'טורקיז', color: '#22d3c5' },
  { value: 'orange', label: 'כתום', color: '#fb923c' },
  { value: 'gold', label: 'זהב', color: '#f5bd38' },
  { value: 'rose', label: 'ורוד', color: '#fb7185' },
];

export const DENSITY_OPTIONS: readonly { value: Density; label: string }[] = [
  { value: 'compact', label: 'קומפקטי' },
  { value: 'comfortable', label: 'נוח' },
  { value: 'large', label: 'גדול' },
];

export const VIEW_OPTIONS: readonly { value: ViewMode; label: string; icon: 'grid' | 'list' }[] = [
  { value: 'grid', label: 'רשת', icon: 'grid' },
  { value: 'list', label: 'רשימה', icon: 'list' },
];

const store = new LocalStore<Partial<UserPreferences>>('preferences', {});

/** Listeners notified whenever any preference changes. */
type Listener = (preferences: UserPreferences) => void;
const listeners = new Set<Listener>();

/**
 * Themes that used to encode a brightness as well as a colour.
 *
 * Light and dark were once themes rather than a mode. A visitor who chose one
 * before the split still has it stored, and without this they would silently
 * land back on the default — so the stored value is translated into the pair
 * it meant. Mirrored in `public/theme-bootstrap.js`, which has to do the same
 * before the first paint.
 */
const LEGACY_THEMES: Readonly<Record<string, { theme: ThemeName; colorMode: ColorMode }>> = {
  system: { theme: 'purple', colorMode: 'auto' },
  light: { theme: 'purple', colorMode: 'light' },
  dark: { theme: 'purple', colorMode: 'dark' },
};

/** The current preferences, defaults filled in and legacy values translated. */
export function readPreferences(): UserPreferences {
  const stored = store.read();
  const legacy = stored.theme == null ? undefined : LEGACY_THEMES[stored.theme];

  if (legacy == null) return { ...DEFAULT_PREFERENCES, ...stored };

  return {
    ...DEFAULT_PREFERENCES,
    ...stored,
    theme: legacy.theme,
    // An explicitly stored mode wins: someone who has used the new control has
    // answered this question more recently than they chose the old theme.
    colorMode: stored.colorMode ?? legacy.colorMode,
  };
}

/**
 * Change one or more preferences and apply them to the document.
 * @returns The full preference object after the change.
 */
export function updatePreferences(changes: Partial<UserPreferences>): UserPreferences {
  const next = { ...readPreferences(), ...changes };
  store.write(next);
  applyPreferences(next);
  for (const listener of listeners) listener(next);
  return next;
}

/** Subscribe to changes. Returns an unsubscribe function. */
export function onPreferencesChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Write the visual preferences onto `<html>`.
 *
 * The stylesheet keys off these attributes and nothing else, so this one
 * function is the whole of "applying" an appearance. `data-theme` picks the
 * colour family and `data-mode` picks the brightness — they are separate
 * because choosing a colour and choosing a brightness are separate questions.
 *
 * Kept in step with `public/theme-bootstrap.js`, which writes the same
 * attributes before the first paint. `tests/ui/preferences.test.ts` compares
 * the two lists.
 */
export function applyPreferences(preferences: UserPreferences = readPreferences()): void {
  const root = document.documentElement;
  root.dataset.theme = preferences.theme;
  root.dataset.mode = preferences.colorMode;
  root.dataset.accent = preferences.accent;
  root.dataset.density = preferences.density;
  root.dataset.textSize = preferences.textSize;
  root.dataset.contrast = preferences.highContrast ? 'high' : 'normal';
  root.dataset.underline = preferences.underlineLinks ? 'always' : 'hover';
  root.dataset.transparency = preferences.reduceTransparency ? 'reduced' : 'full';

  // The operating system's setting always wins; this only adds to it. Someone
  // who asked their OS to reduce motion never gets animation back because a
  // site's own checkbox is off.
  root.dataset.motion = preferences.reduceMotion ? 'reduced' : 'full';
}

/**
 * Whether the page is dark right now.
 *
 * Not the same question as "is the mode set to dark": under `auto` the answer
 * belongs to the device, and a "switch to light" control has to know which way
 * it is switching. Anything that offers a toggle asks this rather than reading
 * `colorMode` directly.
 */
export function isDarkNow(preferences: UserPreferences = readPreferences()): boolean {
  if (preferences.colorMode === 'dark') return true;
  if (preferences.colorMode === 'light') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/**
 * Re-apply the appearance when the device switches between light and dark.
 *
 * CSS handles the repaint on its own — `light-dark()` re-resolves. This exists
 * for the things CSS cannot reach: the `theme-color` meta that tints the
 * browser's own chrome, and any control whose label depends on which way it
 * would switch.
 *
 * @returns An unsubscribe function.
 */
export function watchDeviceColorScheme(onChange: () => void): () => void {
  const query = window.matchMedia('(prefers-color-scheme: dark)');
  const handler = (): void => {
    if (readPreferences().colorMode === 'auto') onChange();
  };
  query.addEventListener('change', handler);
  return () => {
    query.removeEventListener('change', handler);
  };
}

/** Reset everything to the defaults. */
export function resetPreferences(): UserPreferences {
  store.clear();
  const defaults = { ...DEFAULT_PREFERENCES };
  applyPreferences(defaults);
  for (const listener of listeners) listener(defaults);
  return defaults;
}
