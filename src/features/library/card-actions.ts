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
import { shareUrl, toast, toastSuccess } from '../../ui/components/toast.js';
import { currentSession, signInHref } from '../account/account.js';
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
          if (added) offerSync('נוסף למועדפים');
          else toastSuccess('הוסר מהמועדפים');
        });
        break;

      case 'watch-later':
        void library.toggle('watchLater', video).then((added) => {
          setPressed(button, added);
          if (added) offerSync('נוסף לרשימת הצפייה');
          else toastSuccess('הוסר מרשימת הצפייה');
        });
        break;

      case 'share':
        // Not awaited, and deliberately not behind a dynamic import: see
        // `shareUrl`. The click's user activation is what lets the browser
        // open a share sheet or write to the clipboard, and an `await` before
        // the call spends it.
        void shareUrl(absoluteUrl(videoPath(video.id), window.location.origin), video.title);
        break;

      case 'report':
        void import('../video/report-dialog.js').then(({ openReportDialog }) => {
          openReportDialog(video);
        });
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
 * How long to leave the sign-in offer alone after it has been seen or refused.
 *
 * Saving is the one moment the offer is worth anything — the visitor has just
 * created something they would lose — and also the one moment they are busy
 * doing something else. Once a week is enough to be found and rare enough not
 * to be an obstacle; "already signed in" and "declined" are the same silence.
 */
const SYNC_OFFER_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const SYNC_OFFER_KEY = 'car-tiv:sync-offer';

function offerShownRecently(): boolean {
  try {
    const raw = window.localStorage.getItem(SYNC_OFFER_KEY);
    if (raw == null) return false;
    return Date.now() - Number(raw) < SYNC_OFFER_INTERVAL_MS;
  } catch {
    // Private mode, or storage refused. Treating that as "not shown" would
    // show the offer on every single save.
    return true;
  }
}

function markOfferShown(): void {
  try {
    window.localStorage.setItem(SYNC_OFFER_KEY, String(Date.now()));
  } catch {
    // Nothing to do: the offer simply will not be rate-limited in this browser.
  }
}

/**
 * Confirm a save, and — for a visitor who is not signed in — say where it went
 * and offer to make it follow them.
 *
 * The library has always worked without an account, and still does: the save
 * has already happened by the time this runs, and the offer is an offer. What
 * was missing is that nothing ever *said* the list lives in this browser only,
 * so the first a visitor learned of it was a new phone with an empty library.
 */
function offerSync(message: string): void {
  const session = currentSession();

  // Signed in: it is already syncing, and there is nothing to offer.
  if (session?.user != null) {
    toastSuccess(message);
    return;
  }

  // Sign-in switched off (`FEATURE_ACCOUNTS`, or no OAuth credentials
  // configured) — then local is not one of two options, it is the only one,
  // and saying so would be an offer with nothing behind it.
  if (session != null && !session.signInAvailable) {
    toastSuccess(message);
    return;
  }

  if (offerShownRecently()) {
    toastSuccess(`${message} · נשמר במכשיר הזה`);
    return;
  }

  markOfferShown();
  toast(`${message} · נשמר במכשיר הזה בלבד`, {
    tone: 'success',
    durationMs: 9000,
    action: {
      label: 'התחברות לסנכרון',
      onSelect: () => {
        window.location.href = signInHref(window.location.pathname + window.location.search);
      },
    },
  });
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
