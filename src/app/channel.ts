/**
 * `/channel/:slug` — one channel and everything of theirs in the catalog.
 */

import { ROUTES } from '@shared/core/paths.js';
import { startPage } from './bootstrap.js';
import { catalog } from '../data/catalog-repository.js';
import { ApiError } from '../data/http-client.js';
import { mountCatalogView } from '../features/catalog/catalog-view.js';
import { mountBreadcrumbs } from '../ui/components/breadcrumbs.js';
import { countLabel, html, select, setHtml } from '../ui/dom.js';
import { icon } from '../ui/icons.js';

startPage({ active: 'channels' });

/**
 * The slug out of `/channel/<slug>`.
 *
 * `decodeURIComponent` throws a `URIError` on a stray `%`, which a hand-typed
 * or truncated address can easily contain, and an exception here would leave
 * the page blank rather than merely wrong.
 */
function slugFromPath(): string {
  const raw = window.location.pathname.split('/').filter(Boolean)[1] ?? '';
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

const slug = slugFromPath();
const header = select('[data-channel-header]');

mountCatalogView({
  root: select('[data-catalog]'),
  fixed: { channel: slug },
  showCategories: false,
});

void catalog
  .getChannel(slug)
  .then(({ channel }) => {
    document.title = `${channel.name} | CAR־טיב`;

    mountBreadcrumbs(select('[data-breadcrumbs]'), [
      { label: 'דף הבית', href: ROUTES.home },
      { label: 'ערוצים', href: ROUTES.channels },
      { label: channel.name },
    ]);

    setHtml(
      header,
      html`
        ${
          channel.imageUrl == null
            ? ''
            : html`<img src="${channel.imageUrl}" alt="" width="56" height="56" />`
        }
        <div class="channel-card__body">
          <p class="eyebrow">ערוץ</p>
          <h1 style="font-size:var(--text-2xl);margin-block:var(--space-1) var(--space-2)">
            ${channel.name}
          </h1>
          <p>${channel.description}</p>
          <p class="channel-card__meta">
            ${channel.netfreeOpen === true ? 'פתוח בנטפרי' : channel.netfreeOpen === false ? 'לא פתוח בנטפרי' : 'סטטוס נטפרי לא ידוע'}
            ·
            ${channel.hasHebrewVideos === true ? 'כולל סרטונים בעברית' : channel.hasHebrewVideos === false ? 'ללא סרטונים בעברית' : 'זמינות עברית לא ידועה'}
          </p>
          <p class="channel-card__meta">
            ${channel.videoCount == null ? '' : `${countLabel(channel.videoCount, 'סרטון', 'סרטונים')} במאגר`}
          </p>
          ${
            channel.youtubeUrl == null
              ? ''
              : html`<a
                  class="btn btn--secondary btn--sm"
                  style="margin-block-start:var(--space-3)"
                  href="${channel.youtubeUrl}"
                  target="_blank"
                  rel="noopener noreferrer"
                  >${icon('external', { size: 16 })} הערוץ ב־YouTube</a
                >`
          }
        </div>
      `,
    );
  })
  .catch((cause: unknown) => {
    // Not "not found" for everything.
    //
    // This used to answer every possible failure with "הערוץ לא נמצא" — a
    // dropped connection, a filtered request, a 500, an aborted fetch — and it
    // was wrong nearly every time it appeared, because a channel reached by
    // clicking it in the list a second earlier does exist. Saying so sent the
    // reader looking for a broken link instead of a broken connection, and
    // gave them nothing to press.
    //
    // A 404 is now the only thing reported as missing. Everything else says
    // what actually happened and offers the one action that can help.
    const error = cause instanceof ApiError ? cause : null;

    if (error?.status === 404) {
      document.title = 'הערוץ לא נמצא | CAR־טיב';
      setHtml(
        header,
        html`
          <div class="page-header">
            <h1>הערוץ לא נמצא</h1>
            <p>ייתכן שהוא הוסר מהמאגר, או שהכתובת שגויה.</p>
            <a class="btn btn--secondary" href="${ROUTES.channels}">
              ${icon('channel', { size: 18 })} לכל הערוצים
            </a>
          </div>
        `,
      );
      return;
    }

    // The status is worth printing: it is the difference between "the server
    // said no" and "the request never arrived", and on a filtered connection
    // it is the only clue either of us gets.
    const detail =
      error == null
        ? 'שגיאה לא צפויה'
        : error.status === 0
          ? 'הבקשה לא הגיעה לשרת — ייתכן שהחיבור נקטע או שסונן'
          : `${error.message} (${String(error.status)})`;

    setHtml(
      header,
      html`
        <div class="page-header">
          <h1>לא הצלחנו לטעון את פרטי הערוץ</h1>
          <p>${detail}</p>
          <button class="btn btn--primary" type="button" data-retry-channel>נסו שוב</button>
        </div>
      `,
    );

    const retry = header.querySelector('[data-retry-channel]');
    if (retry != null) {
      retry.addEventListener('click', () => {
        window.location.reload();
      });
    }
  });
