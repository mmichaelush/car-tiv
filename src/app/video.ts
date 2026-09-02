/**
 * `/video/:id` — the video page.
 *
 * Three things it does deliberately differently from the old modal:
 *
 *  * **The iframe is not loaded until the visitor presses play.** Until then
 *    the page shows a thumbnail. That is one image instead of roughly a
 *    megabyte of YouTube player code, on every single page view.
 *  * **It is a real page**, so it has its own title, description, canonical
 *    URL and Open Graph tags — shareable and indexable.
 *  * **Progress is remembered**, on a debounce, so "continue watching" on the
 *    home page has something to show.
 */

import { absoluteUrl, categoryPath, channelPath, ROUTES, videoPath } from '@shared/core/paths.js';
import { describeDuration, formatDuration } from '@shared/core/duration.js';
import { formatHebrewDate } from '@shared/core/dates.js';
import { embedUrl, isVideoId, thumbnailUrl } from '@shared/core/youtube.js';
import type { VideoDetail, VideoSummary } from '@shared/types/catalog.js';
import { startPage } from './bootstrap.js';
import { catalog } from '../data/catalog-repository.js';
import { library } from '../data/library-repository.js';
import { ApiError } from '../data/http-client.js';
import { openFeedbackDialog, openReportDialog } from '../features/video/report-dialog.js';
import { mountBreadcrumbs } from '../ui/components/breadcrumbs.js';
import { emptyState, errorState, videoRow } from '../ui/components/video-card.js';
import { shareUrl, toastSuccess } from '../ui/components/toast.js';
import { delegate, html, on, select, setHtml, setAttribute } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { setStructuredData } from '../ui/structured-data.js';

startPage();

const player = select('[data-player]');
const detail = select('[data-video-detail]');
const relatedRoot = select('[data-related]');
const breadcrumbsRoot = select('[data-breadcrumbs]');

/** `/video/dQw4w9WgXcQ` -> the id. */
const videoId = decodeURIComponent(window.location.pathname.split('/').filter(Boolean)[1] ?? '');

if (!isVideoId(videoId)) {
  setHtml(detail, errorState('הקישור אינו תקין'));
} else {
  void loadVideo(videoId);
}

async function loadVideo(id: string): Promise<void> {
  try {
    // One request for the whole page. See `getVideoPage`: the video, its
    // related videos and the channel's other videos used to be three separate
    // calls, which made this the most expensive page on the site against the
    // free plan's daily Worker-request cap.
    const video = await catalog.getVideoPage(id);
    applyMetadata(video);
    renderPlayer(video);
    renderDetail(video);
    void renderRelated(video);
    void renderChannelVideos(video);
    void recordView(video);
  } catch (error) {
    const message =
      error instanceof ApiError && error.status === 404
        ? 'הסרטון לא נמצא במאגר'
        : 'לא הצלחנו לטעון את הסרטון';
    setHtml(player, html``);
    setHtml(detail, errorState(message));
  }
}

/** Page title, description, canonical and Open Graph, for sharing and search. */
function applyMetadata(video: VideoDetail): void {
  document.title = `${video.title} | CAR־טיב`;

  const description =
    video.description.length > 0
      ? video.description.slice(0, 160)
      : `${video.categoryName} — ${video.channel?.name ?? 'CAR־טיב'}`;

  setMeta('name', 'description', description);
  setMeta('property', 'og:title', video.title);
  setMeta('property', 'og:description', description);
  setMeta('property', 'og:image', thumbnailUrl(video.id, 'max', video.thumbnailUrl));
  setMeta('property', 'og:url', absoluteUrl(videoPath(video.id), window.location.origin));

  const canonical = document.querySelector('link[rel="canonical"]');
  if (canonical != null) canonical.setAttribute('href', videoPath(video.id));

  publishStructuredData(video, description);
}

/**
 * The `VideoObject` and breadcrumb trail search engines read.
 *
 * `embedUrl` is given rather than `contentUrl`: we do not host the file, we
 * embed YouTube's player, and claiming otherwise would be wrong. The duration
 * is in ISO 8601, which is the only format the schema accepts.
 */
function publishStructuredData(video: VideoDetail, description: string): void {
  setStructuredData('video', {
    '@context': 'https://schema.org',
    '@type': 'VideoObject',
    name: video.title,
    description,
    thumbnailUrl: thumbnailUrl(video.id, 'max', video.thumbnailUrl),
    uploadDate: (video.publishedAt ?? video.addedAt).slice(0, 10),
    duration: isoDuration(video.durationSeconds),
    embedUrl: `https://www.youtube-nocookie.com/embed/${video.id}`,
    url: absoluteUrl(videoPath(video.id), window.location.origin),
    inLanguage: video.isHebrew ? 'he' : 'en',
    ...(video.channel == null
      ? {}
      : { creator: { '@type': 'Organization', name: video.channel.name } }),
  });

  mountBreadcrumbs(breadcrumbsRoot, [
    { label: 'דף הבית', href: ROUTES.home },
    { label: video.categoryName, href: categoryPath(video.categoryId) },
    { label: video.title },
  ]);
}

/** Seconds as an ISO 8601 duration, e.g. `PT8M42S`. Empty when unknown. */
function isoDuration(seconds: number): string {
  if (seconds <= 0) return 'PT0S';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return `PT${hours > 0 ? `${String(hours)}H` : ''}${minutes > 0 ? `${String(minutes)}M` : ''}${
    rest > 0 || (hours === 0 && minutes === 0) ? `${String(rest)}S` : ''
  }`;
}

function setMeta(attribute: 'name' | 'property', key: string, value: string): void {
  let element = document.querySelector(`meta[${attribute}="${key}"]`);
  if (element == null) {
    element = document.createElement('meta');
    element.setAttribute(attribute, key);
    document.head.append(element);
  }
  element.setAttribute('content', value);
}

/** Thumbnail plus a play button; the iframe arrives only on demand. */
function renderPlayer(video: VideoDetail): void {
  setHtml(
    player,
    html`
      <img
        src="${thumbnailUrl(video.id, 'standard', video.thumbnailUrl)}"
        alt="${video.title}"
        width="1280"
        height="720"
        fetchpriority="high"
      />
      <button type="button" class="player__play" data-play aria-label="הפעלת הסרטון">
        ${icon('play', { size: 30 })}
      </button>
    `,
  );

  on(select('[data-play]', player), 'click', () => {
    startPlayback(video);
  });
}

function startPlayback(video: VideoDetail): void {
  const iframe = document.createElement('iframe');
  iframe.src = embedUrl(video.id, { autoplay: true });
  iframe.title = video.title;
  iframe.allow = 'accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture';
  iframe.allowFullscreen = true;
  iframe.referrerPolicy = 'strict-origin-when-cross-origin';

  setHtml(player, html``);
  player.append(iframe);

  // The embed does not report progress without the full YouTube API, which we
  // deliberately do not load. Marking the video as started is enough for
  // "continue watching" to be useful.
  void library.recordProgress(video, 1, false);
}

function renderDetail(video: VideoDetail): void {
  const duration = formatDuration(video.durationSeconds);

  setHtml(
    detail,
    html`
      <p class="eyebrow">
        <a href="/category/${video.categoryId}">${video.categoryName}</a>
      </p>
      <h1>${video.title}</h1>

      <div class="video-detail__meta">
        <span>נוסף ב־${formatHebrewDate(video.addedAt)}</span>
        ${
          duration.length > 0
            ? html`<span title="${describeDuration(video.durationSeconds)}">${duration}</span>`
            : ''
        }
        ${video.isHebrew ? html`<span class="badge">עברית</span>` : html`<span class="badge">אנגלית</span>`}
      </div>

      ${
        video.channel == null
          ? ''
          : html`
              <div class="video-detail__channel">
                ${
                  video.channel.imageUrl == null
                    ? ''
                    : html`<img src="${video.channel.imageUrl}" alt="" width="44" height="44" />`
                }
                <div>
                  <strong>${video.channel.name}</strong>
                  <p class="muted" style="font-size:var(--text-sm)">ערוץ</p>
                </div>
                <a class="btn btn--secondary btn--sm" href="${channelPath(video.channel.slug)}">
                  כל הסרטונים מהערוץ
                </a>
              </div>
            `
      }

      <div class="video-actions">
        <button class="btn btn--secondary" type="button" data-act="favorite" aria-pressed="false">
          ${icon('heart', { size: 18 })} מועדפים
        </button>
        <button
          class="btn btn--secondary"
          type="button"
          data-act="watch-later"
          aria-pressed="false"
        >
          ${icon('clock', { size: 18 })} לצפייה מאוחר יותר
        </button>
        <button class="btn btn--secondary" type="button" data-act="watched">
          ${icon('check', { size: 18 })} סמנו כנצפה
        </button>
        <button class="btn btn--secondary" type="button" data-act="share">
          ${icon('share', { size: 18 })} שיתוף
        </button>
        <a
          class="btn btn--secondary"
          href="https://www.youtube.com/watch?v=${video.id}"
          target="_blank"
          rel="noopener noreferrer"
          >${icon('external', { size: 18 })} ב־YouTube</a
        >
        <button class="btn btn--ghost" type="button" data-act="feedback">
          ${icon('message', { size: 18 })} הערה
        </button>
        <button class="btn btn--danger" type="button" data-act="report">
          ${icon('flag', { size: 18 })} דיווח על בעיה
        </button>
      </div>

      ${
        video.vehicles.length === 0
          ? ''
          : html`
              <div class="video-vehicles">
                ${video.vehicles.map(
                  (vehicle) => html`
                    <a
                      class="chip"
                      href="/search?manufacturer=${encodeURIComponent(vehicle.manufacturer)}"
                    >
                      ${icon('car', { size: 14 })} ${vehicle.manufacturer} ${vehicle.model}
                      ${vehicle.yearFrom == null ? '' : ` · ${vehicle.yearFrom}`}
                    </a>
                  `,
                )}
              </div>
            `
      }
      ${
        video.description.length === 0
          ? ''
          : html`
              <div class="panel" style="margin-block-start:var(--space-4)">
                <p class="video-description" data-collapsed="true" data-description>
                  ${video.description}
                </p>
                <button class="btn btn--ghost btn--sm" type="button" data-act="expand">
                  הצגת התיאור המלא
                </button>
              </div>
            `
      }
      ${
        video.tags.length === 0
          ? ''
          : html`
              <div class="tag-cloud" style="margin-block-start:var(--space-4)">
                ${video.tags.map(
                  (tag) =>
                    html`<a class="chip" href="/search?tags=${encodeURIComponent(tag)}">${tag}</a>`,
                )}
              </div>
            `
      }
    `,
  );

  void syncActionState(video);
  bindActions(video);
}

async function syncActionState(video: VideoDetail): Promise<void> {
  const [isFavorite, isSaved] = await Promise.all([
    library.has('favorites', video.id),
    library.has('watchLater', video.id),
  ]);

  const favorite = detail.querySelector('[data-act="favorite"]');
  if (favorite != null) setAttribute(favorite, 'aria-pressed', String(isFavorite));

  const later = detail.querySelector('[data-act="watch-later"]');
  if (later != null) setAttribute(later, 'aria-pressed', String(isSaved));
}

function bindActions(video: VideoDetail): void {
  delegate(detail, 'click', '[data-act]', (_event, button) => {
    switch (button.dataset.act) {
      case 'favorite':
        void library.toggle('favorites', video).then((added) => {
          setAttribute(button, 'aria-pressed', String(added));
          toastSuccess(added ? 'נוסף למועדפים' : 'הוסר מהמועדפים');
        });
        break;

      case 'watch-later':
        void library.toggle('watchLater', video).then((added) => {
          setAttribute(button, 'aria-pressed', String(added));
          toastSuccess(added ? 'נוסף לרשימת הצפייה' : 'הוסר מהרשימה');
        });
        break;

      case 'watched':
        void library.markWatched(video).then(() => {
          toastSuccess('סומן כנצפה');
        });
        break;

      case 'share':
        void shareUrl(absoluteUrl(videoPath(video.id), window.location.origin), video.title);
        break;

      case 'report':
        openReportDialog(video);
        break;

      case 'feedback':
        openFeedbackDialog(video);
        break;

      case 'expand': {
        const description = detail.querySelector<HTMLElement>('[data-description]');
        if (description == null) return;
        const collapsed = description.dataset.collapsed === 'true';
        description.dataset.collapsed = collapsed ? 'false' : 'true';
        button.textContent = collapsed ? 'הצגה מקוצרת' : 'הצגת התיאור המלא';
        break;
      }

      default:
        break;
    }
  });
}

async function renderRelated(video: VideoDetail): Promise<void> {
  try {
    // Already in the payload when the page asked for it. Falling back to the
    // separate endpoint keeps this working if the combined response ever comes
    // from somewhere that did not include it — a cached older response, or a
    // caller that fetched the video on its own.
    const related = video.related ?? (await catalog.getRelated(video.id));
    if (related.length === 0) {
      setHtml(relatedRoot, emptyState({ title: 'אין כרגע סרטונים דומים', iconName: 'play' }));
      return;
    }
    setHtml(relatedRoot, html`${related.map((item) => videoRow(item))}`);
  } catch {
    setHtml(relatedRoot, html`<p class="muted">לא הצלחנו לטעון סרטונים דומים.</p>`);
  }
}

async function renderChannelVideos(video: VideoDetail): Promise<void> {
  if (video.channel == null) return;
  const section = select('[data-channel-section]');
  const container = select('[data-channel-videos]');

  try {
    // Same again: the combined payload already excludes the video being watched
    // and is capped server-side, so the filter and slice below are what make
    // the fallback path produce an identical list.
    const videos = video.channelVideos ?? (await catalog.getChannel(video.channel.slug)).videos;
    const others = videos.filter((item: VideoSummary) => item.id !== video.id).slice(0, 6);
    if (others.length === 0) return;

    section.hidden = false;
    setHtml(container, html`${others.map((item) => videoRow(item))}`);
  } catch {
    // The sidebar is supplementary; a failure here is not worth surfacing.
  }
}

/** Record that the visitor opened the video, if they allow history. */
async function recordView(video: VideoDetail): Promise<void> {
  const { readPreferences } = await import('../features/preferences/preferences.js');
  if (!readPreferences().saveHistory) return;
  await library.recordProgress(video, 0, false);
}
