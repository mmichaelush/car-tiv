import { describe, expect, it } from 'vitest';
import {
  containsHebrew,
  escapeHtml,
  indexText,
  normalizeText,
  slugify,
  slugifyWithFallback,
  tokenize,
  truncate,
} from '@shared/core/text.js';

describe('normalizeText', () => {
  it('strips Hebrew niqqud', () => {
    expect(normalizeText('טוֹיוֹטָה')).toBe('טויוטה');
  });

  it('lowercases Latin text and folds accents', () => {
    expect(normalizeText('TOYOTA Corollá')).toBe('toyota corolla');
  });

  it('treats geresh, gershayim and apostrophes as nothing', () => {
    expect(normalizeText("ג'יפ")).toBe('גיפ');
    expect(normalizeText('ג׳יפ')).toBe('גיפ');
  });

  it('turns maqaf and hyphens into a single space', () => {
    expect(normalizeText('פאר־צלר')).toBe('פאר צלר');
    expect(normalizeText('4x4  -  שטח')).toBe('4x4 שטח');
  });

  it('drops zero-width and bidi characters', () => {
    expect(normalizeText('רכ​ב‫')).toBe('רכב');
  });

  it('is idempotent', () => {
    const once = normalizeText('טוֹיוֹטָה   קוֹרוֹלָה!');
    expect(normalizeText(once)).toBe(once);
  });
});

describe('indexText', () => {
  it('folds final letters so word endings match', () => {
    expect(indexText('רכבים')).toBe(indexText('רכביםם'.slice(0, -1)));
    expect(indexText('ארץ')).toBe('ארצ');
    expect(indexText('מנוע חשמלי')).toBe('מנוע חשמלי');
  });

  it('makes the three spellings of a manufacturer comparable', () => {
    expect(indexText('Toyota Corolla')).toBe(indexText('TOYOTA COROLLA'));
  });
});

describe('tokenize', () => {
  it('splits on whitespace and drops single characters', () => {
    expect(tokenize('החלפת שמן מנוע ב 2012')).toEqual(['החלפת', 'שמנ', 'מנוע', '2012']);
  });

  it('returns an empty array for empty input', () => {
    expect(tokenize('   ')).toEqual([]);
  });
});

describe('slugify', () => {
  it('builds a readable slug from a mixed-language channel name', () => {
    expect(slugify('World Driving | נהיגה עולמית')).toBe('world-driving-נהיגה-עולמית');
  });

  it('never leaves leading or trailing dashes', () => {
    expect(slugify('  ***  אוטו  ***  ')).toBe('אוטו');
  });

  it('falls back when the name has no usable characters', () => {
    expect(slugifyWithFallback('***', 'channel-7')).toBe('channel-7');
  });
});

describe('escapeHtml', () => {
  it('neutralises a script injection attempt', () => {
    expect(escapeHtml('<img src=x onerror="alert(1)">')).toBe(
      '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;',
    );
  });

  it('escapes ampersands first so entities are not double-broken', () => {
    expect(escapeHtml('Tom & Jerry <b>')).toBe('Tom &amp; Jerry &lt;b&gt;');
  });
});

describe('truncate', () => {
  it('leaves short text untouched', () => {
    expect(truncate('שלום', 10)).toBe('שלום');
  });

  it('breaks on a word boundary and adds an ellipsis', () => {
    expect(truncate('אחד שניים שלושה ארבעה חמישה', 18)).toBe('אחד שניים שלושה…');
  });
});

describe('containsHebrew', () => {
  it('detects Hebrew letters', () => {
    expect(containsHebrew('Toyota קורולה')).toBe(true);
    expect(containsHebrew('Toyota Corolla')).toBe(false);
  });
});
