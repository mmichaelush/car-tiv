/**
 * Applies the visitor's saved appearance settings before the first paint.
 *
 * Loaded as a small blocking classic script in <head>: a module script is
 * deferred by definition, which would mean one frame of the default theme
 * before the visitor's choice takes effect — the "flash of wrong colours".
 *
 * It duplicates a few lines of `src/features/preferences/preferences.ts` on
 * purpose. Importing that module here would pull the whole application bundle
 * into the critical path to set eight attributes. `tests/ui/preferences.test.ts`
 * compares the two lists so they cannot drift apart silently.
 */
(function applyStoredAppearance() {
  var DEFAULTS = {
    theme: 'purple',
    colorMode: 'auto',
    accent: 'theme',
    density: 'comfortable',
    textSize: 'medium',
    reduceMotion: false,
    highContrast: false,
    underlineLinks: false,
    reduceTransparency: false,
  };

  /*
   * Themes that used to encode a brightness as well as a colour.
   *
   * Light and dark were once separate themes rather than a separate setting.
   * Anyone who chose one of these before the split has it in their browser, and
   * without this they would silently land back on the default. Translating them
   * keeps the intent: someone who picked "light" wanted light, and gets the
   * default family in light mode.
   */
  var LEGACY = {
    system: { theme: 'purple', colorMode: 'auto' },
    light: { theme: 'purple', colorMode: 'light' },
    dark: { theme: 'purple', colorMode: 'dark' },
  };

  var stored = DEFAULTS;
  try {
    var raw = window.localStorage.getItem('cartiv:preferences');
    if (raw) {
      var envelope = JSON.parse(raw);
      // Version 1 of the record; anything else falls back to the defaults.
      if (envelope && envelope.v === 1 && envelope.data) {
        var data = envelope.data;
        var theme = data.theme || DEFAULTS.theme;
        var colorMode = data.colorMode || DEFAULTS.colorMode;

        var legacy = LEGACY[theme];
        if (legacy) {
          theme = legacy.theme;
          // An explicitly stored mode still wins: someone who has already used
          // the new control has answered this question more recently.
          colorMode = data.colorMode || legacy.colorMode;
        }

        stored = {
          theme: theme,
          colorMode: colorMode,
          accent: data.accent || DEFAULTS.accent,
          density: data.density || DEFAULTS.density,
          textSize: data.textSize || DEFAULTS.textSize,
          reduceMotion: data.reduceMotion === true,
          highContrast: data.highContrast === true,
          underlineLinks: data.underlineLinks === true,
          reduceTransparency: data.reduceTransparency === true,
        };
      }
    }
  } catch (error) {
    // Private mode, blocked storage, corrupt JSON — the defaults are fine.
  }

  var root = document.documentElement;
  root.setAttribute('data-theme', stored.theme);
  root.setAttribute('data-mode', stored.colorMode);
  root.setAttribute('data-accent', stored.accent);
  root.setAttribute('data-density', stored.density);
  root.setAttribute('data-text-size', stored.textSize);
  root.setAttribute('data-motion', stored.reduceMotion ? 'reduced' : 'full');
  root.setAttribute('data-contrast', stored.highContrast ? 'high' : 'normal');
  root.setAttribute('data-underline', stored.underlineLinks ? 'always' : 'hover');
  root.setAttribute('data-transparency', stored.reduceTransparency ? 'reduced' : 'full');
})();
