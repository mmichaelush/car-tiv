/**
 * The site shell: header, footer, back-to-top and the page-level keyboard
 * shortcuts.
 *
 * Rendered from one place so a navigation change is a single edit rather than
 * a search across fifteen HTML files, and so every page is guaranteed to have
 * the skip link, the theme control and the personal-library entry point.
 */

import { categoryPath, ROUTES } from '@shared/core/paths.js';
import { html, on, select, setHtml, toggleClass } from '../dom.js';
import { icon, type IconName } from '../icons.js';
import { mountSearchBox } from '../components/search-box.js';
import { catalog } from '../../data/catalog-repository.js';
import { openThemeDialog } from '../../features/preferences/theme-dialog.js';
import { readPreferences, updatePreferences } from '../../features/preferences/preferences.js';
import { openLibraryDialog } from '../../features/library/library-dialog.js';
import { mountCommandPalette, openCommandPalette } from '../../features/command-palette/palette.js';
import { mountShortcutsHelp } from '../../features/command-palette/shortcuts.js';

/** Which navigation entry is the current page. */
export type ActiveNav =
  'home' | 'search' | 'channels' | 'library' | 'about' | 'contact' | 'add-video' | null;

export interface ShellOptions {
  readonly active?: ActiveNav;
  /**
   * `false` on the home page, where the hero already has a large search field
   * and a second one in the header would be noise.
   */
  readonly headerSearch?: boolean;
}

/** The public contact address, shown in the footer and on the contact page. */
export const SITE_EMAIL = 'michaelush613@gmail.com';

/**
 * The six categories the legacy footer linked to, in its order.
 *
 * Hard-coded rather than fetched: the footer renders on every page, including
 * pages that make no catalog request at all, and a network round-trip for six
 * links nobody has asked for is not worth the latency. The ids are stable —
 * they are the primary keys of the `categories` table.
 */
const FOOTER_CATEGORIES: readonly { id: string; name: string }[] = [
  { id: 'review', name: 'סקירות רכב' },
  { id: 'maintenance', name: 'טיפולים' },
  { id: 'diy', name: 'עשה זאת בעצמך' },
  { id: 'upgrades', name: 'שיפורים ושדרוגים' },
  { id: 'troubleshooting', name: 'איתור ותיקון תקלות' },
  { id: 'collectors', name: 'רכבי אספנות' },
];

/**
 * The navigation, in groups.
 *
 * Grouped because the rail shows all of it at once and an undivided list of
 * eight links is harder to scan than three short ones. The group headings are
 * hidden while the rail is collapsed — there is no room for them, and the
 * separators still do the dividing.
 */
interface NavItem {
  readonly key: ActiveNav;
  readonly href: string;
  readonly label: string;
  readonly iconName: IconName;
}

const NAV_GROUPS: readonly { title: string; items: readonly NavItem[] }[] = [
  {
    title: 'עיון',
    items: [
      { key: 'home', href: ROUTES.home, label: 'דף הבית', iconName: 'home' },
      { key: 'search', href: ROUTES.search, label: 'חיפוש וסינון', iconName: 'search' },
      { key: 'channels', href: ROUTES.channels, label: 'ערוצים', iconName: 'channel' },
    ],
  },
  {
    title: 'שלי',
    items: [
      { key: 'library', href: ROUTES.library, label: 'הספרייה שלי', iconName: 'library' },
      { key: 'add-video', href: ROUTES.addVideo, label: 'הצעת סרטון', iconName: 'plus' },
    ],
  },
  {
    title: 'מידע',
    items: [
      { key: 'about', href: ROUTES.about, label: 'אודות', iconName: 'info' },
      { key: 'contact', href: ROUTES.contact, label: 'צור קשר', iconName: 'mail' },
    ],
  },
];

/**
 * Render the shell into the `[data-site-header]` and `[data-site-footer]`
 * placeholders every page ships with, and wire its behaviour.
 */
export function mountShell(options: ShellOptions = {}): void {
  renderRail(options);
  renderHeader(options);
  renderFooter();
  mountBackToTop();
  mountShortcuts();
  mountCommandPalette();
  mountShortcutsHelp();
}

/**
 * The navigation rail.
 *
 * One element that behaves as two things, which is what the platforms this is
 * modelled on actually do:
 *
 *   * **Wide screens** — a fixed rail beside the content, expanded (icon and
 *     label) or collapsed (icon only). The page is inset by its width, so the
 *     content never sits underneath it. The collapsed/expanded choice is a
 *     preference, so it survives a reload.
 *   * **Narrow screens** — the same markup, off-canvas, opened by the header's
 *     menu button over a scrim.
 *
 * Built here rather than added to all thirteen HTML files: the header and
 * footer already work this way, so navigation stays a single edit.
 *
 * Inserted before `<main>` so the tab order is header → navigation → content,
 * which is the order it reads in. The skip link still jumps straight past it.
 */
function renderRail(options: ShellOptions): void {
  const main = document.getElementById('main');
  if (main == null) return;

  const rail = document.createElement('aside');
  rail.id = 'site-rail';
  rail.className = 'site-rail';
  rail.dataset.siteRail = '';

  setHtml(
    rail,
    html`
      <nav class="site-rail__nav" aria-label="ניווט ראשי">
        ${NAV_GROUPS.map(
          (group) => html`
            <p class="site-rail__group">${group.title}</p>
            <ul>
              ${group.items.map(
                (item) => html`
                  <li>
                    <a
                      href="${item.href}"
                      ${options.active === item.key ? 'aria-current="page"' : ''}
                    >
                      <span class="site-rail__icon">${icon(item.iconName, { size: 20 })}</span>
                      <span class="site-rail__label">${item.label}</span>
                    </a>
                  </li>
                `,
              )}
            </ul>
          `,
        )}
      </nav>

      <button
        type="button"
        class="site-rail__collapse"
        data-rail-collapse
        aria-label="כיווץ התפריט"
        title="כיווץ התפריט"
      >
        <span class="site-rail__icon">${icon('chevronEnd', { size: 18 })}</span>
        <span class="site-rail__label">כיווץ</span>
      </button>
    `,
  );

  const scrim = document.createElement('div');
  scrim.className = 'site-rail__scrim';
  scrim.dataset.railScrim = '';
  scrim.hidden = true;

  main.before(rail);
  main.before(scrim);

  applyRailState(readPreferences().navCollapsed);
  bindRail(scrim);
}

/** Write the collapsed state where the stylesheet can see it. */
function applyRailState(collapsed: boolean): void {
  document.documentElement.dataset.rail = collapsed ? 'collapsed' : 'expanded';

  const button = document.querySelector('[data-rail-collapse]');
  if (button == null) return;
  const label = collapsed ? 'הרחבת התפריט' : 'כיווץ התפריט';
  button.setAttribute('aria-label', label);
  button.setAttribute('title', label);
}

/** Open and close the drawer, and collapse and expand the rail. */
function bindRail(scrim: HTMLElement): void {
  const closeDrawer = (): void => {
    document.documentElement.removeAttribute('data-rail-open');
    scrim.hidden = true;
    const toggle = document.querySelector('[data-menu-toggle]');
    toggle?.setAttribute('aria-expanded', 'false');
  };

  on(document, 'click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    if (target.closest('[data-menu-toggle]') != null) {
      // The same button is the drawer on a phone and the collapse toggle is
      // its own control on a desktop, so this only ever opens the drawer.
      const open = document.documentElement.getAttribute('data-rail-open') == null;
      if (open) {
        document.documentElement.setAttribute('data-rail-open', '');
        scrim.hidden = false;
      } else {
        closeDrawer();
      }
      target.closest('[data-menu-toggle]')?.setAttribute('aria-expanded', String(open));
      return;
    }

    if (target.closest('[data-rail-collapse]') != null) {
      const collapsed = !readPreferences().navCollapsed;
      updatePreferences({ navCollapsed: collapsed });
      applyRailState(collapsed);
      return;
    }

    // A link inside the drawer navigates, and the drawer should not still be
    // open behind the new page on a browser that restores scroll position.
    if (target.closest('[data-site-rail] a') != null) closeDrawer();
    if (target.closest('[data-rail-scrim]') != null) closeDrawer();
  });

  on(document, 'keydown', (event) => {
    if (event.key === 'Escape') closeDrawer();
  });
}

/**
 * Page-level keyboard shortcuts.
 *
 * `/` focuses the most prominent search field — the hero one where it exists,
 * otherwise the header one. The hero advertises the shortcut with a `<kbd>`
 * hint, so it has to actually work.
 *
 * The handler bails out whenever the visitor is already typing: inside an
 * input, a textarea, a `contenteditable` region, or with a modifier held. A
 * shortcut that eats a character mid-sentence is worse than no shortcut.
 */
function mountShortcuts(): void {
  on(document, 'keydown', (event) => {
    if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return;

    const active = document.activeElement;
    if (active instanceof HTMLElement) {
      const tag = active.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || active.isContentEditable) {
        return;
      }
    }
    if (document.querySelector('dialog[open]') != null) return;

    const field = findSearchField();
    if (field == null) return;

    event.preventDefault();
    field.focus();
    field.select();
  });
}

/**
 * The search field `/` should land on.
 *
 * Tried in priority order rather than as one comma-separated selector:
 * `querySelector` with a list returns the first match in *document* order, and
 * the header comes before the page content — which would send every press to
 * the small header field even on a page with a large one.
 */
function findSearchField(): HTMLInputElement | null {
  const selectors = [
    '[data-hero-search] input[type="search"]',
    '[data-page-search] input[type="search"]',
    '[data-channel-search]',
    '[data-header-search] input[type="search"]',
  ];

  for (const selector of selectors) {
    const field = document.querySelector<HTMLInputElement>(selector);
    if (field != null) return field;
  }
  return null;
}

function renderHeader(options: ShellOptions): void {
  const header = document.querySelector('[data-site-header]');
  if (header == null) return;

  const withSearch = options.headerSearch !== false;

  setHtml(
    header,
    html`
      <div class="site-header__inner shell">
        <a class="brand" href="${ROUTES.home}" aria-label="CAR-טיב, לדף הבית">
          <img src="/assets/images/logo.png" alt="" width="34" height="34" />
          <span>CAR<span class="brand__mark">־טיב</span></span>
        </a>

        ${
          withSearch
            ? html`
                <form class="header-search" role="search" data-header-search>
                  <div class="search">
                    <span class="search__icon">${icon('search', { size: 18 })}</span>
                    <label class="sr-only" for="header-search-input">חיפוש במאגר</label>
                    <input
                      id="header-search-input"
                      type="search"
                      name="q"
                      autocomplete="off"
                      placeholder="חיפוש סרטון, יצרן או דגם…"
                    />
                    <button
                      type="button"
                      class="search__clear"
                      data-search-clear
                      hidden
                      aria-label="ניקוי החיפוש"
                    >
                      ${icon('close', { size: 16 })}
                    </button>
                    <div class="suggestions" data-suggestions hidden></div>
                  </div>
                </form>
              `
            : ''
        }

        <div class="header-actions">
          <!-- Filled in by the account feature once the session resolves. -->
          <div class="account-slot" data-account-slot></div>
          <button
            class="icon-btn"
            type="button"
            data-open-palette
            aria-label="חיפוש מהיר ופקודות"
            title="חיפוש מהיר (Ctrl+K)"
          >
            ${icon('command', { size: 18 })}
          </button>
          <button
            class="icon-btn"
            type="button"
            data-open-library
            aria-label="הספרייה שלי"
            title="הספרייה שלי"
          >
            ${icon('library', { size: 18 })}
          </button>
          <button
            class="icon-btn"
            type="button"
            data-open-theme
            aria-label="ערכת נושא והעדפות"
            title="ערכת נושא"
          >
            ${icon('settings', { size: 18 })}
          </button>
          <button
            class="icon-btn menu-toggle"
            type="button"
            data-menu-toggle
            aria-label="תפריט"
            aria-expanded="false"
            aria-controls="site-rail"
          >
            ${icon('menu', { size: 18 })}
          </button>
        </div>
      </div>
    `,
  );

  const searchForm = header.querySelector<HTMLFormElement>('[data-header-search]');
  if (searchForm != null) {
    mountSearchBox({
      form: searchForm,
      suggest: (query, signal) => catalog.suggest(query, signal),
    });
  }

  on(select('[data-open-palette]', header), 'click', () => {
    openCommandPalette();
  });

  on(select('[data-open-theme]', header), 'click', () => {
    openThemeDialog();
  });

  on(select('[data-open-library]', header), 'click', () => {
    void openLibraryDialog();
  });
}

function renderFooter(): void {
  const footer = document.querySelector('[data-site-footer]');
  if (footer == null) return;

  const year = new Date().getFullYear();

  setHtml(
    footer,
    html`
      <div class="shell">
        <div class="site-footer__grid">
          <div>
            <a class="brand" href="${ROUTES.home}">
              <img src="/assets/images/logo.png" alt="" width="34" height="34" />
              <span>CAR<span class="brand__mark">־טיב</span></span>
            </a>
            <p class="site-footer__about">
              מאגר וידאו ייעודי, כשר ומסונן, לחובבי רכב שומרי התורה והמצוות.
            </p>
          </div>

          <div>
            <h3>קטגוריות מומלצות</h3>
            <nav>
              ${FOOTER_CATEGORIES.map(
                (category) => html`<a href="${categoryPath(category.id)}">${category.name}</a>`,
              )}
            </nav>
          </div>

          <div>
            <h3>קישורים</h3>
            <nav>
              <a href="https://rechavimzelaze.ovh/" target="_blank" rel="noopener noreferrer">
                פורום רכבים זה לזה
              </a>
              <a
                href="https://rechavimzelaze.ovh/post/683722"
                target="_blank"
                rel="noopener noreferrer"
              >
                עוד על האתר
              </a>
              <a href="${ROUTES.channels}">ערוצים</a>
              <a href="${ROUTES.library}">הספרייה שלי</a>
              <a href="${ROUTES.contact}">צור קשר</a>
              <a href="${ROUTES.addVideo}">הוספת סרטונים</a>
            </nav>
          </div>

          <div>
            <h3>משפטי</h3>
            <nav>
              <a href="${ROUTES.about}">אודות</a>
              <a href="${ROUTES.privacy}">מדיניות פרטיות</a>
              <a href="${ROUTES.terms}">תנאי שימוש</a>
              <a href="${ROUTES.contact}?subject=${encodeURIComponent('דיווח על תוכן')}">
                דיווח על תוכן
              </a>
              <a href="mailto:${SITE_EMAIL}">${SITE_EMAIL}</a>
            </nav>
          </div>
        </div>

        <div class="site-footer__bottom">
          <span>© ${year} CAR־טיב. כל הזכויות שמורות.</span>
          <span>הסרטונים מוצגים מ־YouTube ובבעלות היוצרים שלהם.</span>
          <span>
            עיצוב ופיתוח:
            <a href="https://github.com/mmichaelush" target="_blank" rel="noopener noreferrer">
              @מיכאלוש
            </a>
            בסיוע AI
          </span>
        </div>
      </div>
    `,
  );
}

/** The floating "back to top" button, shown once the page has scrolled. */
function mountBackToTop(): void {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'back-to-top';
  button.setAttribute('aria-label', 'חזרה לראש העמוד');
  setHtml(button, icon('arrowUp', { size: 20 }));
  document.body.append(button);

  on(button, 'click', () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  // A passive listener with a rAF guard: scroll handlers are the easiest way
  // to make a page feel slow, and this one runs on every wheel tick.
  let scheduled = false;
  on(
    window,
    'scroll',
    () => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        toggleClass(button, 'is-visible', window.scrollY > 600);
        scheduled = false;
      });
    },
    { passive: true },
  );
}
