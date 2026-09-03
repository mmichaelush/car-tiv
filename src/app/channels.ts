/**
 * `/channels/` — every channel in the catalog, searchable.
 */

import { channelPath, ROUTES } from '@shared/core/paths.js';
import type { PageMeta } from '@shared/types/api.js';
import type { Channel } from '@shared/types/catalog.js';
import { startPage } from './bootstrap.js';
import { catalog } from '../data/catalog-repository.js';
import { mountBreadcrumbs } from '../ui/components/breadcrumbs.js';
import { emptyState, errorState } from '../ui/components/video-card.js';
import { pagination } from '../ui/components/pagination.js';
import {
  countLabel,
  debounce,
  delegate,
  formatCount,
  html,
  on,
  select,
  setHtml,
} from '../ui/dom.js';

startPage({ active: 'channels' });

const grid = select('[data-channel-grid]');
const pager = select('[data-pager]');
const summary = select('[data-result-summary]');
const searchInput = select<HTMLInputElement>('[data-channel-search]');

mountBreadcrumbs(select('[data-breadcrumbs]'), [
  { label: 'דף הבית', href: ROUTES.home },
  { label: 'ערוצים מומלצים' },
]);

const url = new URL(window.location.href);
let query = url.searchParams.get('q') ?? '';
let page = Number(url.searchParams.get('page') ?? 1);

searchInput.value = query;

void load();

on(
  searchInput,
  'input',
  debounce(() => {
    query = searchInput.value.trim();
    page = 1;
    void load();
  }, 250),
);

delegate(pager, 'click', '[data-page]', (_event, button) => {
  const next = Number(button.dataset.page);
  if (!Number.isFinite(next) || next < 1) return;
  page = next;
  void load().then(() => {
    grid.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
});

delegate(grid, 'click', '[data-action="reset"]', () => {
  searchInput.value = '';
  query = '';
  page = 1;
  void load();
});

async function load(): Promise<void> {
  syncUrl();
  summary.textContent = 'טוען ערוצים…';

  try {
    const result = await catalog.listChannels({ q: query, page, limit: 24 });
    render(result.items, result.meta);
  } catch {
    setHtml(grid, errorState('לא הצלחנו לטעון את רשימת הערוצים'));
    setHtml(pager, html``);
  }
}

function render(channels: readonly Channel[], meta: PageMeta): void {
  summary.textContent =
    meta.total === 0 ? 'לא נמצאו ערוצים' : `במאגר קיימים ${formatCount(meta.total)} ערוצים`;

  if (channels.length === 0) {
    setHtml(
      grid,
      emptyState({
        title: 'לא נמצא ערוץ מתאים',
        description: 'אפשר לנסות איות אחר, או לנקות את החיפוש.',
        actionLabel: 'ניקוי החיפוש',
        iconName: 'channel',
      }),
    );
    setHtml(pager, html``);
    return;
  }

  setHtml(
    grid,
    html`${channels.map(
      (channel) => html`
        <article class="channel-card">
          ${
            channel.imageUrl == null
              ? ''
              : html`<img src="${channel.imageUrl}" alt="" loading="lazy" width="56" height="56" />`
          }
          <div class="channel-card__body">
            <!-- One link, stretched over the whole card by the
                 .channel-card h3 a::after rule, so the card is clickable while
                 middle-click, "open in new tab" and screen readers still see a
                 single ordinary link. The channel page it opens lists every
                 video of theirs. -->
            <h3>
              <a href="${channelPath(channel.slug)}"><bdi>${channel.name}</bdi></a>
            </h3>
            <p>${channel.description}</p>
            <p class="channel-card__meta">
              ${
                // No "מומלץ". Every channel in this catalog is one whose videos
                // passed the same check, so a badge on some of them says nothing
                // a visitor can act on — it only implies the others are worse.
                channel.videoCount == null ? '' : countLabel(channel.videoCount, 'סרטון', 'סרטונים')
              }
            </p>
          </div>
        </article>
      `,
    )}`,
  );

  setHtml(pager, pagination(meta));
}

function syncUrl(): void {
  const params = new URLSearchParams();
  if (query.length > 0) params.set('q', query);
  if (page > 1) params.set('page', String(page));
  const search = params.toString();
  window.history.replaceState(
    null,
    '',
    `${window.location.pathname}${search.length > 0 ? `?${search}` : ''}`,
  );
}
