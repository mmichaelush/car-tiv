// @vitest-environment happy-dom

/**
 * The video card is the most-rendered thing in the product — a grid of 24 of
 * them is a normal page. These tests pin the parts that are easy to break and
 * expensive to notice: escaping, the single real link, lazy images, and the
 * pressed state of the save buttons.
 */

import { describe, expect, it } from 'vitest';
import type { VideoSummary, VideoId } from '@shared/types/catalog.js';
import { emptyState, skeletonGrid, videoCard, videoGrid } from '@src/ui/components/video-card.js';
import { html, setHtml } from '@src/ui/dom.js';

const video = (overrides: Partial<VideoSummary> = {}): VideoSummary => ({
  id: 'corolla0001' as VideoId,
  title: 'החלפת שמן בטויוטה קורולה',
  categoryId: 'maintenance',
  categoryName: 'טיפולים',
  channel: { slug: 'auto-il', name: 'Auto IL', imageUrl: 'https://cdn.example/a.jpg' },
  durationSeconds: 522,
  addedAt: '2026-08-20',
  publishedAt: null,
  thumbnailUrl: null,
  isHebrew: true,
  isFeatured: false,
  tags: ['שמן מנוע'],
  ...overrides,
});

function render(markup: ReturnType<typeof videoCard>): HTMLElement {
  const container = document.createElement('div');
  setHtml(container, html`${markup}`);
  return container;
}

describe('videoCard', () => {
  it('links to the video page exactly once', () => {
    const container = render(videoCard(video()));
    const links = [...container.querySelectorAll('a')].filter(
      (link) => link.getAttribute('href') === '/video/corolla0001',
    );
    expect(links).toHaveLength(1);
  });

  it('escapes a hostile title', () => {
    const container = render(videoCard(video({ title: '<img src=x onerror=alert(1)>' })));
    expect(container.querySelector('img[onerror]')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('derives the YouTube thumbnail and loads it lazily', () => {
    const container = render(videoCard(video()));
    const image = container.querySelector('.video-card__media img');
    expect(image?.getAttribute('src')).toBe('https://i.ytimg.com/vi/corolla0001/hqdefault.jpg');
    expect(image?.getAttribute('loading')).toBe('lazy');
  });

  it('prefers an editor-supplied thumbnail', () => {
    const container = render(videoCard(video({ thumbnailUrl: 'https://cdn.example/custom.jpg' })));
    expect(container.querySelector('.video-card__media img')?.getAttribute('src')).toBe(
      'https://cdn.example/custom.jpg',
    );
  });

  it('shows a formatted duration and hides the badge when it is unknown', () => {
    expect(render(videoCard(video())).querySelector('.video-card__duration')?.textContent).toBe(
      '8:42',
    );
    expect(
      render(videoCard(video({ durationSeconds: 0 }))).querySelector('.video-card__duration'),
    ).toBeNull();
  });

  it('marks a favourite as pressed', () => {
    const container = render(videoCard(video(), { favorites: new Set(['corolla0001']) }));
    expect(container.querySelector('[data-action="favorite"]')?.getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(
      container.querySelector('[data-action="watch-later"]')?.getAttribute('aria-pressed'),
    ).toBe('false');
  });

  it('renders a progress bar only when there is progress', () => {
    expect(render(videoCard(video())).querySelector('.video-card__progress')).toBeNull();

    const withProgress = render(videoCard(video(), { progress: new Map([['corolla0001', 0.42]]) }));
    expect(withProgress.querySelector('.video-card__progress i')?.getAttribute('style')).toContain(
      '42%',
    );
  });

  it('flags non-Hebrew content, so a visitor is not surprised', () => {
    const container = render(videoCard(video({ isHebrew: false })));
    expect(container.textContent).toContain('אנגלית');
  });

  it('opens YouTube in a new tab safely', () => {
    const link = render(videoCard(video())).querySelector('a[target="_blank"]');
    expect(link?.getAttribute('rel')).toContain('noopener');
  });

  it('can be rendered without the action row', () => {
    const container = render(videoCard(video(), { withActions: false }));
    expect(container.querySelector('.video-card__actions')).toBeNull();
  });
});

describe('videoGrid', () => {
  it('renders one card per video', () => {
    const container = document.createElement('div');
    setHtml(container, videoGrid([video(), video({ id: 'other000001' as VideoId })]));
    expect(container.querySelectorAll('.video-card')).toHaveLength(2);
  });
});

describe('skeletonGrid', () => {
  it('is hidden from assistive technology', () => {
    const container = document.createElement('div');
    setHtml(container, skeletonGrid(3));
    expect(container.querySelectorAll('.skeleton')).toHaveLength(3);
    expect(container.querySelector('.skeleton')?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('emptyState', () => {
  it('always offers a way out when an action is given', () => {
    const container = document.createElement('div');
    setHtml(
      container,
      emptyState({ title: 'אין תוצאות', actionLabel: 'ניקוי הסינון', actionName: 'clear-filters' }),
    );
    expect(container.querySelector('[data-action="clear-filters"]')?.textContent?.trim()).toBe(
      'ניקוי הסינון',
    );
  });
});

describe('videoCard playback controls', () => {
  it('offers play-in-place and fullscreen as real buttons, not decoration', () => {
    const container = render(videoCard(video()));

    const play = container.querySelector('[data-action="play-inline"]');
    expect(play?.tagName).toBe('BUTTON');
    expect(play?.getAttribute('aria-label')).toContain(video().title);

    expect(container.querySelector('[data-action="fullscreen"]')?.tagName).toBe('BUTTON');
  });

  it('does not create an iframe until something is pressed', () => {
    expect(render(videoCard(video())).querySelector('iframe')).toBeNull();
  });

  it('drops the playback controls along with the rest of the action row', () => {
    const container = render(videoCard(video(), { withActions: false }));
    expect(container.querySelector('[data-action="fullscreen"]')).toBeNull();
    // "Play here" lives on the thumbnail, not in the action row, so it stays.
    expect(container.querySelector('[data-action="play-inline"]')).not.toBeNull();
  });
});
