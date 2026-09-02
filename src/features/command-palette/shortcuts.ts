/**
 * The keyboard-shortcut help sheet, opened with `?`.
 *
 * Shortcuts that nobody can discover are shortcuts nobody uses. This is the
 * one place that lists them, and it is itself reachable from the palette — so
 * a visitor who finds either one finds both.
 */

import { html, on, select } from '../../ui/dom.js';
import { openDialog } from '../../ui/components/dialog.js';

interface Shortcut {
  readonly keys: readonly string[];
  readonly description: string;
}

const SHORTCUTS: readonly { group: string; items: readonly Shortcut[] }[] = [
  {
    group: 'ניווט',
    items: [
      { keys: ['Ctrl', 'K'], description: 'חיפוש מהיר ופקודות' },
      { keys: ['/'], description: 'מעבר לשדה החיפוש' },
      { keys: ['?'], description: 'המסך הזה' },
      { keys: ['Esc'], description: 'סגירת חלון או רשימת הצעות' },
    ],
  },
  {
    group: 'ברשימת ההצעות',
    items: [
      { keys: ['↑', '↓'], description: 'מעבר בין תוצאות' },
      { keys: ['Enter'], description: 'פתיחת התוצאה המסומנת' },
    ],
  },
];

let open = false;

/** Register the `?` shortcut. Called once, from the shell. */
export function mountShortcutsHelp(): void {
  on(document, 'keydown', (event) => {
    if (event.key !== '?' || event.ctrlKey || event.metaKey || event.altKey) return;

    // Not while the visitor is typing — `?` is a character before it is a
    // shortcut.
    const target = event.target;
    if (target instanceof HTMLElement) {
      const tag = target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable) return;
    }

    event.preventDefault();
    openShortcutsDialog();
  });
}

export function openShortcutsDialog(): void {
  if (open) return;
  open = true;

  const handle = openDialog({
    title: 'קיצורי מקלדת',
    body: html`
      <div class="shortcut-groups">
        ${SHORTCUTS.map(
          (group) => html`
            <section>
              <h3>${group.group}</h3>
              <dl class="shortcut-list">
                ${group.items.map(
                  (shortcut) => html`
                    <div>
                      <dt>${shortcut.keys.map((key) => html`<kbd>${key}</kbd>`)}</dt>
                      <dd>${shortcut.description}</dd>
                    </div>
                  `,
                )}
              </dl>
            </section>
          `,
        )}
      </div>
    `,
    footer: html`<button type="button" class="btn btn--primary" data-close-help>סגירה</button>`,
    onClose: () => {
      open = false;
    },
  });

  on(select('[data-close-help]', handle.element), 'click', () => {
    handle.close();
  });
}
