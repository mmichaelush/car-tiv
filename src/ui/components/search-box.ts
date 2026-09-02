/**
 * The search box and its suggestion list.
 *
 * Everything the old `handleSearchInput` / `displaySearchSuggestions` /
 * `handleSearchKeyDown` trio did, in one component with an explicit contract:
 *
 *  * requests are debounced, and a superseded request is aborted rather than
 *    left to land out of order over a newer one;
 *  * ↑/↓ move through the list, Enter opens the highlighted row, Escape closes
 *    it and returns focus to the input — the ARIA combobox pattern;
 *  * suggestions come from the server, so they cover tags, channels and
 *    manufacturers, not only titles already downloaded to the browser.
 */

import { SEARCH } from '@shared/constants.js';
import { searchPath } from '@shared/core/paths.js';
import type { SearchSuggestion } from '@shared/types/catalog.js';
import { debounce, html, on, setHtml, toggleClass, type SafeHtml } from '../dom.js';
import { icon, type IconName } from '../icons.js';

export interface SearchBoxOptions {
  /** The form element wrapping the input. */
  readonly form: HTMLFormElement;
  /** Fetches suggestions. Injected so the component has no repository import. */
  readonly suggest: (query: string, signal: AbortSignal) => Promise<readonly SearchSuggestion[]>;
  /**
   * Called when the visitor submits. Defaults to navigating to `/search?q=`.
   * A page that searches in place (the catalog page) passes its own handler.
   */
  readonly onSubmit?: (query: string) => void;
  /** Initial value. */
  readonly value?: string;
}

/** Icon shown next to each kind of suggestion. */
const TYPE_ICONS: Readonly<Record<SearchSuggestion['type'], IconName>> = {
  video: 'play',
  tag: 'tag',
  channel: 'channel',
  category: 'grid',
  manufacturer: 'car',
  model: 'car',
};

export interface SearchBoxHandle {
  /** Set the input's value without triggering a search. */
  setValue(value: string): void;
  /** Move focus to the input. */
  focus(): void;
  destroy(): void;
}

export function mountSearchBox(options: SearchBoxOptions): SearchBoxHandle {
  const { form } = options;
  const input = form.querySelector<HTMLInputElement>('input[type="search"]');
  const list = form.querySelector<HTMLElement>('[data-suggestions]');
  const clearButton = form.querySelector<HTMLButtonElement>('[data-search-clear]');

  if (input == null || list == null) {
    throw new Error('mountSearchBox: the form needs a search input and a [data-suggestions] list');
  }

  if (options.value != null) input.value = options.value;

  let suggestions: readonly SearchSuggestion[] = [];
  let activeIndex = -1;
  let controller: AbortController | null = null;

  const cleanups: (() => void)[] = [];

  const closeList = (): void => {
    list.hidden = true;
    activeIndex = -1;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  };

  const render = (): void => {
    if (suggestions.length === 0) {
      closeList();
      return;
    }

    setHtml(
      list,
      html`
        <ul role="listbox" id="search-suggestions">
          ${suggestions.map(
            (suggestion, index) => html`
              <li
                role="option"
                id="suggestion-${index}"
                aria-selected="${index === activeIndex ? 'true' : 'false'}"
              >
                <a href="${suggestion.href}" tabindex="-1">
                  <span class="suggestions__icon"
                    >${icon(TYPE_ICONS[suggestion.type], { size: 16 })}</span
                  >
                  <span class="suggestions__label"
                    >${highlight(suggestion.label, input.value.trim())}</span
                  >
                  ${
                    suggestion.hint == null
                      ? ''
                      : html`<span class="suggestions__hint">${suggestion.hint}</span>`
                  }
                </a>
              </li>
            `,
          )}
        </ul>
      `,
    );

    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    if (activeIndex >= 0) input.setAttribute('aria-activedescendant', `suggestion-${activeIndex}`);
    else input.removeAttribute('aria-activedescendant');
  };

  const move = (delta: number): void => {
    if (suggestions.length === 0) return;
    const count = suggestions.length;
    activeIndex = (activeIndex + delta + count + 1) % (count + 1);
    // The extra slot is "nothing highlighted", so ↓ from the last row returns
    // the visitor to what they typed rather than wrapping silently.
    if (activeIndex === count) activeIndex = -1;
    render();
  };

  const fetchSuggestions = debounce((query: string) => {
    controller?.abort();
    controller = new AbortController();

    void options
      .suggest(query, controller.signal)
      .then((rows) => {
        suggestions = rows;
        activeIndex = -1;
        render();
      })
      .catch(() => {
        // A failed or superseded suggestion request is not worth interrupting
        // the visitor for; the list simply stays as it was.
      });
  }, SEARCH.suggestDebounceMs);

  cleanups.push(
    on(input, 'input', () => {
      const query = input.value.trim();
      toggleClass(form, 'has-value', query.length > 0);
      if (clearButton != null) clearButton.hidden = query.length === 0;

      if (query.length < SEARCH.minQueryLength) {
        suggestions = [];
        closeList();
        return;
      }
      fetchSuggestions(query);
    }),
  );

  cleanups.push(
    on(input, 'keydown', (event) => {
      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          move(1);
          break;
        case 'ArrowUp':
          event.preventDefault();
          move(-1);
          break;
        case 'Escape':
          closeList();
          break;
        case 'Enter': {
          const active = suggestions[activeIndex];
          if (activeIndex >= 0 && active != null) {
            event.preventDefault();
            window.location.href = active.href;
          }
          break;
        }
        default:
          break;
      }
    }),
  );

  cleanups.push(
    on(form, 'submit', (event) => {
      event.preventDefault();
      closeList();
      const query = input.value.trim();
      if (options.onSubmit != null) options.onSubmit(query);
      else if (query.length > 0) window.location.href = searchPath(query);
    }),
  );

  if (clearButton != null) {
    clearButton.hidden = input.value.length === 0;
    cleanups.push(
      on(clearButton, 'click', () => {
        input.value = '';
        clearButton.hidden = true;
        suggestions = [];
        closeList();
        input.focus();
        options.onSubmit?.('');
      }),
    );
  }

  // Clicking anywhere else closes the list.
  cleanups.push(
    on(document, 'click', (event) => {
      if (event.target instanceof Node && !form.contains(event.target)) closeList();
    }),
  );

  // The `/` shortcut is deliberately NOT registered here. A page can mount
  // several search boxes (header + hero, or header + in-page), and one
  // document-level handler per instance means the last one mounted silently
  // wins the keypress. The shell owns the shortcut and picks the most
  // prominent field — see `mountShortcuts` in src/ui/layout/shell.ts.

  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-controls', 'search-suggestions');
  input.setAttribute('aria-autocomplete', 'list');

  return {
    setValue: (value) => {
      input.value = value;
    },
    focus: () => {
      input.focus();
    },
    destroy: () => {
      fetchSuggestions.cancel();
      controller?.abort();
      for (const cleanup of cleanups) cleanup();
    },
  };
}

/**
 * Bold the part of a suggestion the visitor actually typed.
 *
 * The legacy site did this with Fuse.js match indices; the suggestions now
 * come from the server, so the match is found here instead — a plain
 * case-insensitive substring search on the label. When it does not match
 * (the row was returned by a synonym, or by a normalised form that differs
 * from the display text) the label is simply shown unhighlighted, which is
 * the right failure: a wrong highlight is worse than none.
 */
function highlight(label: string, query: string): SafeHtml {
  const needle = query.trim();
  if (needle.length === 0) return html`${label}`;

  const haystack = label.toLowerCase();
  // Lowercasing must not change the length, or the slice offsets below would
  // land in the wrong place.
  if (haystack.length !== label.length) return html`${label}`;

  const start = haystack.indexOf(needle.toLowerCase());
  if (start < 0) return html`${label}`;

  const end = start + needle.length;
  return html`${label.slice(0, start)}<mark>${label.slice(start, end)}</mark>${label.slice(end)}`;
}
