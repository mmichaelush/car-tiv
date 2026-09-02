/**
 * Turning a spreadsheet row into a catalog entry.
 *
 * Shared between the browser and the Worker on purpose. The admin screen shows
 * a preview built with these functions, and the Worker validates each row again
 * with the same ones — so what the editor was shown is exactly what is stored,
 * and a hand-crafted request cannot slip past a check the preview applied.
 *
 * Column names are guessed rather than demanded: an editor should be able to
 * drop in the file they already have. The guess is always shown and always
 * overridable, because guessing wrong silently is far worse than asking.
 */

import { parseCatalogDate } from './dates.js';
import { parseDuration } from './duration.js';
import { normalizeText, slugify } from './text.js';
import { extractVideoId } from './youtube.js';

/** The fields an import can fill. */
export const IMPORT_FIELDS = [
  'videoId',
  'title',
  'description',
  'category',
  'channel',
  'channelUrl',
  'tags',
  'duration',
  'addedAt',
  'isHebrew',
] as const;

export type ImportField = (typeof IMPORT_FIELDS)[number];

/** Which spreadsheet column feeds which field. `null` means "not mapped". */
export type ColumnMapping = Partial<Record<ImportField, string | null>>;

/** Header spellings seen in the wild, per field, normalised for comparison. */
const HEADER_HINTS: Readonly<Record<ImportField, readonly string[]>> = {
  videoId: ['id', 'videoid', 'video id', 'youtube', 'youtube id', 'link', 'url', 'קישור', 'מזהה'],
  title: ['title', 'name', 'כותרת', 'שם', 'שם הסרטון'],
  description: ['description', 'content', 'summary', 'תיאור', 'תוכן'],
  category: ['category', 'קטגוריה', 'נושא'],
  channel: ['channel', 'channel name', 'ערוץ', 'שם הערוץ'],
  channelUrl: ['channel url', 'channelurl', 'channel link', 'קישור לערוץ'],
  tags: ['tags', 'keywords', 'תגיות', 'מילות מפתח'],
  duration: ['duration', 'length', 'אורך', 'משך', 'זמן'],
  addedAt: ['date', 'dateadded', 'date added', 'added', 'תאריך', 'תאריך הוספה'],
  isHebrew: ['hebrew', 'hebrewcontent', 'is hebrew', 'עברית', 'בעברית'],
};

/**
 * Guess a mapping from the file's header row.
 *
 * An exact match on a known spelling wins; otherwise a header that *contains*
 * a hint is accepted, which catches "Video Title (Hebrew)" and similar. Each
 * column is used at most once.
 */
export function guessMapping(headers: readonly string[]): ColumnMapping {
  const mapping: ColumnMapping = {};
  const taken = new Set<string>();

  const normalised = headers.map((header) => ({ header, key: normalizeText(header) }));

  for (const field of IMPORT_FIELDS) {
    const hints = HEADER_HINTS[field].map((hint) => normalizeText(hint));

    const exact = normalised.find(
      (column) => !taken.has(column.header) && hints.includes(column.key),
    );
    const fuzzy =
      exact ??
      normalised.find(
        (column) =>
          !taken.has(column.header) &&
          hints.some((hint) => hint.length > 2 && column.key.includes(hint)),
      );

    if (fuzzy != null) {
      mapping[field] = fuzzy.header;
      taken.add(fuzzy.header);
    }
  }

  return mapping;
}

/** A row that passed validation, ready to be written. */
export interface ImportDraft {
  readonly videoId: string;
  readonly title: string;
  readonly description: string;
  readonly categoryId: string | null;
  readonly channelName: string;
  readonly channelUrl: string;
  readonly tags: readonly string[];
  readonly durationSeconds: number;
  readonly addedAt: string | null;
  readonly isHebrew: boolean;
}

export interface RowProblem {
  readonly field: string;
  readonly code: 'missing' | 'invalid';
  readonly message: string;
}

export type RowResult =
  | { readonly ok: true; readonly draft: ImportDraft }
  | { readonly ok: false; readonly problems: readonly RowProblem[] };

/** How many tags one row may carry. Anything beyond is a copy-paste accident. */
const MAX_TAGS = 25;

/**
 * Validate and normalise one row.
 *
 * A row needs two things to be usable: a resolvable YouTube id and a title.
 * Everything else is optional and degrades to a sensible default, because a
 * missing duration is not a reason to reject a video an editor wants.
 */
export function readRow(row: Record<string, string>, mapping: ColumnMapping): RowResult {
  const value = (field: ImportField): string => {
    const column = mapping[field];
    if (column == null) return '';
    return (row[column] ?? '').trim();
  };

  const problems: RowProblem[] = [];

  const rawId = value('videoId');
  const videoId = extractVideoId(rawId);
  if (rawId.length === 0) {
    problems.push({ field: 'videoId', code: 'missing', message: 'חסר קישור או מזהה של הסרטון' });
  } else if (videoId == null) {
    problems.push({
      field: 'videoId',
      code: 'invalid',
      message: 'הקישור או המזהה אינם תקינים',
    });
  }

  const title = value('title');
  if (title.length === 0) {
    problems.push({ field: 'title', code: 'missing', message: 'חסרה כותרת' });
  } else if (title.length > 300) {
    problems.push({ field: 'title', code: 'invalid', message: 'הכותרת ארוכה מ־300 תווים' });
  }

  if (problems.length > 0 || videoId == null) return { ok: false, problems };

  const rawDate = value('addedAt');
  const parsedDate = rawDate.length === 0 ? null : parseCatalogDate(rawDate);
  if (rawDate.length > 0 && parsedDate == null) {
    // A wrong date is worth reporting but not worth rejecting the row over —
    // it falls back to "today", which is what an editor expects for an import.
    problems.push({ field: 'addedAt', code: 'invalid', message: 'התאריך אינו תקין ולכן הושמט' });
  }

  return {
    ok: true,
    draft: {
      videoId,
      title,
      description: value('description').slice(0, 5_000),
      categoryId: readCategory(value('category')),
      channelName: value('channel'),
      channelUrl: value('channelUrl'),
      tags: readTags(value('tags')),
      durationSeconds: parseDuration(value('duration')) ?? 0,
      addedAt: parsedDate,
      isHebrew: readBoolean(value('isHebrew')),
    },
  };
}

/** `"שמן, מנוע; טיפול"` -> three tags, de-duplicated and trimmed. */
function readTags(value: string): string[] {
  if (value.length === 0) return [];

  const seen = new Set<string>();
  const tags: string[] = [];

  for (const part of value.split(/[,;|\n]/)) {
    const tag = part.trim();
    if (tag.length === 0 || tag.length > 60) continue;

    const key = normalizeText(tag);
    if (key.length === 0 || seen.has(key)) continue;

    seen.add(key);
    tags.push(tag);
    if (tags.length >= MAX_TAGS) break;
  }

  return tags;
}

/** A category cell may hold an id or a display name; both become a slug. */
function readCategory(value: string): string | null {
  if (value.length === 0) return null;
  const slug = slugify(value);
  return slug.length === 0 ? null : slug;
}

/**
 * Read a truthy cell.
 *
 * Spreadsheets express "yes" in at least six ways, and an unrecognised value
 * means "not marked" rather than "false", which is the same thing here.
 */
function readBoolean(value: string): boolean {
  const normalised = normalizeText(value);
  return ['1', 'true', 'yes', 'y', 'כן', 'עברית', 'v'].includes(normalised);
}
