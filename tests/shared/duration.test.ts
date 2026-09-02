import { describe, expect, it } from 'vitest';
import {
  bucketToRange,
  describeDuration,
  formatDuration,
  parseDuration,
} from '@shared/core/duration.js';

describe('parseDuration', () => {
  it('parses the "m:ss" form used by the legacy catalog', () => {
    expect(parseDuration('8:42')).toBe(522);
    expect(parseDuration('0:07')).toBe(7);
  });

  it('parses the "h:mm:ss" form', () => {
    expect(parseDuration('1:02:15')).toBe(3_735);
  });

  it('parses the ISO-8601 period returned by the YouTube API', () => {
    expect(parseDuration('PT8M42S')).toBe(522);
    expect(parseDuration('PT1H2M15S')).toBe(3_735);
    expect(parseDuration('PT45S')).toBe(45);
  });

  it('passes through a number of seconds', () => {
    expect(parseDuration(522)).toBe(522);
    expect(parseDuration('522')).toBe(522);
  });

  it('returns 0 rather than throwing for unusable input', () => {
    expect(parseDuration(null)).toBe(0);
    expect(parseDuration(undefined)).toBe(0);
    expect(parseDuration('')).toBe(0);
    expect(parseDuration('LIVE')).toBe(0);
    expect(parseDuration('1:2:3:4')).toBe(0);
    expect(parseDuration('a:bb')).toBe(0);
  });
});

describe('formatDuration', () => {
  it('formats minutes and seconds with a zero-padded seconds field', () => {
    expect(formatDuration(522)).toBe('8:42');
    expect(formatDuration(7)).toBe('0:07');
  });

  it('adds an hours field only when needed', () => {
    expect(formatDuration(3_735)).toBe('1:02:15');
    expect(formatDuration(3_600)).toBe('1:00:00');
  });

  it('returns an empty string for an unknown duration so the badge can be hidden', () => {
    expect(formatDuration(0)).toBe('');
    expect(formatDuration(Number.NaN)).toBe('');
  });

  it('round-trips with parseDuration', () => {
    for (const value of ['0:30', '8:42', '1:02:15']) {
      expect(formatDuration(parseDuration(value))).toBe(value);
    }
  });
});

describe('describeDuration', () => {
  it('produces a Hebrew label for screen readers', () => {
    expect(describeDuration(522)).toBe('9 דקות');
    expect(describeDuration(3_735)).toBe('1 שעות ו־2 דקות');
    expect(describeDuration(0)).toBe('משך לא ידוע');
  });
});

describe('bucketToRange', () => {
  it('maps a filter bucket to a numeric range', () => {
    expect(bucketToRange('short')).toEqual({ min: 0, max: 300 });
    expect(bucketToRange('long')).toEqual({ min: 1_200, max: null });
  });
});
