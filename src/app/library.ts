/**
 * `/library/` — the personal area: saved lists, playlists, "my car" and the
 * data controls.
 *
 * Everything here lives on the visitor's device. There is no account, so there
 * is nothing to log into and nothing of theirs on our servers — and the page
 * says so, with an export button that proves it.
 */

import type { LibraryEntry, LibraryListName, Playlist, UserVehicle } from '@shared/types/user.js';
import { startPage } from './bootstrap.js';
import { library } from '../data/library-repository.js';
import { confirmDialog, openDialog } from '../ui/components/dialog.js';
import { emptyState, videoRow } from '../ui/components/video-card.js';
import { toastSuccess } from '../ui/components/toast.js';
import { delegate, html, on, select, setHtml, type SafeHtml } from '../ui/dom.js';
import { icon } from '../ui/icons.js';

startPage({ active: 'library' });

type TabKey = LibraryListName | 'playlists' | 'car' | 'data';

const TABS: readonly { key: TabKey; label: string }[] = [
  { key: 'favorites', label: 'מועדפים' },
  { key: 'watchLater', label: 'לצפייה מאוחר יותר' },
  { key: 'history', label: 'היסטוריה' },
  { key: 'playlists', label: 'פלייליסטים' },
  { key: 'car', label: 'הרכב שלי' },
  { key: 'data', label: 'הנתונים שלי' },
];

const tabsRoot = select('[data-library-tabs]');
const content = select('[data-library-content]');

let activeTab: TabKey =
  (new URL(window.location.href).searchParams.get('tab') as TabKey | null) ?? 'favorites';

renderTabs();
void paint();

library.subscribe(() => {
  void paint();
});

delegate(tabsRoot, 'click', '[data-tab]', (_event, button) => {
  const tab = button.dataset.tab as TabKey | undefined;
  if (tab == null || tab === activeTab) return;
  activeTab = tab;
  window.history.replaceState(null, '', `?tab=${tab}`);
  renderTabs();
  void paint();
});

function renderTabs(): void {
  setHtml(
    tabsRoot,
    html`${TABS.map(
      (tab) => html`
        <button
          type="button"
          role="tab"
          data-tab="${tab.key}"
          aria-selected="${tab.key === activeTab ? 'true' : 'false'}"
        >
          ${tab.label}
        </button>
      `,
    )}`,
  );
}

async function paint(): Promise<void> {
  switch (activeTab) {
    case 'playlists':
      setHtml(content, renderPlaylists(await library.playlists()));
      break;
    case 'car':
      setHtml(content, renderVehicles(await library.vehicles()));
      break;
    case 'data':
      setHtml(content, renderDataPanel());
      break;
    default:
      setHtml(content, renderList(activeTab, await library.list(activeTab)));
      break;
  }
}

function renderList(list: LibraryListName, entries: readonly LibraryEntry[]): SafeHtml {
  if (entries.length === 0) {
    return emptyState({
      title: 'הרשימה ריקה',
      description: 'סרטונים שתשמרו יופיעו כאן, וזמינים גם כשאין חיבור לאינטרנט.',
      actionLabel: 'לעיון במאגר',
      actionName: 'browse',
      iconName: list === 'favorites' ? 'heart' : list === 'watchLater' ? 'clock' : 'eye',
    });
  }

  return html`
    <div class="result-bar">
      <span>${entries.length} פריטים</span>
      <button type="button" class="btn btn--ghost" data-action="clear">ניקוי הרשימה</button>
    </div>
    <div class="stack">
      ${entries.map((entry) =>
        entry.snapshot == null
          ? ''
          : html`<div>
              ${videoRow(entry.snapshot)}
              <button
                type="button"
                class="btn btn--ghost btn--sm"
                data-action="remove"
                data-video-id="${entry.videoId}"
              >
                הסרה
              </button>
            </div>`,
      )}
    </div>
  `;
}

function renderPlaylists(playlists: readonly Playlist[]): SafeHtml {
  return html`
    <div class="result-bar">
      <span>${playlists.length} רשימות</span>
      <button type="button" class="btn btn--primary btn--sm" data-action="new-playlist">
        ${icon('playlist', { size: 16 })} רשימה חדשה
      </button>
    </div>
    ${
      playlists.length === 0
        ? emptyState({
            title: 'אין עדיין פלייליסטים',
            description: 'אפשר לקבץ סרטונים לרשימות — למשל "טיפול 60 אלף" או "לצפות עם הילדים".',
            iconName: 'playlist',
          })
        : html`<div class="stack">
            ${playlists.map(
              (playlist) => html`
                <div class="panel">
                  <div class="result-bar" style="margin:0">
                    <div>
                      <h3>${playlist.name}</h3>
                      <p class="muted">${playlist.itemCount} סרטונים</p>
                    </div>
                    <div class="result-bar__tools">
                      <button
                        type="button"
                        class="btn btn--ghost btn--sm"
                        data-action="rename-playlist"
                        data-playlist-id="${playlist.id}"
                      >
                        שינוי שם
                      </button>
                      <button
                        type="button"
                        class="btn btn--danger btn--sm"
                        data-action="delete-playlist"
                        data-playlist-id="${playlist.id}"
                      >
                        מחיקה
                      </button>
                    </div>
                  </div>
                </div>
              `,
            )}
          </div>`
    }
  `;
}

function renderVehicles(vehicles: readonly UserVehicle[]): SafeHtml {
  return html`
    <div class="result-bar">
      <span>${vehicles.length} רכבים</span>
      <button type="button" class="btn btn--primary btn--sm" data-action="new-vehicle">
        ${icon('car', { size: 16 })} הוספת רכב
      </button>
    </div>
    ${
      vehicles.length === 0
        ? emptyState({
            title: 'עוד לא הגדרתם רכב',
            description:
              'אחרי שתגדירו את הרכב שלכם, דף הבית יציג שורה של תוכן שמתאים לו במיוחד, ובחיפוש תוכלו לסנן "רק לרכב שלי".',
            iconName: 'car',
          })
        : html`<div class="stack">
            ${vehicles.map(
              (vehicle) => html`
                <div class="panel">
                  <div class="result-bar" style="margin:0">
                    <div>
                      <h3>
                        ${vehicle.nickname ?? `${vehicle.manufacturer} ${vehicle.model}`}
                        ${vehicle.isPrimary ? html`<span class="badge badge--brand">ראשי</span>` : ''}
                      </h3>
                      <p class="muted">
                        ${vehicle.manufacturer}
                        ${vehicle.model}${vehicle.year == null ? '' : ` · ${vehicle.year}`}
                      </p>
                    </div>
                    <button
                      type="button"
                      class="btn btn--danger btn--sm"
                      data-action="delete-vehicle"
                      data-vehicle-id="${vehicle.id}"
                    >
                      הסרה
                    </button>
                  </div>
                </div>
              `,
            )}
          </div>`
    }
  `;
}

function renderDataPanel(): SafeHtml {
  return html`
    <div class="panel">
      <h2>הנתונים שלכם</h2>
      <p class="muted">
        כל מה ששמרתם — מועדפים, רשימת צפייה, היסטוריה, פלייליסטים והרכבים — נשמר בדפדפן הזה בלבד.
        הוא לא נשלח לשרת ולא משויך לחשבון.
      </p>
      <div class="video-actions">
        <button type="button" class="btn btn--secondary" data-action="export">
          ${icon('upload', { size: 18 })} ייצוא לקובץ
        </button>
        <button type="button" class="btn btn--danger" data-action="clear-all">
          ${icon('trash', { size: 18 })} מחיקת כל הנתונים
        </button>
      </div>
    </div>
  `;
}

delegate(content, 'click', '[data-action]', (_event, button) => {
  const action = button.dataset.action;

  switch (action) {
    case 'browse':
      window.location.href = '/';
      break;

    case 'remove': {
      const videoId = button.dataset.videoId;
      if (videoId != null && isListTab(activeTab)) void library.remove(activeTab, videoId);
      break;
    }

    case 'clear':
      if (!isListTab(activeTab)) break;
      void confirmDialog({
        title: 'ניקוי הרשימה',
        message: 'הפריטים יימחקו מהמכשיר הזה. אי אפשר לבטל.',
        confirmLabel: 'ניקוי',
        destructive: true,
      }).then((confirmed) => {
        if (confirmed && isListTab(activeTab)) void library.clear(activeTab);
      });
      break;

    case 'new-playlist':
      promptForName('רשימה חדשה', 'שם הרשימה', (name) => {
        void library.createPlaylist(name).then(() => {
          toastSuccess('הרשימה נוצרה');
        });
      });
      break;

    case 'rename-playlist': {
      const id = button.dataset.playlistId;
      if (id == null) break;
      promptForName('שינוי שם', 'שם חדש', (name) => {
        void library.renamePlaylist(id, name);
      });
      break;
    }

    case 'delete-playlist': {
      const id = button.dataset.playlistId;
      if (id == null) break;
      void confirmDialog({
        title: 'מחיקת רשימה',
        message: 'הרשימה והפריטים שבה יימחקו.',
        confirmLabel: 'מחיקה',
        destructive: true,
      }).then((confirmed) => {
        if (confirmed) void library.deletePlaylist(id);
      });
      break;
    }

    case 'new-vehicle':
      openVehicleDialog();
      break;

    case 'delete-vehicle': {
      const id = button.dataset.vehicleId;
      if (id != null) void library.deleteVehicle(id);
      break;
    }

    case 'export':
      void exportData();
      break;

    case 'clear-all':
      void confirmDialog({
        title: 'מחיקת כל הנתונים',
        message: 'כל מה ששמרתם במכשיר הזה יימחק. אי אפשר לבטל.',
        confirmLabel: 'מחיקה',
        destructive: true,
      }).then((confirmed) => {
        if (confirmed) {
          void library.clearAll().then(() => {
            toastSuccess('הנתונים נמחקו');
          });
        }
      });
      break;

    default:
      break;
  }
});

function isListTab(tab: TabKey): tab is LibraryListName {
  return tab === 'favorites' || tab === 'watchLater' || tab === 'history';
}

/** A tiny one-field dialog, used for playlist names. */
function promptForName(title: string, label: string, onSubmit: (value: string) => void): void {
  const handle = openDialog({
    title,
    body: html`
      <div class="field">
        <label for="name-input">${label}</label>
        <input class="input" id="name-input" type="text" data-name-input />
      </div>
    `,
    footer: html`
      <button type="button" class="btn btn--secondary" data-cancel>ביטול</button>
      <button type="button" class="btn btn--primary" data-ok>שמירה</button>
    `,
  });

  const input = select<HTMLInputElement>('[data-name-input]', handle.element);
  input.focus();

  on(select('[data-cancel]', handle.element), 'click', () => {
    handle.close();
  });
  on(select('[data-ok]', handle.element), 'click', () => {
    const value = input.value.trim();
    if (value.length === 0) return;
    handle.close();
    onSubmit(value);
  });
}

function openVehicleDialog(): void {
  const handle = openDialog({
    title: 'הוספת רכב',
    body: html`
      <div class="form-grid form-grid--2">
        <div class="field">
          <label for="v-make">יצרן</label>
          <input
            class="input"
            id="v-make"
            type="text"
            data-field="manufacturer"
            placeholder="יונדאי"
          />
        </div>
        <div class="field">
          <label for="v-model">דגם</label>
          <input class="input" id="v-model" type="text" data-field="model" placeholder="i40" />
        </div>
        <div class="field">
          <label for="v-year">שנה</label>
          <input class="input" id="v-year" type="number" data-field="year" min="1950" max="2030" />
        </div>
        <div class="field">
          <label for="v-nick">כינוי (לא חובה)</label>
          <input
            class="input"
            id="v-nick"
            type="text"
            data-field="nickname"
            placeholder="הרכב שלי"
          />
        </div>
      </div>
    `,
    footer: html`
      <button type="button" class="btn btn--secondary" data-cancel>ביטול</button>
      <button type="button" class="btn btn--primary" data-ok>שמירה</button>
    `,
  });

  const value = (name: string): string =>
    select<HTMLInputElement>(`[data-field="${name}"]`, handle.element).value.trim();

  on(select('[data-cancel]', handle.element), 'click', () => {
    handle.close();
  });

  on(select('[data-ok]', handle.element), 'click', () => {
    const manufacturer = value('manufacturer');
    const model = value('model');
    if (manufacturer.length === 0) return;

    const year = Number(value('year'));
    handle.close();
    void library
      .saveVehicle({
        manufacturer,
        model,
        year: Number.isFinite(year) && year > 1900 ? year : null,
        engine: null,
        nickname: value('nickname').length > 0 ? value('nickname') : null,
        isPrimary: true,
      })
      .then(() => {
        toastSuccess('הרכב נשמר');
      });
  });
}

/** Download the whole library as JSON. */
async function exportData(): Promise<void> {
  const data = await library.exportAll();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = url;
  link.download = `car-tiv-library-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();

  URL.revokeObjectURL(url);
  toastSuccess('הקובץ הורד');
}
