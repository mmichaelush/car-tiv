/**
 * Card actions: favourite, watch later, share.
 *
 * One delegated listener on the grid container handles every card, so the grid
 * can be re-rendered as often as it likes without leaking or duplicating
 * listeners — and adding a card costs nothing.
 */

import { absoluteUrl, videoPath } from '@shared/core/paths.js';
import type { VideoSummary } from '@shared/types/catalog.js';
import { delegate, selectAll, setAttribute } from '../../ui/dom.js';
import { shareUrl, toastSuccess } from '../../ui/components/toast.js';
import { library } from '../../data/library-repository.js';
import { playInCard } from '../video/inline-player.js';

/**
 * Below this viewport width, "play here" navigates to the video page instead.
 * A 16:9 player inside a phone-width card is not something anyone watches, and
 * the legacy site drew the same line.
 */
const INLINE_PLAY_MIN_WIDTH = 768;

export interface CardActionsOptions {
  /** The element containing the cards. */
  readonly container: Element;
  /** Look up the video behind a card id — the page owns the current page of data. */
  readonly getVideo: (videoId: string) => VideoSummary | undefined;
}

/**
 * Wire the action buttons inside `container`.
 * @returns A function that removes the listener.
 */
export function mountCardActions(options: CardActionsOptions): () => void {
  return delegate(options.container, 'click', '[data-action]', (event, button) => {
    const card = button.closest<HTMLElement>('[data-video-id]');
    const videoId = card?.dataset.videoId;
    if (videoId == null) return;

    const video = options.getVideo(videoId);
    if (video == null) return;

    // These buttons sit inside a card whose title link covers the whole card,
    // so the click must not also navigate.
    event.preventDefault();
    event.stopPropagation();

    switch (button.dataset.action) {
      case 'favorite':
        void library.toggle('favorites', video).then((added) => {
          setPressed(button, added);
          toastSuccess(added ? 'נוסף למועדפים' : 'הוסר מהמועדפים');
        });
        break;

      case 'watch-later':
        void library.toggle('watchLater', video).then((added) => {
          setPressed(button, added);
          toastSuccess(added ? 'נוסף לרשימת הצפייה' : 'הוסר מרשימת הצפייה');
        });
        break;

      case 'share':
        void shareUrl(absoluteUrl(videoPath(video.id), window.location.origin), video.title);
        break;

      case 'play-inline':
        // On a narrow screen the card is too small to watch anything in, so
        // the press does what the visitor plainly meant: open the video page.
        if (card != null && window.innerWidth >= INLINE_PLAY_MIN_WIDTH) {
          playInCard(card, video.title);
        } else {
          window.location.href = videoPath(video.id);
        }
        break;

      case 'fullscreen':
        if (card != null) playInCard(card, video.title, true);
        break;

      default:
        break;
    }
  });
}

function setPressed(button: HTMLElement, pressed: boolean): void {
  setAttribute(button, 'aria-pressed', String(pressed));
}

/**
 * The library state a freshly rendered grid needs, so hearts and clocks are
 * already filled in on first paint rather than popping a moment later.
 */
export async function readCardState(): Promise<{
  favorites: ReadonlySet<string>;
  watchLater: ReadonlySet<string>;
  progress: ReadonlyMap<string, number>;
}> {
  const [favorites, watchLater, history] = await Promise.all([
    library.ids('favorites'),
    library.ids('watchLater'),
    library.list('history'),
  ]);

  const progress = new Map<string, number>();
  for (const entry of history) {
    const watched = (entry as { progressSeconds?: number }).progressSeconds ?? 0;
    const total = entry.snapshot?.durationSeconds ?? 0;
    if (total > 0 && watched > 0) progress.set(entry.videoId, Math.min(1, watched / total));
  }

  return { favorites, watchLater, progress };
}

/**
 * Refresh the pressed state of buttons already on screen.
 * Used after the library changes somewhere else, e.g. in the library dialog.
 */
export async function syncCardState(container: ParentNode): Promise<void> {
  const { favorites, watchLater } = await readCardState();

  for (const card of selectAll<HTMLElement>('[data-video-id]', container)) {
    const videoId = card.dataset.videoId;
    if (videoId == null) continue;

    const favorite = card.querySelector('[data-action="favorite"]');
    if (favorite != null) setPressed(favorite as HTMLElement, favorites.has(videoId));

    const later = card.querySelector('[data-action="watch-later"]');
    if (later != null) setPressed(later as HTMLElement, watchLater.has(videoId));
  }
}
