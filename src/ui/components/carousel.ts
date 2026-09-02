/**
 * A horizontal scroller with previous/next buttons.
 *
 * Used for the featured-channels rail on the home page, which the legacy site
 * rendered as an auto-scrolling marquee. The marquee is gone on purpose — it
 * moved content out from under the pointer and could not be paused by keyboard
 * — but the affordance it provided is kept: the rail scrolls, it snaps, and
 * the two buttons page through it.
 *
 * Everything here is direction-agnostic. In RTL the "next" button must scroll
 * towards negative `scrollLeft`, so the direction is read from the computed
 * style rather than assumed, and every position test uses `Math.abs`.
 */

import { on, setHtml, toggleClass } from '../dom.js';
import { icon } from '../icons.js';

export interface CarouselOptions {
  /** The element wrapping the viewport and the two buttons. */
  readonly root: HTMLElement;
  /**
   * How far one press moves the rail, as a fraction of the visible width.
   * Slightly under a full page so a card stays on screen as an anchor.
   */
  readonly step?: number;
}

/**
 * Wire a carousel. Safe to call again after the rail's contents change — call
 * the returned `refresh()` instead of re-mounting.
 */
export function mountCarousel(options: CarouselOptions): { refresh: () => void } {
  const { root } = options;
  const viewport = root.querySelector<HTMLElement>('[data-carousel-viewport]');
  const previous = root.querySelector<HTMLButtonElement>('[data-carousel-prev]');
  const next = root.querySelector<HTMLButtonElement>('[data-carousel-next]');

  if (viewport == null || previous == null || next == null) return { refresh: () => undefined };

  const isRtl = getComputedStyle(viewport).direction === 'rtl';
  const step = options.step ?? 0.85;

  // The buttons ship empty from the HTML so the markup stays readable; the
  // glyphs are logical (`chevronStart`/`chevronEnd`), not left/right.
  if (previous.childElementCount === 0) setHtml(previous, icon('chevronStart', { size: 20 }));
  if (next.childElementCount === 0) setHtml(next, icon('chevronEnd', { size: 20 }));

  const distance = (): number => {
    const amount = viewport.clientWidth * step;
    return isRtl ? -amount : amount;
  };

  const refresh = (): void => {
    // `scrollWidth - clientWidth` can be a fraction of a pixel off after a
    // zoom or a font swap, so both ends get a 2px tolerance.
    const maximum = viewport.scrollWidth - viewport.clientWidth;
    const position = Math.abs(viewport.scrollLeft);
    const scrollable = maximum > 4;

    previous.hidden = !scrollable;
    next.hidden = !scrollable;
    toggleClass(root, 'is-scrollable', scrollable);
    if (!scrollable) return;

    previous.disabled = position <= 2;
    next.disabled = position >= maximum - 2;
  };

  on(previous, 'click', () => {
    viewport.scrollBy({ left: -distance(), behavior: 'smooth' });
  });
  on(next, 'click', () => {
    viewport.scrollBy({ left: distance(), behavior: 'smooth' });
  });

  // A passive scroll listener behind a rAF guard: this fires on every wheel
  // tick and must never be the reason a scroll janks.
  let scheduled = false;
  on(
    viewport,
    'scroll',
    () => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        refresh();
        scheduled = false;
      });
    },
    { passive: true },
  );

  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => {
      refresh();
    }).observe(viewport);
  }

  refresh();
  return { refresh };
}
