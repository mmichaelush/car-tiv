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
  theme: 'system',
  accent: 'purple',
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
};

/** The themes offered in settings, with their Hebrew labels. */
/**
 * The themes offered in settings.
 *
 * `swatch` is the pair of colours the picker paints, so the choice is made by
 * looking rather than by reading a name and guessing. They are literals here
 * rather than read from the stylesheet: a preview has to render before the
 * theme is applied, which rules out asking the document for its own tokens.
 */
export const THEME_OPTIONS: readonly {
  value: ThemeName;
  label: string;
  swatch: readonly [string, string];
}[] = [
  { value: 'system', label: 'לפי מערכת ההפעלה', swatch: ['#0e0916', '#f8f6fb'] },
  { value: 'purple', label: 'סגול', swatch: ['#1a1128', '#a855f7'] },
  { value: 'midnight', label: 'חצות', swatch: ['#0e1624', '#f5bd38'] },
  { value: 'ocean', label: 'אוקיינוס', swatch: ['#0b1f2a', '#22d3ee'] },
  { value: 'black', label: 'שחור מלא', swatch: ['#000000', '#c084fc'] },
  { value: 'light', label: 'בהיר', swatch: ['#ffffff', '#7e22ce'] },
  { value: 'sepia', label: 'ספיה', swatch: ['#f6efe3', '#a0522d'] },
  { value: 'contrast', label: 'ניגודיות גבוהה', swatch: ['#000000', '#ffffff'] },
];

export const TEXT_SIZE_OPTIONS: readonly { value: TextSize; label: string }[] = [
  { value: 'small', label: 'קטן' },
  { value: 'medium', label: 'רגיל' },
  { value: 'large', label: 'גדול' },
  { value: 'xlarge', label: 'גדול מאוד' },
];

export const ACCENT_OPTIONS: readonly { value: AccentName; label: string; color: string }[] = [
  { value: 'purple', label: 'סגול', color: '#a855f7' },
  { value: 'blue', label: 'כחול', color: '#3b82f6' },
  { value: 'green', label: 'ירוק', color: '#10b981' },
  { value: 'orange', label: 'כתום', color: '#f97316' },
  { value: 'gold', label: 'זהב', color: '#f5bd38' },
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

/** The current preferences, defaults filled in. */
export function readPreferences(): UserPreferences {
  return { ...DEFAULT_PREFERENCES, ...store.read() };
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
 * The stylesheet keys off `data-theme`, `data-accent` and `data-density`, so
 * this single function is the whole of "applying" a theme.
 */
export function applyPreferences(preferences: UserPreferences = readPreferences()): void {
  const root = document.documentElement;
  root.dataset.theme = preferences.theme;
  root.dataset.accent = preferences.accent;
  root.dataset.density = preferences.density;
  root.dataset.textSize = preferences.textSize;

  // The operating system's setting always wins; this only adds to it. Someone
  // who asked their OS to reduce motion never gets animation back because a
  // site's own checkbox is off.
  root.dataset.motion = preferences.reduceMotion ? 'reduced' : 'full';
}

/** Reset everything to the defaults. */
export function resetPreferences(): UserPreferences {
  store.clear();
  const defaults = { ...DEFAULT_PREFERENCES };
  applyPreferences(defaults);
  for (const listener of listeners) listener(defaults);
  return defaults;
}
