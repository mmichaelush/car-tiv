/**
 * The personal library dialog: favourites, "watch later" and history.
 *
 * Reads only from the local library, so it opens instantly and works offline —
 * the entries carry a snapshot of each video for exactly this reason.
 */

import type { LibraryEntry, LibraryListName } from '@shared/types/user.js';
import { ROUTES } from '@shared/core/paths.js';
import { delegate, html, select, setHtml, type SafeHtml } from '../../ui/dom.js';
import { openDialog, type DialogHandle } from '../../ui/components/dialog.js';
import { confirmDialog } from '../../ui/components/dialog.js';
import { emptyState, videoRow } from '../../ui/components/video-card.js';
import { toastSuccess } from '../../ui/components/toast.js';
import { library } from '../../data/library-repository.js';

const TABS: readonly { key: LibraryListName; label: string }[] = [
  { key: 'favorites', label: 'מועדפים' },
  { key: 'watchLater', label: 'לצפייה מאוחר יותר' },
  { key: 'history', label: 'היסטוריה' },
];

const EMPTY_COPY: Readonly<Record<LibraryListName, { title: string; description: string }>> = {
  favorites: {
    title: 'עוד לא סימנתם מועדפים',
    description: 'לחצו על הלב בכרטיס של סרטון כדי לשמור אותו כאן.',
  },
  watchLater: {
    title: 'הרשימה ריקה',
    description: 'לחצו על השעון בכרטיס של סרטון כדי לצפות בו מאוחר יותר.',
  },
  history: {
    title: 'אין היסטוריית צפייה',
    description: 'סרטונים שתתחילו לצפות בהם יופיעו כאן, עם המקום שבו עצרתם.',
  },
};

/** Open the dialog, starting on `initialTab`. */
export async function openLibraryDialog(initialTab: LibraryListName = 'favorites'): Promise<void> {
  const counts = await library.counts();
  let activeTab = initialTab;

  const handle = openDialog({
    title: 'הספרייה שלי',
    wide: true,
    body: html`<div data-library-content></div>`,
  });

  const header = select('.dialog__header', handle.element);
  header.insertAdjacentHTML(
    'afterend',
    html`
      <div class="tabs" role="tablist" data-library-tabs>
        ${TABS.map(
          (tab) => html`
            <button
              type="button"
              role="tab"
              data-tab="${tab.key}"
              aria-selected="${tab.key === activeTab ? 'true' : 'false'}"
            >
              ${tab.label}
              ${counts[tab.key] > 0 ? html`<span class="badge">${counts[tab.key]}</span>` : ''}
            </button>
          `,
        )}
      </div>
    `.value,
  );

  const content = select('[data-library-content]', handle.element);

  const paint = async (): Promise<void> => {
    const entries = await library.list(activeTab);
    setHtml(content, renderList(activeTab, entries));
  };

  delegate(
    select('[data-library-tabs]', handle.element),
    'click',
    '[data-tab]',
    (_event, button) => {
      const tab = button.dataset.tab as LibraryListName | undefined;
      if (tab == null || tab === activeTab) return;
      activeTab = tab;
      for (const other of handle.element.querySelectorAll('[data-tab]')) {
        other.setAttribute('aria-selected', String(other === button));
      }
      void paint();
    },
  );

  bindListActions(handle, content, () => activeTab, paint);

  await paint();
}

function renderList(list: LibraryListName, entries: readonly LibraryEntry[]): SafeHtml {
  if (entries.length === 0) {
    const copy = EMPTY_COPY[list];
    return emptyState({
      title: copy.title,
      description: copy.description,
      iconName: list === 'favorites' ? 'heart' : list === 'watchLater' ? 'clock' : 'eye',
      actionLabel: 'לעיון במאגר',
      actionName: 'browse',
    });
  }

  return html`
    <div class="result-bar">
      <span>${entries.length} פריטים</span>
      <button type="button" class="btn btn--ghost" data-action="clear-list">ניקוי הרשימה</button>
    </div>
    <div class="stack">
      ${entries.map((entry) =>
        entry.snapshot == null
          ? html`<p class="muted">סרטון שאינו זמין עוד (${entry.videoId})</p>`
          : html`
              <div class="video-row-wrap">
                ${videoRow(entry.snapshot, progressOf(entry))}
                <button
                  type="button"
                  class="btn btn--ghost btn--sm"
                  data-action="remove"
                  data-video-id="${entry.videoId}"
                >
                  הסרה
                </button>
              </div>
            `,
      )}
    </div>
  `;
}

/** History entries carry a position; the other lists do not. */
function progressOf(entry: LibraryEntry): number {
  const progressSeconds = (entry as { progressSeconds?: number }).progressSeconds ?? 0;
  const total = entry.snapshot?.durationSeconds ?? 0;
  return total > 0 ? Math.min(1, progressSeconds / total) : 0;
}

function bindListActions(
  handle: DialogHandle,
  content: HTMLElement,
  currentTab: () => LibraryListName,
  repaint: () => Promise<void>,
): void {
  delegate(content, 'click', '[data-action]', (_event, button) => {
    const action = button.dataset.action;

    if (action === 'browse') {
      window.location.href = ROUTES.home;
      return;
    }

    if (action === 'remove') {
      const videoId = button.dataset.videoId;
      if (videoId == null) return;
      void library.remove(currentTab(), videoId).then(repaint);
      return;
    }

    if (action === 'clear-list') {
      void confirmDialog({
        title: 'ניקוי הרשימה',
        message: 'הפריטים יימחקו מהמכשיר הזה. אי אפשר לבטל את הפעולה.',
        confirmLabel: 'ניקוי',
        destructive: true,
      }).then(async (confirmed) => {
        if (!confirmed) return;
        await library.clear(currentTab());
        await repaint();
        toastSuccess('הרשימה נוקתה');
      });
    }
  });

  // Keep the dialog honest if something else changes the library while it is
  // open — a card action on the page behind it, for instance.
  const unsubscribe = library.subscribe(() => {
    void repaint();
  });
  handle.element.addEventListener('close', unsubscribe, { once: true });
}
