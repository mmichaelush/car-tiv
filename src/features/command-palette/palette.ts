/**
 * The command palette — Ctrl/⌘ + K.
 *
 * A catalog of eight thousand videos, ten categories and four hundred channels
 * has more places to be than a navigation bar can hold. The palette is the
 * answer to "I know what I want, let me type it": one field that searches the
 * catalog *and* runs the things the interface can do, without hunting for the
 * button that does them.
 *
 * Two sources, in one list:
 *
 *  * **Commands** — navigation and settings, matched locally, so the list is
 *    never empty and never waits for the network.
 *  * **The catalog** — the same `/api/search/suggestions` the search box uses,
 *    debounced and abortable, so typing quickly does not queue eight requests.
 *
 * It is a real `<dialog>`: focus is trapped, Escape closes it, the page behind
 * is inert, and none of that had to be written here.
 */

import { ROUTES, searchPath } from '@shared/core/paths.js';
import type { SearchSuggestion } from '@shared/types/catalog.js';
import { catalog } from '../../data/catalog-repository.js';
import { openDialog, type DialogHandle } from '../../ui/components/dialog.js';
import { debounce, html, on, select, setHtml, type SafeHtml } from '../../ui/dom.js';
import { icon, type IconName } from '../../ui/icons.js';
import { normalizeText } from '@shared/core/text.js';
import { openThemeDialog } from '../preferences/theme-dialog.js';
import { isDarkNow } from '../preferences/preferences.js';
import { openLibraryDialog } from '../library/library-dialog.js';
import { readPreferences, updatePreferences } from '../preferences/preferences.js';

interface Command {
  readonly id: string;
  readonly label: string;
  /** Extra words that should match, e.g. an English name for a Hebrew label. */
  readonly keywords?: string;
  readonly hint?: string;
  readonly iconName: IconName;
  readonly run: () => void;
}

/** How many catalog rows the palette shows. Enough to choose from, not scroll. */
const MAX_RESULTS = 7;

let open = false;

/** Register the shortcut. Called once, from the shell. */
export function mountCommandPalette(): void {
  on(document, 'keydown', (event) => {
    const isPaletteKey = event.key === 'k' || event.key === 'K';
    if (!isPaletteKey || !(event.metaKey || event.ctrlKey)) return;

    event.preventDefault();
    openCommandPalette();
  });
}

export function openCommandPalette(): void {
  if (open) return;
  open = true;

  const commands = buildCommands();
  let suggestions: readonly SearchSuggestion[] = [];
  let activeIndex = 0;
  let controller: AbortController | null = null;

  const handle: DialogHandle = openDialog({
    title: 'חיפוש מהיר',
    className: 'dialog--palette',
    body: html`
      <div class="palette">
        <div class="palette__field">
          <span class="palette__icon" aria-hidden="true">${icon('search', { size: 18 })}</span>
          <label class="sr-only" for="palette-input">חיפוש או פקודה</label>
          <input
            id="palette-input"
            class="palette__input"
            type="text"
            autocomplete="off"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-results"
            placeholder="חיפוש סרטון, קטגוריה, ערוץ — או פקודה"
          />
        </div>
        <ul class="palette__results" id="palette-results" role="listbox" data-palette-results></ul>
        <p class="palette__footer">
          <kbd>↑</kbd><kbd>↓</kbd> מעבר · <kbd>Enter</kbd> פתיחה · <kbd>Esc</kbd> סגירה
        </p>
      </div>
    `,
    onClose: () => {
      open = false;
      controller?.abort();
    },
  });

  const input = select<HTMLInputElement>('#palette-input', handle.element);
  const list = select('[data-palette-results]', handle.element);

  /** Everything currently offered, commands first. */
  const entries = (): { label: string; run: () => void }[] => [
    ...matchingCommands(commands, input.value).map((command) => ({
      label: command.label,
      run: command.run,
    })),
    ...suggestions.map((suggestion) => ({
      label: suggestion.label,
      run: () => {
        window.location.href = suggestion.href;
      },
    })),
  ];

  const render = (): void => {
    const query = input.value.trim();
    const matched = matchingCommands(commands, query);

    if (matched.length === 0 && suggestions.length === 0) {
      setHtml(
        list,
        html`<li class="palette__empty">
          ${query.length === 0 ? 'התחילו להקליד…' : 'אין תוצאות'}
        </li>`,
      );
      return;
    }

    let index = -1;
    const row = (
      label: SafeHtml | string,
      hint: string | undefined,
      iconName: IconName,
    ): SafeHtml => {
      index += 1;
      const current = index;
      return html`
        <li
          role="option"
          id="palette-option-${current}"
          aria-selected="${current === activeIndex ? 'true' : 'false'}"
          data-index="${current}"
        >
          <span class="palette__row-icon">${icon(iconName, { size: 16 })}</span>
          <span class="palette__row-label">${label}</span>
          ${hint == null ? '' : html`<span class="palette__row-hint">${hint}</span>`}
        </li>
      `;
    };

    setHtml(
      list,
      html`
        ${
          matched.length === 0
            ? ''
            : html`<li class="palette__group" role="presentation">פעולות</li>`
        }
        ${matched.map((command) => row(command.label, command.hint, command.iconName))}
        ${
          suggestions.length === 0
            ? ''
            : html`<li class="palette__group" role="presentation">מהמאגר</li>`
        }
        ${suggestions.map((suggestion) =>
          row(suggestion.label, suggestion.hint ?? undefined, iconFor(suggestion.type)),
        )}
      `,
    );

    input.setAttribute('aria-activedescendant', `palette-option-${String(activeIndex)}`);
  };

  const fetchSuggestions = debounce((query: string) => {
    controller?.abort();
    controller = new AbortController();

    void catalog
      .suggest(query, controller.signal)
      .then((rows) => {
        suggestions = rows.slice(0, MAX_RESULTS);
        render();
      })
      .catch(() => {
        // Offline, or superseded. The commands are still there and still work.
      });
  }, 180);

  on(input, 'input', () => {
    activeIndex = 0;
    const query = input.value.trim();

    if (query.length < 2) {
      suggestions = [];
      fetchSuggestions.cancel();
      render();
      return;
    }
    render();
    fetchSuggestions(query);
  });

  on(input, 'keydown', (event) => {
    const options = entries();
    if (options.length === 0) return;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      activeIndex = (activeIndex + 1) % options.length;
      render();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      activeIndex = (activeIndex - 1 + options.length) % options.length;
      render();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const chosen = options[activeIndex];
      if (chosen != null) {
        handle.close();
        chosen.run();
      } else if (input.value.trim().length > 0) {
        // Nothing highlighted: fall back to a plain search, which is what
        // Enter means everywhere else on the site.
        handle.close();
        window.location.href = searchPath(input.value);
      }
    }
  });

  on(list, 'click', (event) => {
    const item = (event.target as HTMLElement).closest<HTMLElement>('[data-index]');
    if (item == null) return;

    const chosen = entries()[Number(item.dataset.index)];
    if (chosen == null) return;

    handle.close();
    chosen.run();
  });

  render();
  input.focus();
}

/** Commands whose label or keywords contain the typed text. */
function matchingCommands(commands: readonly Command[], query: string): Command[] {
  const needle = normalizeText(query);
  if (needle.length === 0) return [...commands].slice(0, MAX_RESULTS);

  return commands
    .filter((command) =>
      normalizeText(`${command.label} ${command.keywords ?? ''}`).includes(needle),
    )
    .slice(0, MAX_RESULTS);
}

function iconFor(type: SearchSuggestion['type']): IconName {
  switch (type) {
    case 'tag':
      return 'tag';
    case 'channel':
      return 'channel';
    case 'category':
      return 'grid';
    case 'manufacturer':
    case 'model':
      return 'car';
    default:
      return 'play';
  }
}

/**
 * The commands the palette offers.
 *
 * Built fresh on each open so the toggles show the current state — "כיבוי
 * אנימציות" and "הפעלת אנימציות" are the same command with different labels,
 * and the wrong one is worse than none.
 */
function buildCommands(): Command[] {
  const go = (href: string) => () => {
    window.location.href = href;
  };
  const preferences = readPreferences();

  return [
    { id: 'home', label: 'דף הבית', keywords: 'home', iconName: 'car', run: go(ROUTES.home) },
    {
      id: 'search',
      label: 'חיפוש מתקדם',
      keywords: 'search filter סינון',
      iconName: 'search',
      run: go(ROUTES.search),
    },
    {
      id: 'channels',
      label: 'ערוצים',
      keywords: 'channels',
      iconName: 'channel',
      run: go(ROUTES.channels),
    },
    {
      id: 'library',
      label: 'הספרייה שלי',
      keywords: 'library favorites מועדפים היסטוריה',
      iconName: 'library',
      run: () => {
        void openLibraryDialog();
      },
    },
    {
      id: 'add-video',
      label: 'הצעת סרטון',
      keywords: 'add submit הוספה',
      iconName: 'upload',
      run: go(ROUTES.addVideo),
    },
    {
      id: 'settings',
      label: 'עיצוב והעדפות',
      keywords: 'theme settings ערכת נושא צבע',
      iconName: 'settings',
      run: openThemeDialog,
    },
    {
      // Flips the brightness and keeps the colour family.
      //
      // This used to swap `theme` between 'light' and 'purple', because light
      // was itself a theme — so asking for light mode discarded whatever family
      // the visitor had chosen, and asking for dark afterwards returned them to
      // purple rather than to what they had. Now it moves along the mode axis
      // and the theme is untouched.
      //
      // From `auto` it commits to the opposite of what the device is currently
      // showing, which is what someone means by "switch" while auto is on.
      id: 'theme-toggle',
      label: isDarkNow() ? 'מעבר למצב בהיר' : 'מעבר למצב כהה',
      keywords: 'dark light mode כהה בהיר יום לילה',
      iconName: isDarkNow() ? 'sun' : 'moon',
      run: () => {
        updatePreferences({ colorMode: isDarkNow() ? 'light' : 'dark' });
      },
    },
    {
      id: 'hebrew-only',
      label: preferences.hebrewOnly ? 'להציג גם תוכן באנגלית' : 'להציג עברית בלבד',
      keywords: 'hebrew english עברית אנגלית',
      iconName: 'text',
      run: () => {
        updatePreferences({ hebrewOnly: !preferences.hebrewOnly });
        window.location.reload();
      },
    },
    {
      id: 'shortcuts',
      label: 'קיצורי מקלדת',
      keywords: 'keyboard shortcuts help עזרה',
      hint: '?',
      iconName: 'keyboard',
      run: () => {
        void import('./shortcuts.js').then(({ openShortcutsDialog }) => {
          openShortcutsDialog();
        });
      },
    },
    {
      id: 'about',
      label: 'אודות',
      keywords: 'about',
      iconName: 'message',
      run: go(ROUTES.about),
    },
    {
      id: 'contact',
      label: 'צור קשר',
      keywords: 'contact',
      iconName: 'inbox',
      run: go(ROUTES.contact),
    },
  ];
}
