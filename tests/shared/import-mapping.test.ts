/**
 * Guessing columns, and validating a row.
 *
 * These functions run twice for every import — once in the browser to build
 * the preview and once in the Worker to write the rows — so they are the
 * definition of what an import accepts.
 */

import { describe, expect, it } from 'vitest';
import { guessMapping, readRow, type ColumnMapping } from '@shared/core/import-mapping.js';

describe('guessMapping', () => {
  it('recognises the English headers a YouTube export uses', () => {
    const mapping = guessMapping(['Video ID', 'Title', 'Description', 'Duration', 'Date Added']);

    expect(mapping.videoId).toBe('Video ID');
    expect(mapping.title).toBe('Title');
    expect(mapping.description).toBe('Description');
    expect(mapping.duration).toBe('Duration');
    expect(mapping.addedAt).toBe('Date Added');
  });

  it('recognises Hebrew headers', () => {
    const mapping = guessMapping(['קישור', 'כותרת', 'קטגוריה', 'תגיות', 'ערוץ']);

    expect(mapping.videoId).toBe('קישור');
    expect(mapping.title).toBe('כותרת');
    expect(mapping.category).toBe('קטגוריה');
    expect(mapping.tags).toBe('תגיות');
    expect(mapping.channel).toBe('ערוץ');
  });

  it('matches a header that merely contains the hint', () => {
    expect(guessMapping(['Video Title (Hebrew)']).title).toBe('Video Title (Hebrew)');
  });

  it('never assigns one column to two fields', () => {
    const mapping = guessMapping(['channel', 'channel url']);
    expect(mapping.channel).not.toBe(mapping.channelUrl);
  });

  it('leaves a field unmapped rather than guessing wildly', () => {
    expect(guessMapping(['אלף', 'בית']).videoId).toBeUndefined();
  });
});

describe('readRow', () => {
  const mapping: ColumnMapping = {
    videoId: 'link',
    title: 'title',
    description: 'desc',
    category: 'cat',
    channel: 'channel',
    tags: 'tags',
    duration: 'len',
    addedAt: 'date',
    isHebrew: 'hebrew',
  };

  const row = (overrides: Record<string, string> = {}): Record<string, string> => ({
    link: 'https://www.youtube.com/watch?v=corolla0001',
    title: 'החלפת שמן בטויוטה קורולה',
    desc: 'מדריך מלא',
    cat: 'maintenance',
    channel: 'Auto IL',
    tags: 'שמן מנוע, טיפול; מסנן',
    len: '8:42',
    date: '20/08/2026',
    hebrew: 'כן',
    ...overrides,
  });

  it('reads a full row', () => {
    const result = readRow(row(), mapping);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.draft.videoId).toBe('corolla0001');
    expect(result.draft.title).toBe('החלפת שמן בטויוטה קורולה');
    expect(result.draft.durationSeconds).toBe(522);
    expect(result.draft.isHebrew).toBe(true);
    expect(result.draft.addedAt).toBe('2026-08-20');
  });

  it('accepts a bare id as readily as a full URL', () => {
    const result = readRow(row({ link: 'corolla0001' }), mapping);
    expect(result.ok && result.draft.videoId).toBe('corolla0001');
  });

  it('splits tags on commas, semicolons and pipes, and de-duplicates', () => {
    const result = readRow(row({ tags: 'שמן, שמן; מנוע | טיפול' }), mapping);
    expect(result.ok && result.draft.tags).toEqual(['שמן', 'מנוע', 'טיפול']);
  });

  it('rejects a row with no video id', () => {
    const result = readRow(row({ link: '' }), mapping);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems[0]?.field).toBe('videoId');
    expect(result.problems[0]?.code).toBe('missing');
  });

  it('rejects a row whose link is not a YouTube video', () => {
    const result = readRow(row({ link: 'https://example.com/x' }), mapping);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems[0]?.code).toBe('invalid');
  });

  it('rejects a row with no title', () => {
    const result = readRow(row({ title: '   ' }), mapping);
    expect(result.ok).toBe(false);
  });

  it('reads a day-first date, the way the old catalog wrote them', () => {
    // 03/04 is 3 April, not 4 March. `new Date('03/04/2026')` disagrees, which
    // is exactly why this goes through `parseCatalogDate`.
    const result = readRow(row({ date: '03/04/2026' }), mapping);
    expect(result.ok && result.draft.addedAt).toBe('2026-04-03');
  });

  it('keeps a row whose date is unreadable, with no date rather than no row', () => {
    const result = readRow(row({ date: 'לא ידוע' }), mapping);
    expect(result.ok).toBe(true);
    expect(result.ok && result.draft.addedAt).toBeNull();
  });

  it('treats a missing duration as zero rather than failing', () => {
    const result = readRow(row({ len: '' }), mapping);
    expect(result.ok && result.draft.durationSeconds).toBe(0);
  });

  it('reads "yes" in the several ways a spreadsheet spells it', () => {
    for (const value of ['1', 'true', 'yes', 'כן', 'V']) {
      const result = readRow(row({ hebrew: value }), mapping);
      expect(result.ok && result.draft.isHebrew).toBe(true);
    }
    expect(readRow(row({ hebrew: 'לא' }), mapping)).toMatchObject({
      draft: { isHebrew: false },
    });
  });

  it('ignores a field the mapping does not cover', () => {
    const result = readRow(row(), { videoId: 'link', title: 'title' });
    expect(result.ok && result.draft.tags).toEqual([]);
    expect(result.ok && result.draft.channelName).toBe('');
  });
});
