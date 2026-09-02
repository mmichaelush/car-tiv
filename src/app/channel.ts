/**
 * `/channel/:slug` — one channel and everything of theirs in the catalog.
 */

import { ROUTES } from '@shared/core/paths.js';
import { startPage } from './bootstrap.js';
import { catalog } from '../data/catalog-repository.js';
import { mountCatalogView } from '../features/catalog/catalog-view.js';
import { mountBreadcrumbs } from '../ui/components/breadcrumbs.js';
import { formatCount, html, select, setHtml } from '../ui/dom.js';
import { icon } from '../ui/icons.js';

startPage({ active: 'channels' });

const slug = decodeURIComponent(window.location.pathname.split('/').filter(Boolean)[1] ?? '');
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
            ${channel.videoCount == null ? '' : `${formatCount(channel.videoCount)} סרטונים במאגר`}
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
  .catch(() => {
    setHtml(header, html`<h1>הערוץ לא נמצא</h1>`);
  });
