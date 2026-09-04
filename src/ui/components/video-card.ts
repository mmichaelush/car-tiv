/**
 * The video card, and the grids and rows built from it.
 *
 * Rendering is pure: these functions take data and return markup. Nothing here
 * touches the DOM or attaches a listener — the pages own the events, using
 * delegation from the grid container, so re-rendering a grid can never leak
 * listeners or double-bind a handler.
 *
 * The whole card is clickable via a stretched `::after` on the title link, so
 * there is exactly one real link per card: middle-click, "open in new tab" and
 * screen readers all behave the way a visitor expects.
 */

import { formatDuration } from '@shared/core/duration.js';
import { formatRelativeDate } from '@shared/core/dates.js';
import { ROUTES, videoPath } from '@shared/core/paths.js';
import { slugify } from '@shared/core/text.js';
import { thumbnailUrl } from '@shared/core/youtube.js';
import type { VideoSummary } from '@shared/types/catalog.js';
import { html, type SafeHtml } from '../dom.js';
import { icon } from '../icons.js';
import { illustration } from '../illustrations.js';

export interface CardOptions {
  /** Ids the visitor has favourited, so the heart renders filled. */
  readonly favorites?: ReadonlySet<string>;
  /** Ids already in "watch later". */
  readonly watchLater?: ReadonlySet<string>;
  /** videoId -> fraction watched (0–1), for the progress bar. */
  readonly progress?: ReadonlyMap<string, number>;
  /** Thumbnail size. `medium` for dense grids and rows. */
  readonly thumbnailQuality?: 'medium' | 'high';
  /** Hide the action row entirely — used inside the player sidebar. */
  readonly withActions?: boolean;
  /**
   * Override the excerpt the summary carries.
   *
   * The card falls back to `VideoSummary.excerpt`, which the listing endpoint
   * caps in SQL. This exists for the places that already hold the full text —
   * the video page's own sidebar — so they need not truncate it twice.
   */
  readonly description?: string;
}

/**
 * Tags shown on a card.
 *
 * Six, over two rows. It was three over one row, and one row is too few: a
 * Hebrew tag is a whole word, so two long ones fill a card's width and the
 * third is cut off — the row read as "there is one more tag" when there were
 * often eight, and the tags are the fastest route into a filtered listing.
 *
 * Still bounded, because a card is a glance. The catalog has videos with a
 * dozen tags, and a card that showed them all would be a tag list with a
 * thumbnail on top. `--card-tag-rows` in `cards.css` is what actually clips it;
 * this number only decides how many are available to fill those rows.
 */
const CARD_TAGS = 6;

/** One card. */
export function videoCard(video: VideoSummary, options: CardOptions = {}): SafeHtml {
  const href = videoPath(video.id);
  const duration = formatDuration(video.durationSeconds);
  const isFavorite = options.favorites?.has(video.id) ?? false;
  const isSaved = options.watchLater?.has(video.id) ?? false;
  const progress = options.progress?.get(video.id) ?? 0;
  const excerpt = (options.description ?? video.excerpt).trim();

  return html`
    <article class="video-card" data-video-id="${video.id}">
      <div class="video-card__media">
        <img
          src="${thumbnailUrl(video.id, options.thumbnailQuality ?? 'high', video.thumbnailUrl)}"
          alt=""
          loading="lazy"
          decoding="async"
          width="480"
          height="270"
        />
        <button
          type="button"
          class="video-card__play"
          data-action="play-inline"
          aria-label="נגן כאן: ${video.title}"
          title="נגן כאן"
        >
          ${icon('play', { size: 22 })}
        </button>
        ${duration.length > 0 ? html`<span class="video-card__duration">${duration}</span>` : ''}
        ${
          video.isFeatured
            ? html`<span class="video-card__flag badge badge--brand">מומלץ</span>`
            : ''
        }
        ${
          progress > 0
            ? html`<span class="video-card__progress"
                ><i style="width:${Math.round(progress * 100)}%"></i
              ></span>`
            : ''
        }
      </div>

      <div class="video-card__body">
        <p class="video-card__category">${video.categoryName}</p>

        <h3 class="video-card__title">
          <a class="video-card__title-link" href="${href}">${video.title}</a>
        </h3>

        ${
          video.channel == null
            ? ''
            : html`
                <p class="video-card__channel">
                  ${
                    video.channel.imageUrl == null
                      ? ''
                      : html`<img
                          src="${video.channel.imageUrl}"
                          alt=""
                          loading="lazy"
                          width="22"
                          height="22"
                        />`
                  }
                  <span><bdi>${video.channel.name}</bdi></span>
                </p>
              `
        }
        ${
          // Rendered on every card and shown by CSS only in the list view on a
          // wide screen, where there is a column of empty space beside the
          // thumbnail. Doing it in CSS rather than in a branch here means one
          // card component, and switching view does not re-fetch anything.
          excerpt.length === 0 ? '' : html`<p class="video-card__description">${excerpt}</p>`
        }

        <div class="video-card__meta">
          <span>${formatRelativeDate(video.addedAt)}</span>
        </div>

        ${
          // The tags the API already sends. `VideoSummary.tags` is documented as
          // "a short slice of the video's tags, for the card footer" and the card
          // simply never rendered it, so every card dropped them — and with the
          // counters unrefreshed the tag filter looked empty too, which together
          // read as "tags are broken".
          //
          // They are links, not decoration: a tag on a card is the fastest route
          // into the filtered listing for that tag.
          video.tags.length === 0
            ? ''
            : html`
                <ul class="video-card__tags" aria-label="תגיות">
                  ${video.tags.slice(0, CARD_TAGS).map(
                    (tag) => html`
                      <li>
                        <a class="chip chip--tag" href="${ROUTES.search}?tags=${slugify(tag)}"
                          >${tag}</a
                        >
                      </li>
                    `,
                  )}
                </ul>
              `
        }
        ${options.withActions === false ? '' : cardActions(video, isFavorite, isSaved)}
      </div>
    </article>
  `;
}

function cardActions(video: VideoSummary, isFavorite: boolean, isSaved: boolean): SafeHtml {
  return html`
    <div class="video-card__actions">
      <button
        type="button"
        data-action="favorite"
        aria-pressed="${isFavorite ? 'true' : 'false'}"
        aria-label="${isFavorite ? 'הסרה מהמועדפים' : 'הוספה למועדפים'}"
        title="${isFavorite ? 'הסרה מהמועדפים' : 'הוספה למועדפים'}"
      >
        ${icon('heart', { size: 18 })}
      </button>
      <button
        type="button"
        data-action="watch-later"
        aria-pressed="${isSaved ? 'true' : 'false'}"
        aria-label="${isSaved ? 'הסרה מרשימת הצפייה' : 'צפייה מאוחר יותר'}"
        title="${isSaved ? 'הסרה מרשימת הצפייה' : 'צפייה מאוחר יותר'}"
      >
        ${icon('clock', { size: 18 })}
      </button>
      <button type="button" data-action="fullscreen" aria-label="נגן במסך מלא" title="מסך מלא">
        ${icon('expand', { size: 18 })}
      </button>
      <button type="button" data-action="share" aria-label="שיתוף הסרטון" title="שיתוף">
        ${icon('share', { size: 18 })}
      </button>
      <a
        href="https://www.youtube.com/watch?v=${video.id}"
        target="_blank"
        rel="noopener noreferrer"
        aria-label="פתיחה ב־YouTube"
        title="פתיחה ב־YouTube"
      >
        ${icon('external', { size: 18 })}
      </a>
    </div>
  `;
}

/** A grid of cards. */
export function videoGrid(videos: readonly VideoSummary[], options: CardOptions = {}): SafeHtml {
  return html`${videos.map((video) => videoCard(video, options))}`;
}

/** A compact row, for the player sidebar and the personal library. */
export function videoRow(video: VideoSummary, progress = 0): SafeHtml {
  const duration = formatDuration(video.durationSeconds);
  return html`
    <article class="video-row" data-video-id="${video.id}">
      <img
        src="${thumbnailUrl(video.id, 'medium', video.thumbnailUrl)}"
        alt=""
        loading="lazy"
        decoding="async"
        width="132"
        height="74"
      />
      <div>
        <h3><a href="${videoPath(video.id)}">${video.title}</a></h3>
        <small
          >${video.channel?.name ?? video.categoryName}${duration.length > 0 ? ` · ${duration}` : ''}</small
        >
      </div>
      ${
        progress > 0
          ? html`<span class="video-row__progress"
              ><i style="width:${Math.round(progress * 100)}%"></i
            ></span>`
          : ''
      }
    </article>
  `;
}

/**
 * Placeholder cards shown while a request is in flight.
 * Never on a timer — the old site's fixed 1.5-second preloader is gone.
 */
export function skeletonGrid(count = 8): SafeHtml {
  const card = html`
    <div class="skeleton" aria-hidden="true">
      <div class="skeleton__media"></div>
      <div class="skeleton__line"></div>
      <div class="skeleton__line skeleton__line--short"></div>
    </div>
  `;
  return html`${Array.from({ length: count }, () => card)}`;
}

export interface EmptyStateOptions {
  readonly title: string;
  readonly description?: string;
  readonly actionLabel?: string;
  /** `data-action` value put on the button, for delegated handling. */
  readonly actionName?: string;
  readonly iconName?: Parameters<typeof icon>[0];
}

/** The "nothing here" panel, with a way out. */
export function emptyState(options: EmptyStateOptions): SafeHtml {
  return html`
    <div class="empty-state">
      ${
        // A car with its bonnet up, rather than a magnifying glass.
        //
        // An empty result is the most-seen state on a catalog site and it was
        // the most generic thing on it. A picture of the site's own subject
        // says "we looked and there is nothing here" in a way a search glyph
        // does not, and it reads as the site working rather than as the visitor
        // having done something wrong. Callers that want the small glyph
        // instead pass `iconName`.
        options.iconName == null
          ? html`<span class="empty-state__art">${illustration('carBonnet', { width: 200 })}</span>`
          : html`<span class="empty-state__icon">${icon(options.iconName, { size: 28 })}</span>`
      }
      <h3>${options.title}</h3>
      ${options.description == null ? '' : html`<p>${options.description}</p>`}
      ${
        options.actionLabel == null
          ? ''
          : html`<button
              class="btn btn--secondary"
              type="button"
              data-action="${options.actionName ?? 'reset'}"
            >
              ${options.actionLabel}
            </button>`
      }
    </div>
  `;
}

/** The "we could not load this" panel, with a retry. */
export function errorState(message = 'לא הצלחנו לטעון את התוכן'): SafeHtml {
  return html`
    <div class="empty-state">
      <span class="empty-state__art">${illustration('tools', { width: 168 })}</span>
      <h3>${message}</h3>
      <p>ייתכן שיש בעיית חיבור זמנית.</p>
      <button class="btn btn--primary" type="button" data-action="retry">נסו שוב</button>
    </div>
  `;
}
