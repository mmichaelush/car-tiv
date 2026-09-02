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
import { icon } from '../icons.js';
import { mountSearchBox } from '../components/search-box.js';
import { catalog } from '../../data/catalog-repository.js';
import { openThemeDialog } from '../../features/preferences/theme-dialog.js';
import { openLibraryDialog } from '../../features/library/library-dialog.js';
import { mountCommandPalette, openCommandPalette } from '../../features/command-palette/palette.js';
import { mountShortcutsHelp } from '../../features/command-palette/shortcuts.js';

/** Which navigation entry is the current page. */
export type ActiveNav = 'home' | 'channels' | 'library' | 'about' | 'contact' | 'add-video' | null;

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

const NAV_ITEMS: readonly { key: ActiveNav; href: string; label: string }[] = [
  { key: 'home', href: ROUTES.home, label: 'דף הבית' },
  { key: 'channels', href: ROUTES.channels, label: 'ערוצים' },
  { key: 'add-video', href: ROUTES.addVideo, label: 'הצעת סרטון' },
  { key: 'about', href: ROUTES.about, label: 'אודות' },
  { key: 'contact', href: ROUTES.contact, label: 'צור קשר' },
];

/**
 * Render the shell into the `[data-site-header]` and `[data-site-footer]`
 * placeholders every page ships with, and wire its behaviour.
 */
export function mountShell(options: ShellOptions = {}): void {
  renderHeader(options);
  renderFooter();
  mountBackToTop();
  mountShortcuts();
  mountCommandPalette();
  mountShortcutsHelp();
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

        <nav class="main-nav" data-main-nav aria-label="ניווט ראשי">
          ${NAV_ITEMS.map(
            (item) => html`
              <a href="${item.href}" ${options.active === item.key ? 'aria-current="page"' : ''}>
                ${item.label}
              </a>
            `,
          )}
        </nav>

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

  const menuToggle = select('[data-menu-toggle]', header);
  const nav = select('[data-main-nav]', header);
  on(menuToggle, 'click', () => {
    const open = nav.classList.toggle('is-open');
    menuToggle.setAttribute('aria-expanded', String(open));
  });

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
              <a
                href="https://github.com/mmichaelush/kosher-car-videos"
                target="_blank"
                rel="noopener noreferrer"
              >
                הפרוייקט ב־GitHub
              </a>
              <a href="${ROUTES.channels}">ערוצים</a>
              <a href="${ROUTES.library}">הספרייה שלי</a>
              <a href="${ROUTES.contact}">צור קשר</a>
              <a href="${ROUTES.addVideo}#duplicate-check">בדוק אם סרטון קיים</a>
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
