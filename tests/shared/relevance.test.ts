import { describe, expect, it } from 'vitest';
import {
  RELATED_WEIGHTS,
  type RelatableVideo,
  rankRelated,
  scoreRelated,
} from '@shared/core/relevance.js';

const now = new Date('2026-09-01T00:00:00Z');

const video = (overrides: Partial<RelatableVideo> & { id: string }): RelatableVideo => ({
  categoryId: 'maintenance',
  channelSlug: 'auto-il',
  tags: [],
  manufacturers: [],
  models: [],
  addedAt: '2020-01-01',
  ...overrides,
});

describe('scoreRelated', () => {
  const source = video({
    id: 'source00001',
    categoryId: 'maintenance',
    channelSlug: 'auto-il',
    tags: ['שמן', 'מנוע'],
    manufacturers: ['toyota'],
    models: ['corolla'],
  });

  it('never relates a video to itself', () => {
    expect(scoreRelated(source, source, now)).toBe(0);
  });

  it('scores an unrelated video as zero', () => {
    const other = video({ id: 'other000001', categoryId: 'offroad', channelSlug: 'x', tags: [] });
    expect(scoreRelated(source, other, now)).toBe(0);
  });

  it('weights the same model above the same manufacturer', () => {
    const sameModel = video({
      id: 'a0000000001',
      categoryId: 'offroad',
      channelSlug: null,
      models: ['corolla'],
    });
    const sameMake = video({
      id: 'b0000000001',
      categoryId: 'offroad',
      channelSlug: null,
      manufacturers: ['toyota'],
    });
    expect(scoreRelated(source, sameModel, now)).toBeGreaterThan(
      scoreRelated(source, sameMake, now),
    );
  });

  it('adds up category, tags and channel', () => {
    const candidate = video({
      id: 'c0000000001',
      categoryId: 'maintenance',
      channelSlug: 'auto-il',
      tags: ['שמן'],
    });
    expect(scoreRelated(source, candidate, now)).toBe(
      RELATED_WEIGHTS.sameCategory + RELATED_WEIGHTS.sharedTag + RELATED_WEIGHTS.sameChannel,
    );
  });

  it('caps the contribution of shared tags so a tag-spammed video cannot dominate', () => {
    const spam = video({
      id: 'd0000000001',
      categoryId: 'offroad',
      channelSlug: null,
      tags: ['שמן', 'מנוע', 'שמן2', 'מנוע2'],
    });
    const source6 = { ...source, tags: ['שמן', 'מנוע', 'שמן2', 'מנוע2', 'x', 'y'] };
    expect(scoreRelated(source6, spam, now)).toBe(3 * RELATED_WEIGHTS.sharedTag);
  });

  it('gives a small bonus to recently added videos', () => {
    const old = video({ id: 'e0000000001', tags: ['שמן'], addedAt: '2019-01-01' });
    const fresh = video({ id: 'f0000000001', tags: ['שמן'], addedAt: '2026-08-20' });
    expect(scoreRelated(source, fresh, now) - scoreRelated(source, old, now)).toBe(
      RELATED_WEIGHTS.recencyBonus,
    );
  });
});

describe('rankRelated', () => {
  it('drops zero-score candidates, orders by score and trims to the limit', () => {
    const source = video({ id: 'source00001', tags: ['שמן'], models: ['corolla'] });
    const candidates = [
      video({ id: 'unrelated01', categoryId: 'offroad', channelSlug: null }),
      video({ id: 'sametag0001', categoryId: 'offroad', channelSlug: null, tags: ['שמן'] }),
      video({ id: 'samemodel01', categoryId: 'offroad', channelSlug: null, models: ['corolla'] }),
    ];
    expect(rankRelated(source, candidates, 10, now).map((item) => item.id)).toEqual([
      'samemodel01',
      'sametag0001',
    ]);
    expect(rankRelated(source, candidates, 1, now)).toHaveLength(1);
  });

  it('breaks ties by recency, so the order is deterministic', () => {
    const source = video({ id: 'source00001', tags: ['שמן'] });
    const older = video({
      id: 'older000001',
      categoryId: 'offroad',
      channelSlug: null,
      tags: ['שמן'],
      addedAt: '2015-01-01',
    });
    const newer = video({
      id: 'newer000001',
      categoryId: 'offroad',
      channelSlug: null,
      tags: ['שמן'],
      addedAt: '2016-01-01',
    });
    expect(rankRelated(source, [older, newer], 5, now).map((item) => item.id)).toEqual([
      'newer000001',
      'older000001',
    ]);
  });
});
