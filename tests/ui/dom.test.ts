// @vitest-environment happy-dom

/**
 * The escaping guarantee.
 *
 * Every string that reaches the DOM in this product goes through the `html`
 * tagged template. If these tests pass, a catalog title, a tag or a visitor's
 * message cannot execute script — which is exactly the class of bug the old
 * site's bare `innerHTML` calls left open.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  countLabel,
  debounce,
  escape,
  html,
  mailtoUrl,
  raw,
  select,
  selectAll,
  setHtml,
} from '@src/ui/dom.js';

describe('html', () => {
  it('escapes an interpolated value', () => {
    const title = '<img src=x onerror="alert(1)">';
    expect(html`<h3>${title}</h3>`.value).toBe(
      '<h3>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</h3>',
    );
  });

  it('escapes a value used inside an attribute', () => {
    const value = '" onmouseover="alert(1)';
    const markup = html`<a title="${value}">x</a>`.value;
    expect(markup).not.toContain('onmouseover="alert');
    expect(markup).toContain('&quot;');
  });

  it('does not create a script element from catalog text', () => {
    const container = document.createElement('div');
    setHtml(container, html`<p>${'<script>window.__hacked = true;</' + 'script>'}</p>`);
    document.body.append(container);

    expect(container.querySelector('script')).toBeNull();
    expect((window as unknown as { __hacked?: boolean }).__hacked).toBeUndefined();
  });

  it('joins arrays without separators', () => {
    // Asserted with `toContain` rather than `toBe`: Prettier reformats the
    // markup inside an `html` template, so the surrounding whitespace is the
    // formatter's business, not this test's. What matters is that the array
    // items end up adjacent — a stray comma between them is the classic bug.
    const items = ['a', 'b'].map((value) => html`<li>${value}</li>`);
    expect(
      html`<ul>
        ${items}
      </ul>`.value,
    ).toContain('<li>a</li><li>b</li>');
  });

  it('renders null, undefined and false as nothing', () => {
    expect(html`[${null}${undefined}${false}]`.value).toBe('[]');
  });

  it('nests without double-escaping already-safe markup', () => {
    const inner = html`<b>${'<x>'}</b>`;
    expect(html`<p>${inner}</p>`.value).toBe('<p><b>&lt;x&gt;</b></p>');
  });

  it('lets raw() through, because that is an explicit decision', () => {
    expect(html`${raw('<svg></svg>')}`.value).toBe('<svg></svg>');
  });
});

describe('escape', () => {
  it('escapes the five characters that matter, ampersand first', () => {
    expect(escape(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });
});

describe('select', () => {
  it('throws with the selector in the message when an element is missing', () => {
    expect(() => select('[data-nope]')).toThrow(/data-nope/);
  });

  it('finds elements within a scope', () => {
    const root = document.createElement('div');
    setHtml(root, html`<span class="x"></span><span class="x"></span>`);
    expect(selectAll('.x', root)).toHaveLength(2);
  });
});

describe('debounce', () => {
  it('runs once after the quiet period, with the last arguments', () => {
    vi.useFakeTimers();
    const spy = vi.fn();
    const debounced = debounce(spy, 100);

    debounced('a');
    debounced('b');
    debounced('c');
    expect(spy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100);
    expect(spy).toHaveBeenCalledExactlyOnceWith('c');
    vi.useRealTimers();
  });

  it('can be cancelled', () => {
    vi.useFakeTimers();
    const spy = vi.fn();
    const debounced = debounce(spy, 100);

    debounced('a');
    debounced.cancel();
    vi.advanceTimersByTime(500);

    expect(spy).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});

describe('mailtoUrl', () => {
  it('returns a bare address when there is nothing to pre-fill', () => {
    expect(mailtoUrl('a@b.com')).toBe('mailto:a@b.com');
    expect(mailtoUrl('a@b.com', { subject: '', body: '' })).toBe('mailto:a@b.com');
  });

  it('encodes a space as %20, not as +', () => {
    const url = mailtoUrl('a@b.com', { subject: 'שלום לך' });
    expect(url).toContain('%20');
    expect(url).not.toContain('+');
  });

  it('carries both parts when both are given', () => {
    const url = mailtoUrl('a@b.com', { subject: 's', body: 'b' });
    expect(url).toBe('mailto:a@b.com?subject=s&body=b');
  });
});

describe('countLabel', () => {
  // `${n} סרטונים` reads as "1 videos" in Hebrew, and it appeared on channel
  // cards, channel pages, playlists and the results bar. Hebrew also puts the
  // noun before the numeral in the singular, so the fix is not a plural `s`.
  it('says "סרטון אחד" rather than "1 סרטונים"', () => {
    expect(countLabel(1, 'סרטון', 'סרטונים')).toBe('סרטון אחד');
  });

  it('takes the plural for zero, which is correct in Hebrew', () => {
    expect(countLabel(0, 'סרטון', 'סרטונים')).toBe('0 סרטונים');
  });

  it('groups digits for a large count', () => {
    expect(countLabel(7876, 'סרטון', 'סרטונים')).toBe('7,876 סרטונים');
  });

  it('works for any noun pair', () => {
    expect(countLabel(1, 'ערוץ', 'ערוצים')).toBe('ערוץ אחד');
    expect(countLabel(79, 'ערוץ', 'ערוצים')).toBe('79 ערוצים');
  });
});
