import { describe, expect, it } from 'vitest';
import {
  buildPageMeta,
  clampLimit,
  clampPage,
  hasNextPage,
  offsetFor,
  paginationWindow,
} from '@shared/core/pagination.js';
import { PAGINATION } from '@shared/constants.js';

describe('clampPage', () => {
  it('coerces anything unusable to page 1', () => {
    expect(clampPage(undefined)).toBe(1);
    expect(clampPage('abc')).toBe(1);
    expect(clampPage(0)).toBe(1);
    expect(clampPage(-5)).toBe(1);
  });

  it('floors fractional pages and caps runaway values', () => {
    expect(clampPage('3.9')).toBe(3);
    expect(clampPage(1e9)).toBe(10_000);
  });
});

describe('clampLimit', () => {
  it('caps at the API maximum', () => {
    expect(clampLimit(1_000)).toBe(PAGINATION.maxLimit);
  });

  it('falls back for unusable values', () => {
    expect(clampLimit('x')).toBe(PAGINATION.defaultLimit);
    expect(clampLimit(0, 10)).toBe(10);
  });
});

describe('offsetFor', () => {
  it('computes the SQL offset', () => {
    expect(offsetFor(1, 24)).toBe(0);
    expect(offsetFor(3, 24)).toBe(48);
  });
});

describe('buildPageMeta', () => {
  it('reports zero pages for an empty result', () => {
    expect(buildPageMeta(1, 24, 0)).toEqual({ page: 1, limit: 24, total: 0, pages: 0 });
  });

  it('rounds the page count up', () => {
    expect(buildPageMeta(1, 24, 25).pages).toBe(2);
  });

  it('knows when another page exists', () => {
    expect(hasNextPage(buildPageMeta(1, 24, 25))).toBe(true);
    expect(hasNextPage(buildPageMeta(2, 24, 25))).toBe(false);
  });
});

describe('paginationWindow', () => {
  it('returns nothing to render for a single page', () => {
    expect(paginationWindow(1, 1)).toEqual([1]);
    expect(paginationWindow(1, 0)).toEqual([]);
  });

  it('lists every page when they all fit', () => {
    expect(paginationWindow(2, 4)).toEqual([1, 2, 3, 4]);
  });

  it('inserts an ellipsis marker on both sides of a wide range', () => {
    expect(paginationWindow(7, 20)).toEqual([1, null, 6, 7, 8, null, 20]);
  });

  it('does not insert an ellipsis for a single missing page', () => {
    expect(paginationWindow(3, 5)).toEqual([1, 2, 3, 4, 5]);
  });
});
