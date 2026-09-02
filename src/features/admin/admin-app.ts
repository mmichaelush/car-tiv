/**
 * The management area.
 *
 * Four screens, one shell: dashboard, videos, inbox and search insights. Built
 * from the same design system as the public site, so an editor is not learning
 * a second product — and so a design change lands in both places at once.
 *
 * Access: the page shell is public (it has to be — it is a static asset), and
 * every piece of data on it requires a staff token. Until accounts ship, that
 * token is a shared secret entered once per session.
 */

import { VIDEO_STATUSES, type VideoStatus } from '@shared/constants.js';
import { formatDuration } from '@shared/core/duration.js';
import { formatRelativeDate } from '@shared/core/dates.js';
import { videoPath } from '@shared/core/paths.js';
import type { PageMeta } from '@shared/types/api.js';
import {
  adminApi,
  type MaintenanceStatus,
  type ResourceStatus,
  type AdminVideo,
  type InboxItem,
  type InboxName,
} from '../../data/admin-repository.js';
import { catalog } from '../../data/catalog-repository.js';
import { renderImport } from './import-screen.js';
import { confirmDialog, openDialog } from '../../ui/components/dialog.js';
import { pagination } from '../../ui/components/pagination.js';
import { toastError, toastSuccess } from '../../ui/components/toast.js';
import { emptyState, errorState } from '../../ui/components/video-card.js';
import {
  debounce,
  delegate,
  formatCount,
  html,
  on,
  select,
  selectAll,
  setHtml,
  type SafeHtml,
} from '../../ui/dom.js';
import { icon } from '../../ui/icons.js';

type Screen = 'dashboard' | 'videos' | 'inbox' | 'import' | 'search';

const SCREENS: readonly { key: Screen; label: string }[] = [
  { key: 'dashboard', label: 'לוח בקרה' },
  { key: 'videos', label: 'סרטונים' },
  { key: 'inbox', label: 'פניות ודיווחים' },
  { key: 'import', label: 'ייבוא מקובץ' },
  { key: 'search', label: 'תובנות חיפוש' },
];

const INBOX_TABS: readonly { key: InboxName; label: string }[] = [
  { key: 'reports', label: 'דיווחים' },
  { key: 'submissions', label: 'הצעות סרטונים' },
  { key: 'feedback', label: 'הערות' },
  { key: 'contact', label: 'פניות' },
];

const STATUS_LABELS: Readonly<Record<string, string>> = {
  draft: 'טיוטה',
  pending: 'ממתין',
  published: 'מפורסם',
  hidden: 'מוסתר',
  broken: 'שבור',
  removed: 'הוסר',
  new: 'חדש',
  reviewing: 'בטיפול',
  waiting: 'ממתין',
  resolved: 'טופל',
  closed: 'סגור',
  approved: 'אושר',
  rejected: 'נדחה',
  duplicate: 'כפילות',
};

/** Mount the admin into its root element. */
export function mountAdmin(root: HTMLElement): void {
  void start(root);
}

async function start(root: HTMLElement): Promise<void> {
  if (adminApi.token() == null) {
    renderLogin(root);
    return;
  }

  try {
    await adminApi.session();
    renderShell(root);
  } catch {
    adminApi.clearToken();
    renderLogin(root, 'הטוקן אינו תקף. נסו שוב.');
  }
}

// ------------------------------------------------------------------- Login

function renderLogin(root: HTMLElement, message?: string): void {
  setHtml(
    root,
    html`
      <div class="panel" style="max-width:28rem;margin-inline:auto">
        <h2>כניסה לאזור הניהול</h2>
        <p class="muted">האזור מוגן. הזינו את מפתח הניהול כדי להמשיך.</p>
        <form class="form-grid" data-login style="margin-block-start:var(--space-4)">
          <div class="field">
            <label for="admin-token">מפתח ניהול</label>
            <input
              class="input"
              id="admin-token"
              type="password"
              autocomplete="current-password"
              required
            />
            ${message == null ? '' : html`<span class="field-error">${message}</span>`}
          </div>
          <button class="btn btn--primary" type="submit">כניסה</button>
        </form>
      </div>
    `,
  );

  on(select<HTMLFormElement>('[data-login]', root), 'submit', (event) => {
    event.preventDefault();
    const input = select<HTMLInputElement>('#admin-token', root);
    const token = input.value.trim();
    if (token.length === 0) return;

    adminApi.setToken(token);
    void adminApi
      .session()
      .then(() => {
        renderShell(root);
      })
      .catch(() => {
        adminApi.clearToken();
        renderLogin(root, 'המפתח שגוי');
      });
  });
}

// ------------------------------------------------------------------- Shell

function renderShell(root: HTMLElement): void {
  let screen: Screen = (new URL(window.location.href).hash.slice(1) as Screen) || 'dashboard';

  setHtml(
    root,
    html`
      <div class="tabs" role="tablist" data-admin-nav>
        ${SCREENS.map(
          (item) => html`
            <button
              type="button"
              role="tab"
              data-screen="${item.key}"
              aria-selected="${item.key === screen ? 'true' : 'false'}"
            >
              ${item.label}
            </button>
          `,
        )}
        <button
          type="button"
          class="btn btn--ghost btn--sm"
          style="margin-inline-start:auto"
          data-logout
        >
          יציאה
        </button>
      </div>
      <div data-admin-screen></div>
    `,
  );

  const container = select('[data-admin-screen]', root);

  const show = (next: Screen): void => {
    screen = next;
    window.history.replaceState(null, '', `#${next}`);
    for (const button of selectAll('[data-screen]', root)) {
      button.setAttribute('aria-selected', String(button.getAttribute('data-screen') === next));
    }
    void renderScreen(container, next);
  };

  delegate(root, 'click', '[data-screen]', (_event, button) => {
    const next = button.dataset.screen as Screen | undefined;
    if (next != null) show(next);
  });

  on(select('[data-logout]', root), 'click', () => {
    adminApi.clearToken();
    renderLogin(root);
  });

  show(screen);
}

async function renderScreen(container: HTMLElement, screen: Screen): Promise<void> {
  setHtml(container, html`<p class="muted" style="padding:var(--space-6)">טוען…</p>`);

  try {
    switch (screen) {
      case 'videos':
        await renderVideos(container);
        break;
      case 'inbox':
        await renderInbox(container);
        break;
      case 'import':
        await renderImport(container);
        break;
      case 'search':
        await renderSearchInsights(container);
        break;
      default:
        await renderDashboard(container);
        break;
    }
  } catch (error) {
    setHtml(container, errorState(error instanceof Error ? error.message : 'שגיאה בטעינה'));
  }
}

// --------------------------------------------------------------- Dashboard

async function renderDashboard(container: HTMLElement): Promise<void> {
  const [data, maintenance, resources] = await Promise.all([
    adminApi.overview(),
    // A dashboard that fails because one panel could not load is a bad
    // dashboard; a panel that cannot load simply does not appear.
    adminApi.maintenance().catch((): MaintenanceStatus | null => null),
    adminApi.resources().catch((): ResourceStatus | null => null),
  ]);

  setHtml(
    container,
    html`
      <div class="section">
        <div class="channel-grid">
          ${statCard('סרטונים פעילים', data.counters.videos, 'play')}
          ${statCard('נוספו השבוע', data.counters.addedThisWeek, 'upload')}
          ${statCard('מוסתרים', data.counters.hidden, 'eye')}
          ${statCard('מסומנים כשבורים', data.counters.broken, 'alert')}
          ${statCard('ערוצים', data.counters.channels, 'channel')}
          ${statCard('תגיות', data.counters.tags, 'tag')}
        </div>
      </div>

      ${maintenancePanel(maintenance)} ${resourcePanel(resources)}

      <div class="section">
        <div class="section-heading"><h2>ממתין לטיפול</h2></div>
        <div class="channel-grid">
          ${statCard('דיווחים פתוחים', data.inbox.reports, 'flag')}
          ${statCard('הצעות סרטונים', data.inbox.submissions, 'inbox')}
          ${statCard('הערות', data.inbox.feedback, 'message')}
          ${statCard('פניות', data.inbox.contact, 'user')}
        </div>
      </div>

      <div class="section">
        <div class="section-heading"><h2>חיפושים ללא תוצאות</h2></div>
        ${
          data.zeroResults.length === 0
            ? html`<p class="muted">אין חיפושים ללא תוצאות בחודש האחרון.</p>`
            : html`<div class="panel">
                <ul class="info-list">
                  ${data.zeroResults.map(
                    (row) => html`<li><strong>${row.rawQuery}</strong> — ${row.hits} פעמים</li>`,
                  )}
                </ul>
              </div>`
        }
      </div>

      <div class="section">
        <div class="section-heading"><h2>פעילות אחרונה</h2></div>
        <div class="panel">
          <ul class="info-list">
            ${
              data.activity.length === 0
                ? html`<li class="muted">אין פעילות מתועדת עדיין.</li>`
                : data.activity.map(
                    (row) =>
                      html`<li>
                        ${row.action} · ${row.entityId} · ${formatRelativeDate(row.createdAt)}
                      </li>`,
                  )
            }
          </ul>
        </div>
      </div>
    `,
  );

  wireMaintenance(container);
}

/**
 * The link checker's own panel.
 *
 * A cron job nobody can see is indistinguishable from one that stopped three
 * weeks ago, so the dashboard says plainly when it last ran and how much of
 * the catalog it has covered.
 */
function wireMaintenance(container: HTMLElement): void {
  const button = container.querySelector<HTMLButtonElement>('[data-run-maintenance]');
  if (button == null) return;

  on(button, 'click', () => {
    button.disabled = true;
    button.textContent = 'בודק…';

    void adminApi
      .runMaintenance()
      .then((report) => {
        toastSuccess(
          `נבדקו ${formatCount(report.checked)} סרטונים — ${formatCount(report.broken)} נכשלו`,
        );
        void renderDashboard(container);
      })
      .catch((error: unknown) => {
        toastError(error instanceof Error ? error.message : 'הבדיקה נכשלה');
        button.disabled = false;
        button.textContent = 'הרצה עכשיו';
      });
  });
}

function maintenancePanel(status: MaintenanceStatus | null): SafeHtml {
  if (status == null) return html``;

  const last = status.runs[0];
  const percent =
    status.coverage.total === 0
      ? 0
      : Math.round((status.coverage.checked / status.coverage.total) * 100);

  return html`
    <div class="section">
      <div class="section-heading">
        <h2>בדיקת קישורים</h2>
        <button class="btn btn--secondary btn--sm" type="button" data-run-maintenance>
          הרצה עכשיו
        </button>
      </div>

      <div class="panel">
        <p>
          נבדקו <strong>${formatCount(status.coverage.checked)}</strong> מתוך
          <strong>${formatCount(status.coverage.total)}</strong> סרטונים (${String(percent)}%),
          מתוכם <strong>${formatCount(status.coverage.broken)}</strong> מסומנים כשבורים.
        </p>
        <p class="muted" style="margin-block-start:var(--space-2)">
          ${
            last == null
              ? 'הבודק עדיין לא רץ.'
              : html`ריצה אחרונה: ${last.ranAt.slice(0, 16).replace('T', ' ')} —
                ${formatCount(last.checked)} נבדקו, ${formatCount(last.broken)} נכשלו,
                ${formatCount(last.recovered)} חזרו לעבוד.`
          }
        </p>
      </div>
    </div>
  `;
}

/**
 * Storage against the plan limit.
 *
 * This site runs on a free plan: one D1 database of 500 MB. The catalog is 18
 * MiB of that and barely moves — the only way to reach the limit is a table
 * that grows with traffic, quietly, over months. That failure arrives as writes
 * beginning to fail, with no warning, which is why it gets a panel rather than
 * a note in a document nobody re-reads.
 *
 * The forecast is the number worth reading. A database at 4% that doubles every
 * month is in more trouble than one at 40% that is flat.
 */
function resourcePanel(status: ResourceStatus | null): SafeHtml {
  if (status == null) return html``;

  const { database } = status;
  const percent = Math.min(100, Math.round(database.usedFraction * 100));
  const warn = database.usedFraction >= status.limits.warnAtFraction;
  const stale = isCounterRefreshStale(status.counters.lastRefreshedAt);

  // Only the tables worth looking at: everything else is noise on this screen.
  const growing = status.tables
    .filter((table) => (table.growthPerMonth ?? 0) > 0 || table.estimatedBytes > 512 * 1024)
    .slice(0, 8);

  return html`
    <div class="section">
      <div class="section-heading"><h2>שימוש במשאבים</h2></div>

      <div class="panel">
        <p>
          <strong>בקשות Worker</strong> — המגבלה שנפגשים בה ראשונה:
          <strong>${formatCount(status.requests.limitPerDay)}</strong> ביום. במהלך גלישה טיפוסי (דף
          הבית, שני סרטונים וקטגוריה) זה כ-<strong>${String(status.requests.perVisitor)}</strong>
          בקשות למבקר, כלומר בערך
          <strong>${formatCount(status.requests.visitorsPerDay)}</strong> מבקרים ביום.
        </p>
        <p class="muted" style="margin-block-start:var(--space-2)">
          קבצים סטטיים (HTML, CSS, JS, גופנים, תמונות) אינם נספרים כלל. המספר המדויק של הבקשות בפועל
          נמצא בלוח הבקרה של Cloudflare — לא נספר כאן בכוונה, כי כתיבה ל-DB בכל בקשה הייתה מבזבזת
          מכסת כתיבה כדי למדוד מכסת בקשות.
        </p>
      </div>

      <div class="panel" style="margin-block-start:var(--space-3)">
        <p>
          מסד הנתונים: <strong>${formatBytes(database.estimatedBytes)}</strong> מתוך
          <strong>${formatBytes(database.limitBytes)}</strong> (${String(percent)}%${
            warn ? ' — קרוב לגבול' : ''
          }).
        </p>

        <div
          class="progress"
          role="progressbar"
          aria-valuenow="${String(percent)}"
          aria-valuemin="0"
          aria-valuemax="100"
          aria-label="ניצול נפח מסד הנתונים"
        >
          <span
            class="progress__bar"
            data-state="${warn ? 'warn' : 'ok'}"
            style="inline-size:${String(Math.max(1, percent))}%"
          ></span>
        </div>

        <p class="muted" style="margin-block-start:var(--space-2)">
          ${
            database.monthsToLimit == null
              ? 'אין גדילה מדודה בחודש האחרון.'
              : `בקצב הנוכחי, הגבול ייחצה בעוד כ-${formatCount(Math.round(database.monthsToLimit))} חודשים.`
          }
          ההערכה מבוססת על ספירת שורות; הגודל המדויק מופיע בלוח הבקרה של Cloudflare.
        </p>

        ${
          stale
            ? html`<p class="muted" style="margin-block-start:var(--space-2)">
                <strong>שימו לב:</strong> המונים לא רועננו יותר מ-24 שעות. ייתכן שמשימת התחזוקה
                המתוזמנת אינה רצה — המספרים באתר עלולים להיות מיושנים.
              </p>`
            : html``
        }
      </div>

      ${
        growing.length === 0
          ? html``
          : html`<div class="panel" style="margin-block-start:var(--space-3)">
              <ul class="info-list">
                ${growing.map(
                  (table) =>
                    html`<li>
                      <strong>${table.table}</strong> — ${formatCount(table.rows)} שורות,
                      ${formatBytes(table.estimatedBytes)}${formatMonthlyGrowth(table.growthPerMonth)}
                    </li>`,
                )}
              </ul>
            </div>`
      }
    </div>
  `;
}

/**
 * Whether the counter refresh has fallen behind.
 *
 * The cron runs hourly. More than a day without one means it has stopped, and
 * every count the site shows is drifting — worth saying out loud, because a
 * stalled job looks exactly like a working one from the outside.
 */
function isCounterRefreshStale(lastRefreshedAt: string | null): boolean {
  if (lastRefreshedAt == null) return true;

  // SQLite writes `CURRENT_TIMESTAMP` as "YYYY-MM-DD HH:MM:SS" in UTC, which
  // needs the `T` and the zone before `Date` will read it correctly.
  const at = Date.parse(`${lastRefreshedAt.replace(' ', 'T')}Z`);
  if (Number.isNaN(at)) return true;

  return Date.now() - at > 24 * 60 * 60 * 1000;
}

/**
 * " · +1,240 בחודש", or nothing at all.
 *
 * Empty when there is no thirty-day-old sample to compare against — a database
 * younger than a month has no growth rate, and inventing one would be worse
 * than saying nothing.
 */
function formatMonthlyGrowth(rows: number | null): string {
  if (rows == null) return '';
  return ` · ${rows >= 0 ? '+' : ''}${formatCount(rows)} בחודש`;
}

/** Bytes as KB/MB, for a dashboard rather than a disk utility. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${formatCount(bytes)} B`;
  if (bytes < 1024 * 1024) return `${formatCount(Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function statCard(label: string, value: number, iconName: Parameters<typeof icon>[0]): SafeHtml {
  return html`
    <article class="channel-card">
      <span class="empty-state__icon" style="inline-size:44px;block-size:44px"
        >${icon(iconName, { size: 20 })}</span
      >
      <div class="channel-card__body">
        <p class="muted" style="font-size:var(--text-sm)">${label}</p>
        <h3 style="font-size:var(--text-2xl)">${formatCount(value)}</h3>
      </div>
    </article>
  `;
}

// ------------------------------------------------------------------ Videos

async function renderVideos(container: HTMLElement): Promise<void> {
  const categories = await catalog.listCategories().catch(() => []);

  let filters = { q: '', status: 'all', category: 'all', page: 1 };
  let rows: readonly AdminVideo[] = [];
  let meta: PageMeta = { page: 1, limit: 50, total: 0, pages: 0 };
  const selected = new Set<string>();

  setHtml(
    container,
    html`
      <div class="section">
        <div class="filters" style="margin-block-end:var(--space-4)">
          <div class="filters__row">
            <div class="field" style="flex:1;min-inline-size:16rem">
              <label class="sr-only" for="admin-q">חיפוש</label>
              <input
                class="input"
                id="admin-q"
                type="search"
                placeholder="כותרת, מזהה YouTube או ערוץ…"
                data-q
              />
            </div>
            <div class="field">
              <label for="admin-status">סטטוס</label>
              <select class="select" id="admin-status" data-status>
                <option value="all">הכל</option>
                ${VIDEO_STATUSES.map(
                  (status) =>
                    html`<option value="${status}">${STATUS_LABELS[status] ?? status}</option>`,
                )}
                <option value="deleted">נמחקו</option>
              </select>
            </div>
            <div class="field">
              <label for="admin-category">קטגוריה</label>
              <select class="select" id="admin-category" data-category>
                <option value="all">כל הקטגוריות</option>
                ${categories.map((category) => html`<option value="${category.id}">${category.name}</option>`)}
              </select>
            </div>
          </div>
        </div>

        <div class="panel" data-bulk hidden>
          <div class="result-bar" style="margin:0">
            <strong data-selection-count></strong>
            <div class="result-bar__tools">
              <button class="btn btn--secondary btn--sm" type="button" data-bulk-action="status">
                שינוי סטטוס
              </button>
              <button class="btn btn--secondary btn--sm" type="button" data-bulk-action="category">
                שינוי קטגוריה
              </button>
              <button class="btn btn--secondary btn--sm" type="button" data-bulk-action="tag-add">
                הוספת תגית
              </button>
              <button class="btn btn--danger btn--sm" type="button" data-bulk-action="delete">
                מחיקה
              </button>
              <button class="btn btn--ghost btn--sm" type="button" data-bulk-action="clear">
                ביטול הבחירה
              </button>
            </div>
          </div>
        </div>

        <div class="result-bar"><span data-count></span></div>
        <div data-table></div>
        <div data-pager></div>
      </div>
    `,
  );

  const table = select('[data-table]', container);
  const pager = select('[data-pager]', container);
  const bulkBar = select('[data-bulk]', container);
  const countLabel = select('[data-count]', container);

  const paint = (): void => {
    countLabel.textContent = `${formatCount(meta.total)} סרטונים`;

    if (rows.length === 0) {
      setHtml(table, emptyState({ title: 'אין סרטונים שתואמים לסינון', iconName: 'search' }));
      setHtml(pager, html``);
      return;
    }

    setHtml(
      table,
      html`
        <div class="panel" style="overflow-x:auto;padding:0">
          <table style="inline-size:100%;border-collapse:collapse;font-size:var(--text-sm)">
            <thead>
              <tr style="text-align:start;border-block-end:1px solid var(--line)">
                <th style="padding:var(--space-3)">
                  <input type="checkbox" data-select-all aria-label="בחירת הכל" />
                </th>
                <th style="padding:var(--space-3);text-align:start">כותרת</th>
                <th style="padding:var(--space-3);text-align:start">קטגוריה</th>
                <th style="padding:var(--space-3);text-align:start">ערוץ</th>
                <th style="padding:var(--space-3);text-align:start">סטטוס</th>
                <th style="padding:var(--space-3);text-align:start">נוסף</th>
                <th style="padding:var(--space-3)"></th>
              </tr>
            </thead>
            <tbody>
              ${rows.map(
                (row) => html`
                  <tr data-row="${row.id}" style="border-block-end:1px solid var(--line)">
                    <td style="padding:var(--space-3)">
                      <input
                        type="checkbox"
                        data-select="${row.id}"
                        ${selected.has(row.id) ? 'checked' : ''}
                        aria-label="בחירת ${row.title}"
                      />
                    </td>
                    <td style="padding:var(--space-3);max-inline-size:26rem">
                      <a href="${videoPath(row.id)}" target="_blank" rel="noopener">${row.title}</a>
                      <div class="muted ltr" style="font-size:var(--text-xs)">
                        ${row.id} · ${formatDuration(row.durationSeconds)}
                        ${
                          row.openReports > 0
                            ? html` ·
                                <span class="badge badge--danger">${row.openReports} דיווחים</span>`
                            : ''
                        }
                      </div>
                    </td>
                    <td style="padding:var(--space-3)">${row.categoryName}</td>
                    <td style="padding:var(--space-3)">${row.channelName ?? '—'}</td>
                    <td style="padding:var(--space-3)">
                      <span class="badge">${STATUS_LABELS[row.status] ?? row.status}</span>
                      ${row.isFeatured ? html`<span class="badge badge--brand">מומלץ</span>` : ''}
                    </td>
                    <td style="padding:var(--space-3)" class="muted">
                      ${formatRelativeDate(row.addedAt)}
                    </td>
                    <td style="padding:var(--space-3)">
                      <button class="btn btn--ghost btn--sm" type="button" data-edit="${row.id}">
                        ${icon('edit', { size: 16 })}
                      </button>
                    </td>
                  </tr>
                `,
              )}
            </tbody>
          </table>
        </div>
      `,
    );

    setHtml(pager, pagination(meta));
    updateBulkBar();
  };

  const updateBulkBar = (): void => {
    bulkBar.hidden = selected.size === 0;
    select('[data-selection-count]', container).textContent = `${selected.size} נבחרו`;
  };

  const load = async (): Promise<void> => {
    const result = await adminApi.listVideos({ ...filters });
    rows = result.items;
    meta = result.meta;
    paint();
  };

  const reload = (): void => {
    void load().catch((error: unknown) => {
      toastError(error instanceof Error ? error.message : 'שגיאה בטעינה');
    });
  };

  on(
    select<HTMLInputElement>('[data-q]', container),
    'input',
    debounce((event) => {
      filters = { ...filters, q: (event.target as HTMLInputElement).value.trim(), page: 1 };
      reload();
    }, 300),
  );

  for (const [key, selector] of [
    ['status', '[data-status]'],
    ['category', '[data-category]'],
  ] as const) {
    on(select<HTMLSelectElement>(selector, container), 'change', (event) => {
      filters = { ...filters, [key]: (event.target as HTMLSelectElement).value, page: 1 };
      reload();
    });
  }

  delegate(container, 'change', '[data-select]', (_event, input) => {
    if (!(input instanceof HTMLInputElement)) return;
    const id = input.dataset.select;
    if (id == null) return;
    if (input.checked) selected.add(id);
    else selected.delete(id);
    updateBulkBar();
  });

  delegate(container, 'change', '[data-select-all]', (_event, input) => {
    if (!(input instanceof HTMLInputElement)) return;
    for (const row of rows) {
      if (input.checked) selected.add(row.id);
      else selected.delete(row.id);
    }
    for (const box of selectAll<HTMLInputElement>('[data-select]', container))
      box.checked = input.checked;
    updateBulkBar();
  });

  delegate(pager, 'click', '[data-page]', (_event, button) => {
    const page = Number(button.dataset.page);
    if (!Number.isFinite(page)) return;
    filters = { ...filters, page };
    reload();
  });

  delegate(container, 'click', '[data-bulk-action]', (_event, button) => {
    const action = button.dataset.bulkAction;
    const ids = [...selected];

    if (action === 'clear') {
      selected.clear();
      paint();
      return;
    }
    if (ids.length === 0) return;

    if (action === 'delete') {
      void confirmDialog({
        title: 'מחיקת סרטונים',
        message: `${ids.length} סרטונים יסומנו כמחוקים. אפשר לשחזר אותם מהסינון "נמחקו".`,
        confirmLabel: 'מחיקה',
        destructive: true,
      }).then(async (confirmed) => {
        if (!confirmed) return;
        const result = await adminApi.deleteVideos(ids);
        selected.clear();
        toastSuccess(`${result.changed} סרטונים נמחקו`);
        reload();
      });
      return;
    }

    if (action === 'status') {
      chooseFromList(
        'שינוי סטטוס',
        VIDEO_STATUSES.map((s) => ({ value: s, label: STATUS_LABELS[s] ?? s })),
        (value) => {
          void adminApi.bulkUpdate(ids, { status: value as VideoStatus }).then((result) => {
            selected.clear();
            toastSuccess(`${result.changed} סרטונים עודכנו`);
            reload();
          });
        },
      );
      return;
    }

    if (action === 'category') {
      chooseFromList(
        'שינוי קטגוריה',
        categories.map((c) => ({ value: c.id, label: c.name })),
        (value) => {
          void adminApi.bulkUpdate(ids, { categoryId: value }).then((result) => {
            selected.clear();
            toastSuccess(`${result.changed} סרטונים עודכנו`);
            reload();
          });
        },
      );
      return;
    }

    if (action === 'tag-add') {
      promptForText('הוספת תגית', 'שם התגית', (tag) => {
        void adminApi.bulkTag(ids, tag, 'add').then((result) => {
          selected.clear();
          toastSuccess(`התגית נוספה ל־${result.changed} סרטונים`);
          reload();
        });
      });
    }
  });

  delegate(container, 'click', '[data-edit]', (_event, button) => {
    const id = button.dataset.edit;
    const row = rows.find((item) => item.id === id);
    if (row != null) openVideoEditor(row, categories, reload);
  });

  await load();
}

function openVideoEditor(
  video: AdminVideo,
  categories: readonly { id: string; name: string }[],
  onSaved: () => void,
): void {
  const handle = openDialog({
    title: 'עריכת סרטון',
    body: html`
      <div class="form-grid">
        <div class="field">
          <label for="edit-title">כותרת</label>
          <input
            class="input"
            id="edit-title"
            type="text"
            value="${video.title}"
            data-field="title"
          />
        </div>
        <div class="form-grid form-grid--2">
          <div class="field">
            <label for="edit-category">קטגוריה</label>
            <select class="select" id="edit-category" data-field="categoryId">
              ${categories.map(
                (category) => html`
                  <option
                    value="${category.id}"
                    ${category.id === video.categoryId ? 'selected' : ''}
                  >
                    ${category.name}
                  </option>
                `,
              )}
            </select>
          </div>
          <div class="field">
            <label for="edit-status">סטטוס</label>
            <select class="select" id="edit-status" data-field="status">
              ${VIDEO_STATUSES.map(
                (status) => html`
                  <option value="${status}" ${status === video.status ? 'selected' : ''}>
                    ${STATUS_LABELS[status] ?? status}
                  </option>
                `,
              )}
            </select>
          </div>
        </div>
        <label class="check">
          <input type="checkbox" data-field="isFeatured" ${video.isFeatured ? 'checked' : ''} />
          לסמן כמומלץ
        </label>
        <div class="field">
          <label for="edit-note">הערה פנימית</label>
          <textarea class="textarea" id="edit-note" rows="3" data-field="adminNote"></textarea>
          <span class="hint">לא מוצגת למבקרים באתר.</span>
        </div>
      </div>
    `,
    footer: html`
      <button type="button" class="btn btn--secondary" data-cancel>ביטול</button>
      <button type="button" class="btn btn--primary" data-save>שמירה</button>
    `,
  });

  on(select('[data-cancel]', handle.element), 'click', () => {
    handle.close();
  });

  on(select('[data-save]', handle.element), 'click', () => {
    const value = (name: string): string =>
      select<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
        `[data-field="${name}"]`,
        handle.element,
      ).value;

    void adminApi
      .updateVideo(video.id, {
        title: value('title'),
        categoryId: value('categoryId'),
        status: value('status') as VideoStatus,
        isFeatured: select<HTMLInputElement>('[data-field="isFeatured"]', handle.element).checked,
        adminNote: value('adminNote'),
      })
      .then(() => {
        handle.close();
        toastSuccess('הסרטון עודכן');
        onSaved();
      })
      .catch((error: unknown) => {
        toastError(error instanceof Error ? error.message : 'העדכון נכשל');
      });
  });
}

// ------------------------------------------------------------------- Inbox

async function renderInbox(container: HTMLElement): Promise<void> {
  let active: InboxName = 'reports';
  let status = 'all';

  setHtml(
    container,
    html`
      <div class="section">
        <div class="tabs" data-inbox-tabs>
          ${INBOX_TABS.map(
            (tab) => html`
              <button
                type="button"
                data-inbox="${tab.key}"
                aria-selected="${tab.key === active ? 'true' : 'false'}"
              >
                ${tab.label}
              </button>
            `,
          )}
        </div>
        <div class="filters__row" style="margin-block:var(--space-4)">
          <div class="field">
            <label for="inbox-status">סטטוס</label>
            <select class="select" id="inbox-status" data-inbox-status>
              <option value="all">הכל</option>
              <option value="new">חדש</option>
              <option value="reviewing">בטיפול</option>
              <option value="resolved">טופל</option>
              <option value="closed">סגור</option>
            </select>
          </div>
        </div>
        <div data-inbox-list></div>
      </div>
    `,
  );

  const list = select('[data-inbox-list]', container);

  const load = async (): Promise<void> => {
    setHtml(list, html`<p class="muted">טוען…</p>`);
    const result = await adminApi.listInbox(active, status);
    setHtml(list, renderInboxList(result.items));
  };

  delegate(container, 'click', '[data-inbox]', (_event, button) => {
    const next = button.dataset.inbox as InboxName | undefined;
    if (next == null) return;
    active = next;
    for (const tab of selectAll('[data-inbox]', container)) {
      tab.setAttribute('aria-selected', String(tab === button));
    }
    void load();
  });

  on(select<HTMLSelectElement>('[data-inbox-status]', container), 'change', (event) => {
    status = (event.target as HTMLSelectElement).value;
    void load();
  });

  delegate(container, 'click', '[data-resolve]', (_event, button) => {
    const id = button.dataset.resolve;
    const next = button.dataset.status ?? 'resolved';
    if (id == null) return;

    void adminApi
      .updateInboxItem(active, id, next)
      .then(() => {
        toastSuccess('הפריט עודכן');
        void load();
      })
      .catch((error: unknown) => {
        toastError(error instanceof Error ? error.message : 'העדכון נכשל');
      });
  });

  await load();
}

function renderInboxList(items: readonly InboxItem[]): SafeHtml {
  if (items.length === 0) {
    return emptyState({ title: 'אין פריטים', description: 'הכול טופל.', iconName: 'check' });
  }

  return html`
    <div class="stack">
      ${items.map(
        (item) => html`
          <div class="panel">
            <div class="result-bar" style="margin:0">
              <div>
                <h3>${item.title}</h3>
                <p class="muted">${item.detail ?? ''}</p>
                <p class="muted" style="font-size:var(--text-xs)">
                  ${formatRelativeDate(item.createdAt)}
                  ${item.contactEmail == null ? '' : ` · ${item.contactEmail}`}
                  ${item.videoId == null ? '' : html` · <a href="${videoPath(item.videoId)}" target="_blank" rel="noopener">לסרטון</a>`}
                </p>
              </div>
              <div class="result-bar__tools">
                <span class="badge">${STATUS_LABELS[item.status] ?? item.status}</span>
                <button
                  class="btn btn--secondary btn--sm"
                  type="button"
                  data-resolve="${item.id}"
                  data-status="reviewing"
                >
                  בטיפול
                </button>
                <button
                  class="btn btn--primary btn--sm"
                  type="button"
                  data-resolve="${item.id}"
                  data-status="resolved"
                >
                  טופל
                </button>
              </div>
            </div>
          </div>
        `,
      )}
    </div>
  `;
}

// --------------------------------------------------------- Search insights

async function renderSearchInsights(container: HTMLElement): Promise<void> {
  const data = await adminApi.searchInsights(30);

  setHtml(
    container,
    html`
      <div class="section">
        <div class="section-heading">
          <div>
            <h2>חיפושים ללא תוצאות</h2>
            <p class="muted">מה אנשים מחפשים ולא מוצאים — כאן נמצא התוכן החסר.</p>
          </div>
        </div>
        <div class="panel">
          ${
            data.zeroResults.length === 0
              ? html`<p class="muted">אין נתונים ל־30 הימים האחרונים.</p>`
              : html`<ul class="info-list">
                  ${data.zeroResults.map(
                    (row) => html`<li><strong>${row.rawQuery}</strong> — ${row.hits} חיפושים</li>`,
                  )}
                </ul>`
          }
        </div>
      </div>

      <div class="section">
        <div class="section-heading"><h2>החיפושים הפופולריים</h2></div>
        <div class="panel">
          ${
            data.popular.length === 0
              ? html`<p class="muted">אין נתונים עדיין.</p>`
              : html`<ul class="info-list">
                  ${data.popular.map(
                    (row) =>
                      html`<li>
                        ${row.query} — ${row.hits} חיפושים, ${row.averageResults} תוצאות בממוצע
                      </li>`,
                  )}
                </ul>`
          }
        </div>
      </div>
    `,
  );
}

// ------------------------------------------------------------------ Helpers

function chooseFromList(
  title: string,
  options: readonly { value: string; label: string }[],
  onChoose: (value: string) => void,
): void {
  const handle = openDialog({
    title,
    body: html`
      <div class="field">
        <label class="sr-only" for="choice">בחירה</label>
        <select class="select" id="choice" data-choice>
          ${options.map((option) => html`<option value="${option.value}">${option.label}</option>`)}
        </select>
      </div>
    `,
    footer: html`
      <button type="button" class="btn btn--secondary" data-cancel>ביטול</button>
      <button type="button" class="btn btn--primary" data-ok>החלה</button>
    `,
  });

  on(select('[data-cancel]', handle.element), 'click', () => {
    handle.close();
  });
  on(select('[data-ok]', handle.element), 'click', () => {
    const value = select<HTMLSelectElement>('[data-choice]', handle.element).value;
    handle.close();
    onChoose(value);
  });
}

function promptForText(title: string, label: string, onSubmit: (value: string) => void): void {
  const handle = openDialog({
    title,
    body: html`
      <div class="field">
        <label for="text-input">${label}</label>
        <input class="input" id="text-input" type="text" data-text-input />
      </div>
    `,
    footer: html`
      <button type="button" class="btn btn--secondary" data-cancel>ביטול</button>
      <button type="button" class="btn btn--primary" data-ok>אישור</button>
    `,
  });

  on(select('[data-cancel]', handle.element), 'click', () => {
    handle.close();
  });
  on(select('[data-ok]', handle.element), 'click', () => {
    const value = select<HTMLInputElement>('[data-text-input]', handle.element).value.trim();
    if (value.length === 0) return;
    handle.close();
    onSubmit(value);
  });
}
