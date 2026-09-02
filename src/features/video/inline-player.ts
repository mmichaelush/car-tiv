/**
 * Playing a video inside its card, without leaving the grid.
 *
 * The legacy site did this and people used it: you scan a row of results,
 * press play on one, watch fifteen seconds, and carry on scanning. Losing it
 * would have made the rewrite worse at the thing the site is for.
 *
 * Two rules make it cheap:
 *
 *  - The iframe is created on the press, never before. A grid of 24 cards that
 *    each pre-loaded a YouTube player would pull megabytes and dozens of
 *    requests for a video nobody asked to watch.
 *  - The iframe is torn down as soon as its card scrolls out of view, which
 *    also stops the audio — the same behaviour the old site had, and the reason
 *    a long scroll does not end up with four players running at once.
 *
 * Only one card plays at a time; starting a second one closes the first.
 */

import { asVideoId, embedUrl } from '@shared/core/youtube.js';

/** The card currently playing, so a second press can close it. */
let active: HTMLElement | null = null;

/** Lazily created — one observer serves every card on the page. */
let observer: IntersectionObserver | null = null;

/**
 * Start playback inside `card`.
 *
 * @param card       The `[data-video-id]` element.
 * @param title      Used for the iframe's accessible name.
 * @param fullscreen Request fullscreen once the player exists.
 * @returns `false` when the card has no media area to play in.
 */
export function playInCard(card: HTMLElement, title: string, fullscreen = false): boolean {
  const media = card.querySelector<HTMLElement>('.video-card__media');
  const videoId = card.dataset.videoId;
  if (media == null || videoId == null) return false;

  if (active === card) {
    if (fullscreen) void requestFullscreen(media);
    return true;
  }

  stopInlinePlayback();

  // The thumbnail and the overlay stay in the DOM, hidden, so closing the
  // player restores the card exactly as it was without a re-render.
  media.dataset.playing = 'true';
  const frame = document.createElement('iframe');
  frame.className = 'video-card__frame';
  frame.src = embedUrl(asVideoId(videoId), { autoplay: true });
  frame.title = `נגן וידאו: ${title}`;
  frame.allow =
    'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';
  frame.allowFullscreen = true;
  frame.loading = 'eager';
  media.append(frame);

  active = card;
  watch(card);

  if (fullscreen) void requestFullscreen(media);
  return true;
}

/** Tear down whatever is playing. Safe to call when nothing is. */
export function stopInlinePlayback(): void {
  if (active == null) return;

  const media = active.querySelector<HTMLElement>('.video-card__media');
  if (media != null) {
    delete media.dataset.playing;
    media.querySelector('.video-card__frame')?.remove();
  }

  observer?.unobserve(active);
  active = null;
}

/** Stop playback once the card has left the viewport. */
function watch(card: HTMLElement): void {
  if (typeof IntersectionObserver !== 'function') return;

  observer ??= new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting && entry.target === active) stopInlinePlayback();
      }
    },
    // A little of the card may hang off the edge before we call it gone;
    // stopping the moment one pixel leaves would feel twitchy.
    { threshold: 0.15 },
  );

  observer.observe(card);
}

async function requestFullscreen(element: HTMLElement): Promise<void> {
  if (typeof element.requestFullscreen !== 'function') return;
  try {
    // One frame of delay: the iframe has to exist and be laid out before the
    // browser will hand it the fullscreen surface.
    await new Promise((resolve) => setTimeout(resolve, 120));
    await element.requestFullscreen();
  } catch {
    // Denied (no user gesture chain, or a permissions policy). Playback still
    // works inline, so there is nothing to report.
  }
}
