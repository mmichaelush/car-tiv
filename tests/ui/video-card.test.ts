// @vitest-environment happy-dom

/**
 * The video card is the most-rendered thing in the product — a grid of 24 of
 * them is a normal page. These tests pin the parts that are easy to break and
 * expensive to notice: escaping, the single real link, lazy images, and the
 * pressed state of the save buttons.
 */

import { describe, expect, it } from 'vitest';
import type { VideoSummary, VideoId } from '@shared/types/catalog.js';
import {
  emptyState,
  errorState,
  skeletonGrid,
  videoCard,
  videoGrid,
} from '@src/ui/components/video-card.js';
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
  excerpt: '',
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

  it('does not label non-Hebrew content on the card', () => {
    // "אנגלית" is a filter concept, not a property of a card. Every card in a
    // catalog that is mostly Hebrew either carried the badge or did not, which
    // made it noise rather than information; the Hebrew-only switch in the
    // filter panel is where that distinction is actually useful.
    const container = render(videoCard(video({ isHebrew: false })));
    expect(container.textContent).not.toContain('אנגלית');
  });

  it('renders the tags the API already sends', () => {
    // `VideoSummary.tags` is documented as "a short slice of the video's tags,
    // for the card footer" and the card never rendered it — so the API sent
    // them on every request and the card threw them away.
    const container = render(videoCard(video({ tags: ['שמן מנוע', 'טיפול'] })));
    const tags = [...container.querySelectorAll('.video-card__tags a')];

    expect(tags.map((tag) => tag.textContent?.trim())).toEqual(['שמן מנוע', 'טיפול']);
  });

  it('links each tag into the filtered listing', () => {
    const link = render(videoCard(video({ tags: ['שמן מנוע'] }))).querySelector(
      '.video-card__tags a',
    );
    expect(link?.getAttribute('href')).toBe('/search?tags=שמן-מנוע');
  });

  it('shows at most three tags, because a card is a glance', () => {
    const many = ['אחד', 'שתיים', 'שלוש', 'ארבע', 'חמש'];
    const container = render(videoCard(video({ tags: many })));
    expect(container.querySelectorAll('.video-card__tags a')).toHaveLength(3);
  });

  it('renders no tag list at all when there are none', () => {
    const container = render(videoCard(video({ tags: [] })));
    expect(container.querySelector('.video-card__tags')).toBeNull();
  });

  it('shows a description only when one is passed', () => {
    // The listing endpoint does not send descriptions — it would carry 7,876 of
    // them — so the list view passes it explicitly and the grid does not.
    expect(render(videoCard(video())).querySelector('.video-card__description')).toBeNull();

    const withText = render(videoCard(video(), { description: 'מדריך מלא להחלפת שמן' }));
    expect(withText.querySelector('.video-card__description')?.textContent).toContain('מדריך מלא');
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

describe('empty and error states', () => {
  it('shows the site’s own subject rather than a magnifying glass', () => {
    // The most-seen state on a catalog site was the most generic thing on it.
    const container = render(emptyState({ title: 'לא נמצאו סרטונים' }));

    expect(container.querySelector('.empty-state__art svg')).not.toBeNull();
    expect(container.querySelector('.empty-state__icon')).toBeNull();
  });

  it('still uses a small glyph when the caller asks for one', () => {
    const container = render(emptyState({ title: 'ריק', iconName: 'heart' }));

    expect(container.querySelector('.empty-state__icon svg')).not.toBeNull();
    expect(container.querySelector('.empty-state__art')).toBeNull();
  });

  it('draws illustrations from theme tokens, so they work in every theme', () => {
    // A hex value here would be a colour that survives a theme change, which on
    // twenty themes in two modes is twenty-nine ways to look wrong.
    const markup = render(emptyState({ title: 'ריק' })).innerHTML;

    expect(markup).toContain('var(--');
    expect(markup).not.toMatch(/#[0-9a-f]{3,6}\b/i);
  });

  it('hides the illustration from assistive technology', () => {
    // The heading beside it already says what the state is.
    const svg = render(emptyState({ title: 'ריק' })).querySelector('.empty-state__art svg');
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
  });

  it('gives the error state its own picture and a retry', () => {
    const container = render(errorState());
    expect(container.querySelector('.empty-state__art svg')).not.toBeNull();
    expect(container.querySelector('[data-action="retry"]')).not.toBeNull();
  });
});
