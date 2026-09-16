import { it, expect } from 'vitest';
import { consumeCatalogBudget, invalidCatalogQuery } from '@worker/middleware/catalog-budget.js';

it('bounds misses without a database write and resets after the window', () => {
  for (let n = 0; n < 60; n++) expect(consumeCatalogBudget('test-caller', 0)).toBe(true);
  expect(consumeCatalogBudget('test-caller', 0)).toBe(false);
  expect(consumeCatalogBudget('different-caller', 0)).toBe(true);
  expect(consumeCatalogBudget('test-caller', 60_000)).toBe(true);
});

it('rejects contradictory duration bounds and excessive offsets', () => {
  expect(
    invalidCatalogQuery(new URL('https://test/api/videos?minDuration=100&maxDuration=1'))?.status,
  ).toBe(400);
  expect(invalidCatalogQuery(new URL('https://test/api/videos?page=10000'))?.status).toBe(400);
  expect(invalidCatalogQuery(new URL('https://test/api/videos?page=527'))).toBeNull();
});
