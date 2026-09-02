import { describe, expect, it } from 'vitest';
import {
  asVideoId,
  embedUrl,
  extractVideoId,
  isVideoId,
  normalizeChannelUrl,
  thumbnailUrl,
  watchUrl,
} from '@shared/core/youtube.js';

const ID = 'dQw4w9WgXcQ';

describe('isVideoId', () => {
  it('accepts exactly eleven URL-safe characters', () => {
    expect(isVideoId(ID)).toBe(true);
    expect(isVideoId('abc')).toBe(false);
    expect(isVideoId(`${ID}x`)).toBe(false);
    expect(isVideoId('dQw4w9WgXc!')).toBe(false);
    expect(isVideoId(null)).toBe(false);
  });
});

describe('extractVideoId', () => {
  it.each([
    ID,
    `https://www.youtube.com/watch?v=${ID}`,
    `http://youtube.com/watch?v=${ID}&list=PL123`,
    `https://m.youtube.com/watch?app=desktop&v=${ID}`,
    `https://youtu.be/${ID}`,
    `https://youtu.be/${ID}?t=42`,
    `https://www.youtube.com/embed/${ID}`,
    `https://www.youtube.com/shorts/${ID}`,
    `https://www.youtube.com/live/${ID}`,
    `  https://www.youtube.com/watch?v=${ID}  `,
  ])('extracts the id from %s', (input) => {
    expect(extractVideoId(input)).toBe(ID);
  });

  it('returns null when there is no id', () => {
    expect(extractVideoId('https://www.youtube.com/@somechannel')).toBeNull();
    expect(extractVideoId('just some text')).toBeNull();
    expect(extractVideoId('')).toBeNull();
    expect(extractVideoId(null)).toBeNull();
  });

  it('does not match a longer token that merely starts with a valid id', () => {
    expect(extractVideoId(`https://youtu.be/${ID}EXTRA`)).toBeNull();
  });
});

describe('asVideoId', () => {
  it('throws on an invalid id so bad data cannot reach the database', () => {
    expect(() => asVideoId('nope')).toThrow();
    expect(asVideoId(ID)).toBe(ID);
  });
});

describe('url builders', () => {
  it('builds a watch url', () => {
    expect(watchUrl(asVideoId(ID))).toBe(`https://www.youtube.com/watch?v=${ID}`);
  });

  it('uses the no-cookie host for embeds', () => {
    expect(embedUrl(asVideoId(ID))).toContain('youtube-nocookie.com');
  });

  it('passes autoplay and a start offset through', () => {
    const url = embedUrl(asVideoId(ID), { autoplay: true, startSeconds: 42.7 });
    expect(url).toContain('autoplay=1');
    expect(url).toContain('start=42');
  });

  it('prefers an editor-supplied thumbnail over the YouTube default', () => {
    expect(thumbnailUrl(asVideoId(ID), 'high', 'https://cdn.example/x.jpg')).toBe(
      'https://cdn.example/x.jpg',
    );
    expect(thumbnailUrl(asVideoId(ID))).toBe(`https://i.ytimg.com/vi/${ID}/hqdefault.jpg`);
  });
});

describe('normalizeChannelUrl', () => {
  it('canonicalises a YouTube channel url', () => {
    expect(normalizeChannelUrl('https://m.youtube.com/@autoil/')).toBe(
      'https://www.youtube.com/@autoil',
    );
  });

  it('rejects non-YouTube and malformed urls', () => {
    expect(normalizeChannelUrl('https://example.com/@autoil')).toBeNull();
    expect(normalizeChannelUrl('www.youtube.com/@autoil')).toBeNull();
    expect(normalizeChannelUrl(null)).toBeNull();
  });
});
