import { describe, expect, it } from 'vitest';
import { buildVehicleIndex, parseVehicleReference } from '@shared/core/vehicles.js';
import {
  type LegacySourceFile,
  type LegacyVideo,
  buildCatalog,
  summarizeIssues,
} from '../../scripts/lib/legacy-catalog.js';

const vehicleIndex = buildVehicleIndex(
  parseVehicleReference({
    manufacturers: [
      { slug: 'toyota', name: 'Toyota', nameHe: 'טויוטה', models: ['Corolla:קורולה'] },
      { slug: 'hyundai', name: 'Hyundai', nameHe: 'יונדאי', models: ['i40:אי 40'] },
    ],
  }),
);

const options = {
  knownCategories: ['maintenance', 'diy', 'review'],
  vehicleIndex,
  fallbackDate: '2026-01-01',
};

const row = (overrides: Partial<LegacyVideo> = {}): LegacyVideo => ({
  id: 'dQw4w9WgXcQ',
  title: 'החלפת שמן בטויוטה קורולה 2015',
  content: 'מדריך מלא',
  channel: '  Auto IL | אוטו  ',
  channelImage: 'https://i.ytimg.com/x.jpg',
  duration: '8:42',
  dateAdded: '17/09/2024',
  tags: ['שמן מנוע', 'טויוטה', 'Auto IL | אוטו', 'טיפולים'],
  hebrewContent: true,
  category: 'maintenance',
  ...overrides,
});

const file = (videos: LegacyVideo[], name = 'maintenance.json'): LegacySourceFile => ({
  category: name.replace('.json', ''),
  fileName: name,
  videos,
});

describe('buildCatalog — happy path', () => {
  const result = buildCatalog([file([row()])], options);

  it('imports the row', () => {
    expect(result.summary.imported).toBe(1);
    expect(result.summary.errors).toBe(0);
  });

  it('parses the duration and the day-first date', () => {
    expect(result.videos[0]?.durationSeconds).toBe(522);
    expect(result.videos[0]?.addedAt).toBe('2024-09-17');
  });

  it('normalises the channel name and derives a slug', () => {
    expect(result.channels).toHaveLength(1);
    expect(result.channels[0]?.name).toBe('Auto IL | אוטו');
    expect(result.channels[0]?.slug).toBe('auto-il-אוטו');
  });

  it('drops tags that only repeat the channel or the category', () => {
    // 'Auto IL | אוטו' is the channel; 'טיפולים' is not the category id, so it stays.
    expect(result.videos[0]?.tagSlugs).toEqual(['שמן-מנוע', 'טויוטה', 'טיפולים']);
  });

  it('detects the manufacturer, the model and the year', () => {
    expect(result.videos[0]?.vehicles).toEqual([
      { manufacturerSlug: 'toyota', modelSlug: 'corolla' },
    ]);
    expect(result.videos[0]?.years).toEqual([2015]);
  });
});

describe('buildCatalog — rejected rows', () => {
  it('skips a row with no id', () => {
    const result = buildCatalog([file([row({ id: undefined })])], options);
    expect(result.summary.imported).toBe(0);
    expect(result.issues[0]?.code).toBe('missing-id');
  });

  it('skips a malformed YouTube id rather than storing it', () => {
    const result = buildCatalog([file([row({ id: 'not-an-id' })])], options);
    expect(result.summary.imported).toBe(0);
    expect(result.issues[0]?.code).toBe('invalid-id');
  });

  it('skips a row with no title', () => {
    const result = buildCatalog([file([row({ title: '   ' })])], options);
    expect(result.summary.imported).toBe(0);
    expect(result.issues[0]?.code).toBe('missing-title');
  });

  it('keeps the first copy of a video that appears in two category files', () => {
    const result = buildCatalog(
      [file([row({ title: 'ראשון' })]), file([row({ title: 'שני' })], 'diy.json')],
      options,
    );
    expect(result.summary.imported).toBe(1);
    expect(result.summary.duplicates).toBe(1);
    expect(result.videos[0]?.title).toBe('ראשון');
  });
});

describe('buildCatalog — rows kept with a warning', () => {
  it('imports a row with an unparseable date, using the fallback', () => {
    const result = buildCatalog([file([row({ dateAdded: '01/01/2' })])], options);
    expect(result.summary.imported).toBe(1);
    expect(result.videos[0]?.addedAt).toBe('2026-01-01');
    expect(result.issues.map((issue) => issue.code)).toContain('invalid-date');
  });

  it('imports a row with no description', () => {
    const result = buildCatalog([file([row({ content: undefined })])], options);
    expect(result.summary.imported).toBe(1);
    expect(result.issues.map((issue) => issue.code)).toContain('missing-description');
  });

  it('imports a row with an unusable duration as zero seconds', () => {
    const result = buildCatalog([file([row({ duration: 'LIVE' })])], options);
    expect(result.videos[0]?.durationSeconds).toBe(0);
    expect(result.issues.map((issue) => issue.code)).toContain('missing-duration');
  });

  it('falls back to the file name when the row carries an unknown category', () => {
    const result = buildCatalog([file([row({ category: 'nonsense' })], 'diy.json')], options);
    expect(result.videos[0]?.categoryId).toBe('diy');
    expect(result.issues.map((issue) => issue.code)).toContain('unknown-category');
  });

  it('accepts a bare number of seconds, as used by Shorts', () => {
    const result = buildCatalog([file([row({ duration: '59' })])], options);
    expect(result.videos[0]?.durationSeconds).toBe(59);
  });
});

describe('buildCatalog — aggregation', () => {
  it('merges a channel that appears on many rows into one record', () => {
    const rows = [
      row({ id: 'aaaaaaaaaaa' }),
      row({ id: 'bbbbbbbbbbb', channelImage: '' }),
      row({ id: 'ccccccccccc' }),
    ];
    const result = buildCatalog([file(rows)], options);
    expect(result.channels).toHaveLength(1);
    expect(result.channels[0]?.videoCount).toBe(3);
    expect(result.channels[0]?.imageUrl).toBe('https://i.ytimg.com/x.jpg');
  });

  it('counts how often each tag is used', () => {
    const result = buildCatalog(
      [file([row({ id: 'aaaaaaaaaaa' }), row({ id: 'bbbbbbbbbbb', tags: ['שמן מנוע'] })])],
      options,
    );
    const oil = result.tags.find((tag) => tag.slug === 'שמן-מנוע');
    expect(oil?.videoCount).toBe(2);
  });

  it('derives isHebrew from the title when the flag is missing', () => {
    const hebrew = buildCatalog([file([row({ hebrewContent: undefined })])], options);
    expect(hebrew.videos[0]?.isHebrew).toBe(true);

    const english = buildCatalog(
      [file([row({ hebrewContent: undefined, title: 'Toyota Corolla oil change' })])],
      options,
    );
    expect(english.videos[0]?.isHebrew).toBe(false);
    expect(english.videos[0]?.language).toBe('en');
  });

  it('reports counts per category', () => {
    const result = buildCatalog(
      [
        file([row({ id: 'aaaaaaaaaaa' })]),
        file([row({ id: 'bbbbbbbbbbb', category: 'diy' })], 'diy.json'),
      ],
      options,
    );
    expect(result.summary.perCategory).toEqual({ maintenance: 1, diy: 1 });
  });
});

describe('summarizeIssues', () => {
  it('groups issues by level and code, most frequent first', () => {
    const result = buildCatalog(
      [file([row({ content: '' }), row({ id: 'bbbbbbbbbbb', content: '' }), row({ id: 'zzz' })])],
      options,
    );
    const summary = summarizeIssues(result.issues);
    expect(summary[0]).toEqual({ level: 'warning', code: 'missing-description', count: 2 });
  });
});

describe('a channel spelled two ways', () => {
  /**
   * The legacy files spell a channel both as "ChrisFix | כריספיקס" and, on a
   * handful of rows, as plain "ChrisFix". Keyed on the slug of the whole name
   * those are two channels — and the catalog shipped exactly that: one with
   * 256 videos in the directory, and one with a single video whose page looked
   * like an abandoned channel.
   */
  const chris = (channel: string, id: string) => row({ channel, id });

  it('folds the short spelling into the full one', () => {
    const result = buildCatalog(
      [
        file([
          chris('ChrisFix | כריספיקס', 'dQw4w9WgXcQ'),
          chris('ChrisFix | כריספיקס', 'aQw4w9WgXcZ'),
          chris('ChrisFix', 'bQw4w9WgXcY'),
        ]),
      ],
      options,
    );

    const named = result.channels.filter((channel) => channel.name.startsWith('ChrisFix'));
    expect(named).toHaveLength(1);
    // The full name survives, because that is what the directory shows.
    expect(named[0]?.name).toBe('ChrisFix | כריספיקס');
    expect(named[0]?.videoCount).toBe(3);
  });

  it('moves the stray video to the surviving channel', () => {
    // The half of the fix that is easy to forget: a merge that leaves the video
    // pointing at a slug nobody has any more loses its channel entirely.
    const result = buildCatalog(
      [file([chris('ChrisFix | כריספיקס', 'dQw4w9WgXcQ'), chris('ChrisFix', 'bQw4w9WgXcY')])],
      options,
    );

    const slugs = new Set(result.channels.map((channel) => channel.slug));
    for (const video of result.videos) {
      expect(video.channelSlug).not.toBeNull();
      expect(slugs.has(video.channelSlug ?? '')).toBe(true);
    }
    expect(new Set(result.videos.map((video) => video.channelSlug)).size).toBe(1);
  });

  it('says so in the report rather than merging silently', () => {
    const result = buildCatalog(
      [file([chris('ChrisFix | כריספיקס', 'dQw4w9WgXcQ'), chris('ChrisFix', 'bQw4w9WgXcY')])],
      options,
    );

    expect(result.issues.some((issue) => issue.code === 'merged-channel')).toBe(true);
  });

  it('leaves two genuinely different channels alone', () => {
    // The rule is an exact prefix, not a resemblance. "ChrisFix Garage" is not
    // "ChrisFix", and merging on a shared first word would be a worse bug than
    // the one this fixes.
    const result = buildCatalog(
      [
        file([
          chris('ChrisFix | כריספיקס', 'dQw4w9WgXcQ'),
          chris('ChrisFix Garage', 'bQw4w9WgXcY'),
          chris('Fix It | תקן את זה', 'cQw4w9WgXcW'),
        ]),
      ],
      options,
    );

    expect(result.channels).toHaveLength(3);
  });
});
