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
  it('starts on the site colours, following the device for brightness', () => {
    // Theme and brightness are separate settings now. There is no `system`
    // theme any more: `auto` is a *mode*, so a first visit matches the device
    // without that also deciding which colour family the visitor gets.
    expect(readPreferences().theme).toBe('purple');
    expect(readPreferences().colorMode).toBe('auto');
  });

  it('defaults the accent to the theme, so a brand theme keeps its colour', () => {
    // Any other default would give someone who picks the YouTube theme a
    // purple YouTube.
    expect(readPreferences().accent).toBe('theme');
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
      colorMode: 'dark',
      accent: 'green',
      density: 'compact',
      textSize: 'large',
      reduceMotion: true,
      highContrast: true,
      underlineLinks: true,
      reduceTransparency: true,
    });

    const root = document.documentElement;
    expect(root.dataset.theme).toBe('sepia');
    expect(root.dataset.mode).toBe('dark');
    expect(root.dataset.accent).toBe('green');
    expect(root.dataset.density).toBe('compact');
    expect(root.dataset.textSize).toBe('large');
    expect(root.dataset.motion).toBe('reduced');
    expect(root.dataset.contrast).toBe('high');
    expect(root.dataset.underline).toBe('always');
    expect(root.dataset.transparency).toBe('reduced');
  });

  it('keeps the theme and the mode independent', () => {
    // The whole point of the split. Choosing a light page must not discard the
    // colour family, and choosing a family must not change the brightness —
    // which is exactly what the old single axis did.
    applyPreferences({ ...DEFAULT_PREFERENCES, theme: 'ocean', colorMode: 'light' });
    expect(document.documentElement.dataset.theme).toBe('ocean');
    expect(document.documentElement.dataset.mode).toBe('light');

    applyPreferences({ ...DEFAULT_PREFERENCES, theme: 'ocean', colorMode: 'dark' });
    expect(document.documentElement.dataset.theme).toBe('ocean');
    expect(document.documentElement.dataset.mode).toBe('dark');
  });

  it('says "full" rather than removing the attribute when motion is allowed', () => {
    applyPreferences({ ...DEFAULT_PREFERENCES, reduceMotion: false });
    // An absent attribute would make the CSS selector ambiguous with "unset".
    expect(document.documentElement.dataset.motion).toBe('full');
  });
});

describe('updatePreferences', () => {
  it('persists a change and applies it in the same call', () => {
    updatePreferences({ theme: 'amber' });

    expect(readPreferences().theme).toBe('amber');
    expect(document.documentElement.dataset.theme).toBe('amber');
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

  it('sets every attribute the module sets', () => {
    // The bootstrap runs before the bundle and duplicates a few lines of the
    // module on purpose — importing it would pull the application into the
    // critical path to set some attributes. The cost of that choice is drift,
    // and the symptom is a flash of the wrong appearance on every load, which
    // is easy to miss and hard to attribute.
    //
    // Derived from what `applyPreferences` actually writes, not from a list
    // repeated here: a hardcoded list is the same drift one step removed, and
    // this test previously named five attributes while the module wrote five —
    // it would not have noticed the four added since.
    applyPreferences(DEFAULT_PREFERENCES);
    const written = [...document.documentElement.attributes]
      .map((attribute) => attribute.name)
      .filter((name) => name.startsWith('data-'));

    expect(written.length).toBeGreaterThan(5);
    for (const attribute of written) {
      expect(bootstrap, `theme-bootstrap.js must set ${attribute}`).toContain(attribute);
    }
  });

  it('translates the same legacy themes', () => {
    // Both sides have to: the bootstrap runs first, and the module runs on
    // every read afterwards. If only one migrated, the page would paint one
    // appearance and then correct itself.
    for (const legacy of ['system', 'light', 'dark']) {
      expect(bootstrap, `theme-bootstrap.js must migrate ${legacy}`).toContain(`${legacy}:`);
    }
  });

  it('reads the same storage key', () => {
    expect(bootstrap).toContain('cartiv:preferences');
  });
});

describe('visitors who chose a theme before light and dark were split out', () => {
  /**
   * Light and dark used to be themes rather than a mode, so a returning
   * visitor has `theme: 'system'` or `theme: 'light'` in their browser. Those
   * are not valid themes any more. Without a translation they would silently
   * land back on the default — and someone who had deliberately chosen a light
   * page would be handed a dark one, which is the most visible way to lose a
   * setting.
   */
  const stored = (data: Record<string, unknown>): void => {
    window.localStorage.setItem('cartiv:preferences', JSON.stringify({ v: 1, data }));
  };

  it('turns the old "light" theme into light mode', () => {
    stored({ theme: 'light' });
    const preferences = readPreferences();

    expect(preferences.colorMode).toBe('light');
    expect(THEME_OPTIONS.map((option) => option.value)).toContain(preferences.theme);
  });

  it('turns the old "system" theme into auto mode', () => {
    stored({ theme: 'system' });
    expect(readPreferences().colorMode).toBe('auto');
  });

  it('keeps a mode the visitor has since chosen explicitly', () => {
    // They have answered this question more recently with the new control.
    stored({ theme: 'light', colorMode: 'dark' });
    expect(readPreferences().colorMode).toBe('dark');
  });

  it('leaves a theme that is still valid alone', () => {
    stored({ theme: 'ocean', colorMode: 'light' });
    const preferences = readPreferences();

    expect(preferences.theme).toBe('ocean');
    expect(preferences.colorMode).toBe('light');
  });

  it('never yields a theme the picker cannot show', () => {
    for (const legacy of ['system', 'light', 'dark']) {
      stored({ theme: legacy });
      expect(
        THEME_OPTIONS.map((option) => option.value),
        `after migrating ${legacy}`,
      ).toContain(readPreferences().theme);
    }
  });
});

describe('the navigation rail', () => {
  it('remembers whether it is collapsed', () => {
    // A rail that reopened expanded on every page load would be a setting the
    // visitor has to make again every time, which is worse than not offering it.
    expect(DEFAULT_PREFERENCES.navCollapsed).toBe(false);

    updatePreferences({ navCollapsed: true });
    expect(readPreferences().navCollapsed).toBe(true);
  });
});
