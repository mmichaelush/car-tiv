import { describe, expect, it } from 'vitest';
import {
  EMPTY_QUERY,
  countActiveFilters,
  isEmptyQuery,
  parseQuery,
  serializeQuery,
} from '@shared/core/query.js';
import { PAGINATION } from '@shared/constants.js';

const params = (search: string): URLSearchParams => new URLSearchParams(search);

describe('parseQuery', () => {
  it('returns the defaults for an empty query string', () => {
    expect(parseQuery(params(''))).toEqual(EMPTY_QUERY);
  });

  it('reads every supported filter', () => {
    const query = parseQuery(
      params('q=corolla&category=maintenance&tags=שמן,מנוע&hebrew=1&sort=duration-asc&page=3'),
    );
    expect(query.q).toBe('corolla');
    expect(query.category).toBe('maintenance');
    expect(query.tags).toEqual(['שמן', 'מנוע']);
    expect(query.hebrewOnly).toBe(true);
    expect(query.sort).toBe('duration-asc');
    expect(query.page).toBe(3);
  });

  it('de-duplicates tags', () => {
    expect(parseQuery(params('tags=a,b,a,,b')).tags).toEqual(['a', 'b']);
  });

  it('clamps a hostile limit to the maximum the API will serve', () => {
    expect(parseQuery(params('limit=100000')).limit).toBe(PAGINATION.maxLimit);
    expect(parseQuery(params('limit=-4')).limit).toBe(PAGINATION.defaultLimit);
  });

  it('falls back to the default sort for an unknown value', () => {
    expect(parseQuery(params('sort=whatever')).sort).toBe(EMPTY_QUERY.sort);
  });

  it('never throws on a hand-edited url', () => {
    expect(() => parseQuery(params('page=abc&year=xyz&minDuration=%%%'))).not.toThrow();
    expect(parseQuery(params('page=abc')).page).toBe(1);
  });
});

describe('serializeQuery', () => {
  it('writes nothing for a default query', () => {
    expect(serializeQuery(EMPTY_QUERY).toString()).toBe('');
  });

  it('omits defaults but keeps everything else', () => {
    const search = serializeQuery({
      ...EMPTY_QUERY,
      q: 'corolla',
      category: 'maintenance',
      hebrewOnly: true,
      page: 1,
    });
    expect(search.get('q')).toBe('corolla');
    expect(search.get('category')).toBe('maintenance');
    expect(search.get('hebrew')).toBe('1');
    expect(search.has('page')).toBe(false);
    expect(search.has('sort')).toBe(false);
  });

  it('round-trips through parseQuery', () => {
    const original = {
      ...EMPTY_QUERY,
      q: 'שמן מנוע',
      category: 'maintenance',
      tags: ['טויוטה', 'קורולה'],
      hebrewOnly: true,
      sort: 'duration-desc' as const,
      page: 4,
    };
    expect(parseQuery(serializeQuery(original))).toEqual(original);
  });
});

describe('countActiveFilters', () => {
  it('does not count the free-text query or the page number', () => {
    expect(countActiveFilters({ ...EMPTY_QUERY, q: 'corolla', page: 5 })).toBe(0);
  });

  it('counts each tag separately', () => {
    expect(countActiveFilters({ ...EMPTY_QUERY, tags: ['a', 'b'], hebrewOnly: true })).toBe(3);
  });
});

describe('isEmptyQuery', () => {
  it('is true only for an untouched query', () => {
    expect(isEmptyQuery(EMPTY_QUERY)).toBe(true);
    expect(isEmptyQuery({ ...EMPTY_QUERY, q: 'x' })).toBe(false);
    expect(isEmptyQuery({ ...EMPTY_QUERY, category: 'diy' })).toBe(false);
  });
});
