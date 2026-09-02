/**
 * The home page.
 *
 * Renders the rows the `home_sections` table defines, in the order it defines
 * them, so the page can be rearranged from the admin without a deployment.
 * Two of those rows — "continue watching" and "for your car" — are filled from
 * the visitor's own device rather than from the server.
 */

import { channelPath } from '@shared/core/paths.js';
import type { Category, Channel, HomeSection, VideoSummary } from '@shared/types/catalog.js';
import { startPage } from './bootstrap.js';
import { catalog } from '../data/catalog-repository.js';
import { library } from '../data/library-repository.js';
import { mountCardActions, readCardState } from '../features/library/card-actions.js';
import { mountCarousel } from '../ui/components/carousel.js';
import { categoryGrid } from '../ui/components/category-card.js';
import { mountSearchBox } from '../ui/components/search-box.js';
import { errorState, skeletonGrid, videoGrid } from '../ui/components/video-card.js';
import { byData, formatCount, html, select, setHtml } from '../ui/dom.js';

startPage({ active: 'home', headerSearch: false });

const sectionsRoot = select('[data-home-sections]');
const channelsRoot = select('[data-featured-channels]');
const categoriesRoot = select('[data-category-grid]');
const channelCarousel = mountCarousel({ root: select('[data-carousel]') });

/** Every video currently on the page, so the card actions can find one by id. */
const videosById = new Map<string, VideoSummary>();

mountSearchBox({
  form: select<HTMLFormElement>('[data-hero-search]'),
  suggest: (query, signal) => catalog.suggest(query, signal),
});

setHtml(
  sectionsRoot,
  html`<div class="section"><div class="video-grid">${skeletonGrid(8)}</div></div>`,
);

void loadHome();

async function loadHome(): Promise<void> {
  try {
    const payload = await catalog.getHome();

    for (const stat of ['videos', 'channels', 'categories'] as const) {
      const element = document.querySelector(`[data-stat="${stat}"]`);
      if (element != null) element.textContent = formatCount(payload.stats[stat]);
    }

    renderCategories(payload.categories);

    const personal = await buildPersonalSections();
    const sections = mergeSections(payload.sections, personal);

    const state = await readCardState();
    for (const section of sections) {
      for (const video of section.videos) videosById.set(video.id, video);
    }

    setHtml(
      sectionsRoot,
      html`${sections.map(
        (section) => html`
          <section class="section" aria-labelledby="section-${section.id}">
            <div class="section-heading">
              <div>
                <h2 id="section-${section.id}">${section.title}</h2>
              </div>
              ${
                section.href == null
                  ? ''
                  : html`<a class="btn btn--secondary btn--sm" href="${section.href}">הכל</a>`
              }
            </div>
            <div class="video-rail">${videoGrid(section.videos, state)}</div>
          </section>
        `,
      )}`,
    );

    mountCardActions({ container: sectionsRoot, getVideo: (id) => videosById.get(id) });
    renderChannels(payload.featuredChannels);
  } catch {
    setHtml(sectionsRoot, errorState('לא הצלחנו לטעון את דף הבית'));
    const retry = byData('action', sectionsRoot);
    retry?.addEventListener('click', () => {
      void loadHome();
    });
  }
}

/**
 * The two rows that come from the visitor's own device.
 *
 * The server returns them empty — it has no idea what this person watched —
 * and drops them entirely when there is nothing to show.
 */
async function buildPersonalSections(): Promise<Map<string, VideoSummary[]>> {
  const result = new Map<string, VideoSummary[]>();

  const continueWatching = await library.continueWatching(8);
  const videos = continueWatching
    .map((entry) => entry.snapshot)
    .filter((video): video is VideoSummary => video != null);
  if (videos.length > 0) result.set('continue-watching', videos);

  const vehicle = await library.primaryVehicle();
  if (vehicle != null) {
    try {
      const page = await catalog.listVideos({
        ...emptyQuery(),
        manufacturer: vehicle.manufacturer,
        model: vehicle.model,
        limit: 12,
      });
      if (page.items.length > 0) result.set('for-your-car', [...page.items]);
    } catch {
      // A failed personal row is not worth failing the page over.
    }
  }

  return result;
}

/** Fill the personal rows and drop any row that ended up empty. */
function mergeSections(
  sections: readonly HomeSection[],
  personal: ReadonlyMap<string, VideoSummary[]>,
): HomeSection[] {
  return sections
    .map((section) => {
      const replacement = personal.get(section.type);
      return replacement == null ? section : { ...section, videos: replacement };
    })
    .filter((section) => section.videos.length > 0);
}

/** The category showcase. Hidden entirely when the catalog has no categories. */
function renderCategories(categories: readonly Category[]): void {
  if (categories.length === 0) {
    categoriesRoot.closest('section')?.setAttribute('hidden', '');
    return;
  }
  setHtml(categoriesRoot, categoryGrid(categories));
}

function renderChannels(channels: readonly Channel[]): void {
  if (channels.length === 0) {
    channelsRoot.closest('section')?.setAttribute('hidden', '');
    return;
  }

  setHtml(
    channelsRoot,
    html`${channels.map(
      (channel) => html`
        <article class="channel-card">
          ${
            channel.imageUrl == null
              ? ''
              : html`<img src="${channel.imageUrl}" alt="" loading="lazy" width="56" height="56" />`
          }
          <div class="channel-card__body">
            <h3><a href="${channelPath(channel.slug)}">${channel.name}</a></h3>
            <p>${channel.description}</p>
            <p class="channel-card__meta">
              ${channel.videoCount == null ? '' : `${formatCount(channel.videoCount)} סרטונים`}
            </p>
          </div>
        </article>
      `,
    )}`,
  );

  // The rail only knows whether it can scroll once it has content in it.
  channelCarousel.refresh();
}

/** A blank query object, so the personal row does not repeat every default. */
function emptyQuery() {
  return {
    q: '',
    category: 'all',
    channel: null,
    tags: [] as string[],
    manufacturer: null as string | null,
    model: null as string | null,
    year: null as number | null,
    hebrewOnly: false,
    featuredOnly: false,
    minDurationSeconds: null as number | null,
    maxDurationSeconds: null as number | null,
    sort: 'date-desc' as const,
    page: 1,
    limit: 12,
  };
}
