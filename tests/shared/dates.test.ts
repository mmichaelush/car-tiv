import { describe, expect, it } from 'vitest';
import {
  formatHebrewDate,
  formatRelativeDate,
  isoDaysAgo,
  parseCatalogDate,
} from '@shared/core/dates.js';

describe('parseCatalogDate', () => {
  it('reads the legacy DD/MM/YYYY form as day-first, not month-first', () => {
    // 17/09/2024 is 17 September. Read as US format it would be an invalid month.
    expect(parseCatalogDate('17/09/2024')).toBe('2024-09-17');
    // The ambiguous case is the one that matters: 03/04 must be 3 April.
    expect(parseCatalogDate('03/04/2024')).toBe('2024-04-03');
  });

  it('accepts dots and dashes as separators', () => {
    expect(parseCatalogDate('17.09.2024')).toBe('2024-09-17');
    expect(parseCatalogDate('17-09-2024')).toBe('2024-09-17');
  });

  it('passes ISO dates through', () => {
    expect(parseCatalogDate('2024-09-17')).toBe('2024-09-17');
    expect(parseCatalogDate('2024-09-17T10:11:12Z')).toBe('2024-09-17');
  });

  it('rejects impossible calendar dates instead of rolling them over', () => {
    expect(parseCatalogDate('31/02/2024')).toBeNull();
    expect(parseCatalogDate('00/01/2024')).toBeNull();
  });

  it('returns null for missing or unparseable input', () => {
    expect(parseCatalogDate(null)).toBeNull();
    expect(parseCatalogDate('')).toBeNull();
    expect(parseCatalogDate('לא ידוע')).toBeNull();
  });
});

describe('formatHebrewDate', () => {
  it('formats an ISO date in Hebrew', () => {
    expect(formatHebrewDate('2024-09-17')).toContain('2024');
    expect(formatHebrewDate('2024-09-17')).toContain('17');
  });

  it('returns an empty string for a bad value', () => {
    expect(formatHebrewDate('nonsense')).toBe('');
    expect(formatHebrewDate(null)).toBe('');
  });
});

describe('formatRelativeDate', () => {
  const now = new Date('2026-09-01T12:00:00Z');

  it('labels today and yesterday', () => {
    expect(formatRelativeDate('2026-09-01T08:00:00Z', now)).toBe('היום');
    expect(formatRelativeDate('2026-08-31T08:00:00Z', now)).toBe('אתמול');
  });

  it('counts days, weeks and months', () => {
    expect(formatRelativeDate('2026-08-28T12:00:00Z', now)).toBe('לפני 4 ימים');
    expect(formatRelativeDate('2026-08-10T12:00:00Z', now)).toBe('לפני 3 שבועות');
    expect(formatRelativeDate('2026-05-01T12:00:00Z', now)).toBe('לפני 4 חודשים');
  });

  it('falls back to an absolute date beyond a year', () => {
    expect(formatRelativeDate('2020-01-01T12:00:00Z', now)).toContain('2020');
  });
});

describe('isoDaysAgo', () => {
  it('subtracts whole days', () => {
    expect(isoDaysAgo(7, new Date('2026-09-08T00:00:00Z'))).toBe('2026-09-01T00:00:00.000Z');
  });
});
