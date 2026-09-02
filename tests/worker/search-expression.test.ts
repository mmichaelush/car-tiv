/**
 * The FTS5 query language is a real language, and visitor input is not written
 * in it. These tests pin the guarantee that nothing typed into the search box
 * reaches SQLite as an operator.
 */

import { describe, expect, it } from 'vitest';
import {
  buildMatchExpression,
  buildMatchExpressionWithSynonyms,
} from '@worker/repositories/search-expression.js';

describe('buildMatchExpression', () => {
  it('quotes each token and joins them with AND', () => {
    expect(buildMatchExpression('toyota corolla', { prefixLastToken: false })).toBe(
      '"toyota" AND "corolla"',
    );
  });

  it('prefix-matches the last token, for as-you-type search', () => {
    expect(buildMatchExpression('שמן מנו')).toBe('"שמנ" AND "מנו"*');
  });

  it('normalises Hebrew before quoting, so the index and the query agree', () => {
    expect(buildMatchExpression('טוֹיוֹטָה', { prefixLastToken: false })).toBe('"טויוטה"');
  });

  it('returns null when there is nothing to search for', () => {
    expect(buildMatchExpression('')).toBeNull();
    expect(buildMatchExpression('   ')).toBeNull();
    expect(buildMatchExpression('a')).toBeNull();
  });

  it.each([
    // A bare quote leaves no searchable token at all.
    ['"', null],
    // `NEAR(` becomes a word; the single letters are dropped as noise.
    ['NEAR(a b)', '"near"*'],
    // `OR` is not an operator here — it is searched for as a word.
    ['שמן OR מנוע', '"שמנ" AND "or" AND "מנוע"*'],
    // A leading `-` (FTS negation) is stripped with the rest of the punctuation.
    ['-שמן', '"שמנ"*'],
    // A trailing `*` is removed; the prefix match is ours to add, not theirs.
    ['שמן*', '"שמנ"*'],
    // A quote inside a word is removed rather than splitting it — the same
    // rule that makes ג'יפ and ג׳יפ the same word.
    ['שמן"מנוע', '"שמנמנוע"*'],
    ['a AND b AND c', '"and" AND "and"*'],
  ])('neutralises the operator in %j', (input, expected) => {
    expect(buildMatchExpression(input)).toBe(expected);
  });

  it('never emits an unbalanced quote', () => {
    for (const hostile of ['"', '""', 'a"b', '"""']) {
      const expression = buildMatchExpression(hostile);
      if (expression == null) continue;
      const quotes = (expression.match(/"/g) ?? []).length;
      expect(quotes % 2).toBe(0);
    }
  });

  it('caps the number of tokens, so a pasted paragraph cannot become a huge query', () => {
    const long = Array.from({ length: 60 }, (_unused, index) => `word${String(index)}`).join(' ');
    const expression = buildMatchExpression(long) ?? '';
    expect(expression.split(' AND ')).toHaveLength(12);
  });
});

describe('buildMatchExpressionWithSynonyms', () => {
  const synonyms = new Map([
    ['מזגנ', ['מיזוג']],
    ['גיר', ['תיבת הילוכימ']],
  ]);

  it('widens a token into an OR group', () => {
    expect(buildMatchExpressionWithSynonyms('מזגן', synonyms, { prefixLastToken: false })).toBe(
      '("מזגנ" OR "מיזוג")',
    );
  });

  it('leaves tokens without synonyms alone', () => {
    expect(buildMatchExpressionWithSynonyms('שמן', synonyms, { prefixLastToken: false })).toBe(
      '"שמנ"',
    );
  });

  it('combines widened and plain tokens with AND', () => {
    const expression = buildMatchExpressionWithSynonyms('מזגן רכב', synonyms, {
      prefixLastToken: false,
    });
    expect(expression).toBe('("מזגנ" OR "מיזוג") AND "רכב"');
  });

  it('does not prefix-match inside a synonym group', () => {
    const expression = buildMatchExpressionWithSynonyms('מזגן', synonyms) ?? '';
    expect(expression).not.toContain('*');
  });
});
