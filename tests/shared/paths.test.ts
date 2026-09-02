/**
 * Legacy URLs.
 *
 * The old site put everything in the home page's query string: `?name=` for a
 * category, `?v=` for a video, `?search=`, `?tags=`, `?hebrew=true`, `?sort=`.
 * Those URLs are in people's bookmarks, in forum posts and in Google's index,
 * and a 404 for any of them is a visitor lost. Every shape the old
 * `handleRouting`/`updateURLWithFilters` pair could produce is pinned here.
 */

import { describe, expect, it } from 'vitest';
import {
  absoluteUrl,
  categoryPath,
  channelPath,
  legacyRedirect,
  searchPath,
  videoPath,
} from '@shared/core/paths.js';

const redirect = (url: string): string | null => {
  const parsed = new URL(url, 'https://car-tiv.example');
  return legacyRedirect(parsed.pathname, parsed.searchParams);
};

describe('legacyRedirect — pages', () => {
  it('maps the old .html files', () => {
    expect(redirect('/privacy.html')).toBe('/privacy/');
    expect(redirect('/terms.html')).toBe('/terms/');
    expect(redirect('/add-video.html')).toBe('/add-video/');
  });

  it('maps a video link in both spellings', () => {
    expect(redirect('/?v=corolla0001')).toBe('/video/corolla0001');
    expect(redirect('/?video=corolla0001')).toBe('/video/corolla0001');
    expect(redirect('/index.html?v=corolla0001')).toBe('/video/corolla0001');
  });

  it('maps the channels view in both spellings', () => {
    expect(redirect('/?page=channels')).toBe('/channels/');
    expect(redirect('/?view=channels')).toBe('/channels/');
  });

  it('leaves a URL that is already in the new shape alone', () => {
    expect(redirect('/')).toBeNull();
    expect(redirect('/search?q=%D7%A9%D7%9E%D7%9F')).toBeNull();
    expect(redirect('/category/maintenance')).toBeNull();
  });
});

describe('legacyRedirect — filters', () => {
  it('maps ?name=, which is what every old category link used', () => {
    expect(redirect('/?name=maintenance')).toBe('/category/maintenance');
    expect(redirect('/?category=maintenance')).toBe('/category/maintenance');
  });

  it('treats ?name=all as the home page, not a category', () => {
    expect(redirect('/?name=all')).toBeNull();
  });

  it('carries the filters over to the category page', () => {
    const target = redirect('/?name=maintenance&tags=שמן&hebrew=true&sort=title-asc');
    expect(target).not.toBeNull();

    const url = new URL(target ?? '', 'https://car-tiv.example');
    expect(url.pathname).toBe('/category/maintenance');
    expect(url.searchParams.get('tags')).toBe('שמן');
    // The old site spelled it `true`; the new one spells it `1`.
    expect(url.searchParams.get('hebrew')).toBe('1');
    expect(url.searchParams.get('sort')).toBe('title-asc');
  });

  it('sends a bare search to the search page', () => {
    const url = new URL(redirect('/?search=בלמים') ?? '', 'https://car-tiv.example');
    expect(url.pathname).toBe('/search');
    expect(url.searchParams.get('q')).toBe('בלמים');
  });

  it('sends bare tags to the search page', () => {
    const url = new URL(redirect('/?tags=שמן,מנוע') ?? '', 'https://car-tiv.example');
    expect(url.pathname).toBe('/search');
    expect(url.searchParams.get('tags')).toBe('שמן,מנוע');
  });

  it('drops the default sort rather than pinning it into the URL', () => {
    expect(redirect('/?sort=date-desc')).toBeNull();
  });

  it('drops a parameter it does not recognise', () => {
    const url = new URL(redirect('/?search=בלמים&utm_source=forum') ?? '', 'https://x.example');
    expect(url.searchParams.has('utm_source')).toBe(false);
  });

  it('prefers the video link over any filter on the same URL', () => {
    expect(redirect('/?v=corolla0001&name=maintenance')).toBe('/video/corolla0001');
  });
});

describe('path builders', () => {
  it('encodes values that need it', () => {
    expect(videoPath('corolla0001')).toBe('/video/corolla0001');
    expect(categoryPath('שטח')).toBe(`/category/${encodeURIComponent('שטח')}`);
    expect(channelPath('auto il')).toBe('/channel/auto%20il');
  });

  it('returns the bare search page for an empty query', () => {
    expect(searchPath('   ')).toBe('/search');
  });

  it('builds an absolute URL from a path and an origin', () => {
    expect(absoluteUrl('/video/corolla0001', 'https://car-tiv.example')).toBe(
      'https://car-tiv.example/video/corolla0001',
    );
  });
});
