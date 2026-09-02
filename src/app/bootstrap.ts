/**
 * The five lines every page runs before anything else.
 *
 * Kept in one place so a new page cannot forget the stylesheet, the shell or
 * the preference application — and so adding a global concern (an analytics
 * opt-in, a service worker) is one edit rather than fifteen.
 */

import '../styles/main.css';

import { initAccount } from '../features/account/account.js';
import { mountAccountMenu } from '../features/account/account-menu.js';
import { applyPreferences } from '../features/preferences/preferences.js';
import { registerServiceWorker } from '../features/pwa/service-worker.js';
import { mountShell, type ShellOptions } from '../ui/layout/shell.js';
import { setStorageFailureReporter } from '../data/library-repository.js';
import { toastError } from '../ui/components/toast.js';

/**
 * Start a page.
 *
 * @param options  Passed straight to the shell: which nav item is current, and
 *                 whether the header shows its own search field.
 */
export function startPage(options: ShellOptions = {}): void {
  // The bootstrap script in <head> already set the attributes before paint;
  // this re-applies them from the full preference object, which also covers
  // the case where storage was unreadable at that point.
  applyPreferences();

  mountShell(options);
  setCanonicalUrl();
  installGlobalErrorReporting();
  installStorageFailureReporting();

  // No third-party script in the management area.
  //
  // The admin page holds a staff token in `sessionStorage` and can edit or
  // delete any video. Anything loaded from a tag manager runs with the full
  // privileges of that origin: it can read the token, or simply call the admin
  // API as the logged-in editor. Container contents are changed outside this
  // repository and outside review, so the only safe answer is not to load it
  // here — and analytics on an internal tool has no value anyway.
  if (!isAdminArea()) loadAnalytics();

  // The account resolves in the background. Nothing on the page waits for it:
  // the catalog is public, the local library is already on screen, and the
  // header's account slot fills itself in when the answer arrives.
  mountAccountMenu();
  void initAccount();

  registerServiceWorker();
}

/**
 * Say so when the browser refuses to store the library.
 *
 * `library-repository` cannot show a toast itself — nothing in `src/data/`
 * imports from `src/ui/` — so it reports the failure and this installs the
 * handler. Without it, favouriting a video in Safari's private mode filled the
 * heart, moved the card, and lost the change on the next reload, silently.
 *
 * The message names both likely causes, because the visitor can act on one of
 * them and at least understand the other.
 */
function installStorageFailureReporting(): void {
  setStorageFailureReporter(() => {
    toastError(
      'לא הצלחנו לשמור את השינוי במכשיר הזה — ייתכן שאחסון הדפדפן מלא או שאתם בגלישה פרטית. הרשימה תיעלם ברענון.',
      { durationMs: 9_000 },
    );
  });
}

/**
 * Whether this page is part of the management area.
 *
 * Path-based rather than a flag passed by the caller, so a new admin screen is
 * covered the day it is added instead of the day someone remembers to opt it
 * out.
 */
function isAdminArea(): boolean {
  return window.location.pathname.startsWith('/admin');
}

/**
 * Google Tag Manager, if a container is configured.
 *
 * The legacy site had the GTM snippet inline in the `<head>` of every page, on
 * the critical path and repeated fifteen times. Here it is one module-level
 * call, loaded after the page has started, with the container id coming from
 * `VITE_GTM_ID` at build time — so staging and local builds are simply not
 * measured, and the id is never duplicated across HTML files.
 *
 * `dataLayer` is initialised from this module rather than from an inline
 * `<script>`, which is what lets the Content-Security-Policy keep `script-src`
 * free of `'unsafe-inline'`.
 */
function loadAnalytics(): void {
  // Vite types `import.meta.env` entries as `any`; narrow it once, here.
  const containerId: unknown = import.meta.env.VITE_GTM_ID;
  if (typeof containerId !== 'string' || containerId.length === 0) return;

  // Never measure a developer's own machine.
  const host = window.location.hostname;
  if (host === 'localhost' || host === '127.0.0.1' || host.endsWith('.local')) return;

  // An explicit "do not track" is a request, and this one is cheap to honour.
  if (navigator.doNotTrack === '1') return;

  const global = window as unknown as { dataLayer?: unknown[] };
  global.dataLayer ??= [];
  global.dataLayer.push({ 'gtm.start': Date.now(), event: 'gtm.js' });

  const script = document.createElement('script');
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtm.js?id=${encodeURIComponent(containerId)}`;
  document.head.append(script);
}

/**
 * Point `<link rel="canonical">` at this page, without its query string.
 *
 * It is set here rather than in the static HTML for two reasons: the origin
 * differs per environment (local, staging, production) and must not be baked
 * into a file, and a filtered listing such as `/search?q=…&page=3` should
 * declare `/search` as its canonical form rather than compete with itself in
 * search results. Pages with a genuinely different canonical — a video —
 * overwrite it after their data loads.
 */
function setCanonicalUrl(): void {
  const canonical = new URL(window.location.pathname, window.location.origin).toString();

  let link = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (link == null) {
    link = document.createElement('link');
    link.rel = 'canonical';
    document.head.append(link);
  }
  link.href = canonical;
}

/**
 * Turn an unhandled rejection into something the visitor can see.
 *
 * Without this, a failed promise in an event handler is a silent no-op: the
 * button appears to do nothing. A toast is not a fix, but it is honest.
 */
function installGlobalErrorReporting(): void {
  window.addEventListener('unhandledrejection', (event) => {
    // An aborted request is a normal part of superseding a search.
    if (event.reason instanceof DOMException && event.reason.name === 'AbortError') return;

    console.error('Unhandled rejection', event.reason);
    toastError('משהו השתבש. נסו לרענן את העמוד');
  });
}
