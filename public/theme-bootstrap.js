/**
 * Applies the visitor's saved appearance settings before the first paint.
 *
 * Loaded as a small blocking classic script in <head>: a module script is
 * deferred by definition, which would mean one frame of the default theme
 * before the visitor's choice takes effect — the "flash of wrong colours".
 *
 * It duplicates a few lines of `src/features/preferences/preferences.ts` on
 * purpose. Importing that module here would pull the whole application bundle
 * into the critical path to set three attributes.
 */
(function applyStoredAppearance() {
  var DEFAULTS = {
    theme: 'system',
    accent: 'purple',
    density: 'comfortable',
    textSize: 'medium',
    reduceMotion: false,
  };

  var stored = DEFAULTS;
  try {
    var raw = window.localStorage.getItem('cartiv:preferences');
    if (raw) {
      var envelope = JSON.parse(raw);
      // Version 1 of the record; anything else falls back to the defaults.
      if (envelope && envelope.v === 1 && envelope.data) {
        stored = {
          theme: envelope.data.theme || DEFAULTS.theme,
          accent: envelope.data.accent || DEFAULTS.accent,
          density: envelope.data.density || DEFAULTS.density,
          textSize: envelope.data.textSize || DEFAULTS.textSize,
          reduceMotion: envelope.data.reduceMotion === true,
        };
      }
    }
  } catch (error) {
    // Private mode, blocked storage, corrupt JSON — the defaults are fine.
  }

  var root = document.documentElement;
  root.setAttribute('data-theme', stored.theme);
  root.setAttribute('data-accent', stored.accent);
  root.setAttribute('data-density', stored.density);
  root.setAttribute('data-text-size', stored.textSize);
  root.setAttribute('data-motion', stored.reduceMotion ? 'reduced' : 'full');
})();
