// @vitest-environment happy-dom

/**
 * Appearance preferences.
 *
 * These end up as attributes on `<html>` that the whole stylesheet keys off,
 * so a mistake here is not a small visual bug — it is the site rendering in
 * the wrong theme, or at the wrong text size, for everyone who set one.
 *
 * The same values are written before first paint by `public/theme-bootstrap.js`,
 * which is a separate file on purpose (see its own note). The test at the end
 * checks the two agree about which attributes exist.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  ACCENT_OPTIONS,
  DEFAULT_PREFERENCES,
  DENSITY_OPTIONS,
  TEXT_SIZE_OPTIONS,
  THEME_OPTIONS,
  applyPreferences,
  onPreferencesChange,
  readPreferences,
  resetPreferences,
  updatePreferences,
} from '@src/features/preferences/preferences.js';

beforeEach(() => {
  window.localStorage.clear();
  for (const attribute of [...document.documentElement.attributes]) {
    if (attribute.name.startsWith('data-'))
      document.documentElement.removeAttribute(attribute.name);
  }
  resetPreferences();
});

describe('defaults', () => {
  it('starts on the system theme, so a first visit matches the device', () => {
    expect(readPreferences().theme).toBe('system');
  });

  it('has a default for every option the dialog offers', () => {
    expect(THEME_OPTIONS.map((option) => option.value)).toContain(DEFAULT_PREFERENCES.theme);
    expect(ACCENT_OPTIONS.map((option) => option.value)).toContain(DEFAULT_PREFERENCES.accent);
    expect(DENSITY_OPTIONS.map((option) => option.value)).toContain(DEFAULT_PREFERENCES.density);
    expect(TEXT_SIZE_OPTIONS.map((option) => option.value)).toContain(DEFAULT_PREFERENCES.textSize);
  });

  it('gives every theme a two-colour swatch, so the picker is never blank', () => {
    for (const option of THEME_OPTIONS) {
      expect(option.swatch).toHaveLength(2);
      for (const colour of option.swatch) expect(colour).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});

describe('applyPreferences', () => {
  it('writes every visual setting onto <html>', () => {
    applyPreferences({
      ...DEFAULT_PREFERENCES,
      theme: 'sepia',
      accent: 'green',
      density: 'compact',
      textSize: 'large',
      reduceMotion: true,
    });

    const root = document.documentElement;
    expect(root.dataset.theme).toBe('sepia');
    expect(root.dataset.accent).toBe('green');
    expect(root.dataset.density).toBe('compact');
    expect(root.dataset.textSize).toBe('large');
    expect(root.dataset.motion).toBe('reduced');
  });

  it('says "full" rather than removing the attribute when motion is allowed', () => {
    applyPreferences({ ...DEFAULT_PREFERENCES, reduceMotion: false });
    // An absent attribute would make the CSS selector ambiguous with "unset".
    expect(document.documentElement.dataset.motion).toBe('full');
  });
});

describe('updatePreferences', () => {
  it('persists a change and applies it in the same call', () => {
    updatePreferences({ theme: 'black' });

    expect(readPreferences().theme).toBe('black');
    expect(document.documentElement.dataset.theme).toBe('black');
  });

  it('leaves the other settings alone', () => {
    updatePreferences({ accent: 'gold' });
    updatePreferences({ textSize: 'xlarge' });

    const preferences = readPreferences();
    expect(preferences.accent).toBe('gold');
    expect(preferences.textSize).toBe('xlarge');
  });

  it('notifies listeners', () => {
    let seen = '';
    const stop = onPreferencesChange((preferences) => {
      seen = preferences.theme;
    });

    updatePreferences({ theme: 'ocean' });
    stop();

    expect(seen).toBe('ocean');
  });

  it('survives a stored record from an older version of the app', () => {
    // A visitor who set a theme before `textSize` existed must not end up with
    // `undefined` written onto <html>.
    window.localStorage.setItem(
      'cartiv:preferences',
      JSON.stringify({ v: 1, data: { theme: 'midnight' } }),
    );

    const preferences = readPreferences();
    expect(preferences.theme).toBe('midnight');
    expect(preferences.textSize).toBe(DEFAULT_PREFERENCES.textSize);
  });
});

describe('resetPreferences', () => {
  it('puts everything back and re-applies it', () => {
    updatePreferences({ theme: 'contrast', textSize: 'small' });
    resetPreferences();

    expect(readPreferences().theme).toBe(DEFAULT_PREFERENCES.theme);
    expect(document.documentElement.dataset.textSize).toBe(DEFAULT_PREFERENCES.textSize);
  });
});

describe('the pre-paint bootstrap', () => {
  const bootstrap = readFileSync('public/theme-bootstrap.js', 'utf8');

  it('sets the same attributes the module does', () => {
    // The bootstrap runs before the bundle, and duplicates these three lines on
    // purpose. If the module gains an attribute and the bootstrap does not, the
    // page flashes the wrong value on every single load.
    for (const attribute of [
      'data-theme',
      'data-accent',
      'data-density',
      'data-text-size',
      'data-motion',
    ]) {
      expect(bootstrap).toContain(attribute);
    }
  });

  it('reads the same storage key', () => {
    expect(bootstrap).toContain('cartiv:preferences');
  });
});
