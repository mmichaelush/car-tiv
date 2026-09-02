/**
 * Migration of the legacy `data/videos/*.json` catalog into the D1 model.
 *
 * This module is pure: it takes parsed JSON in and returns normalised records
 * plus a list of every problem it found. No file system, no database, no
 * console — so the whole migration is unit-testable and the report is data
 * rather than log output.
 *
 * The rules it applies are the ones the old front-end applied implicitly and
 * inconsistently:
 *   * `DD/MM/YYYY` is day-first (see shared/core/dates.ts).
 *   * `"8:42"` and a bare `"59"` are both durations in seconds.
 *   * a channel name repeated on 800 rows becomes one `channels` row.
 *   * a tag that merely repeats the channel or the category is dropped, because
 *     those relationships are now modelled properly.
 */

import { YOUTUBE_ID_PATTERN } from '@shared/constants.js';
import { parseCatalogDate } from '@shared/core/dates.js';
import { parseDuration } from '@shared/core/duration.js';
import { containsHebrew, indexText, slugify, slugifyWithFallback } from '@shared/core/text.js';
import {
  type VehicleIndex,
  type VehicleMatch,
  detectVehicles,
  detectYears,
} from '@shared/core/vehicles.js';

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/** One record exactly as it appears in the legacy JSON files. */
export interface LegacyVideo {
  readonly id?: unknown;
  readonly title?: unknown;
  readonly content?: unknown;
  readonly channel?: unknown;
  readonly channelImage?: unknown;
  readonly duration?: unknown;
  readonly dateAdded?: unknown;
  readonly tags?: unknown;
  readonly hebrewContent?: unknown;
  readonly category?: unknown;
}

/** One `data/videos/<category>.json` file. */
export interface LegacySourceFile {
  /** Category derived from the file name, used when a row does not carry one. */
  readonly category: string;
  readonly fileName: string;
  readonly videos: readonly LegacyVideo[];
}

export interface BuildOptions {
  /** Category ids that exist in the database. Rows outside this set are reported. */
  readonly knownCategories: readonly string[];
  /** Vehicle reference index, for manufacturer/model detection. */
  readonly vehicleIndex: VehicleIndex;
  /** Used as `added_at` when a row's date cannot be parsed. */
  readonly fallbackDate: string;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export interface NormalizedChannel {
  readonly slug: string;
  readonly name: string;
  imageUrl: string | null;
  videoCount: number;
}

export interface NormalizedTag {
  readonly slug: string;
  readonly name: string;
  videoCount: number;
}

export interface NormalizedVideo {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly categoryId: string;
  readonly channelSlug: string | null;
  readonly durationSeconds: number;
  readonly isHebrew: boolean;
  readonly language: string;
  readonly addedAt: string;
  readonly tagSlugs: readonly string[];
  readonly vehicles: readonly VehicleMatch[];
  readonly years: readonly number[];
}

/** Severity decides whether the import may proceed. */
export type IssueLevel = 'error' | 'warning';

export interface ImportIssue {
  readonly level: IssueLevel;
  /** Stable machine-readable code, so the report can be grouped and counted. */
  readonly code:
    | 'missing-id'
    | 'invalid-id'
    | 'duplicate-id'
    | 'missing-title'
    | 'unknown-category'
    | 'invalid-date'
    | 'missing-duration'
    | 'missing-description'
    | 'missing-channel';
  readonly fileName: string;
  readonly rowNumber: number;
  readonly videoId: string | null;
  readonly message: string;
}

export interface CatalogBuildResult {
  readonly videos: readonly NormalizedVideo[];
  readonly channels: readonly NormalizedChannel[];
  readonly tags: readonly NormalizedTag[];
  readonly issues: readonly ImportIssue[];
  readonly summary: CatalogSummary;
}

export interface CatalogSummary {
  readonly sourceRows: number;
  readonly imported: number;
  readonly skipped: number;
  readonly duplicates: number;
  readonly errors: number;
  readonly warnings: number;
  readonly channels: number;
  readonly tags: number;
  readonly withVehicle: number;
  readonly perCategory: Readonly<Record<string, number>>;
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

/**
 * Normalise every legacy row into the catalog model.
 *
 * A row is *skipped* only when it cannot be stored at all — no usable YouTube
 * id, no title, or a duplicate of a row already taken. Everything else is
 * imported with a warning attached, because losing a video is worse than
 * importing one with a missing description.
 */
export function buildCatalog(
  files: readonly LegacySourceFile[],
  options: BuildOptions,
): CatalogBuildResult {
  const knownCategories = new Set(options.knownCategories);
  const videos: NormalizedVideo[] = [];
  const issues: ImportIssue[] = [];
  const channels = new Map<string, NormalizedChannel>();
  const tags = new Map<string, NormalizedTag>();
  const seenIds = new Set<string>();

  let sourceRows = 0;
  let duplicates = 0;

  for (const file of files) {
    for (const [index, raw] of file.videos.entries()) {
      sourceRows += 1;
      const rowNumber = index + 1;
      const report = (issue: Omit<ImportIssue, 'fileName' | 'rowNumber'>): void => {
        issues.push({ ...issue, fileName: file.fileName, rowNumber });
      };

      const id = typeof raw.id === 'string' ? raw.id.trim() : '';
      if (id.length === 0) {
        report({
          level: 'error',
          code: 'missing-id',
          videoId: null,
          message: 'שורה ללא מזהה YouTube',
        });
        continue;
      }
      if (!YOUTUBE_ID_PATTERN.test(id)) {
        report({
          level: 'error',
          code: 'invalid-id',
          videoId: id,
          message: `מזהה YouTube לא חוקי: ${id}`,
        });
        continue;
      }
      if (seenIds.has(id)) {
        duplicates += 1;
        report({
          level: 'error',
          code: 'duplicate-id',
          videoId: id,
          message: 'הסרטון כבר יובא מקובץ אחר',
        });
        continue;
      }

      const title = readString(raw.title);
      if (title.length === 0) {
        report({ level: 'error', code: 'missing-title', videoId: id, message: 'סרטון ללא כותרת' });
        continue;
      }

      const categoryId = readString(raw.category) || file.category;
      if (!knownCategories.has(categoryId)) {
        report({
          level: 'warning',
          code: 'unknown-category',
          videoId: id,
          message: `קטגוריה לא מוכרת "${categoryId}", שויכה ל־${file.category}`,
        });
      }

      const description = readString(raw.content);
      if (description.length === 0) {
        report({
          level: 'warning',
          code: 'missing-description',
          videoId: id,
          message: 'סרטון ללא תיאור',
        });
      }

      const durationSeconds = parseDuration(readString(raw.duration));
      if (durationSeconds === 0) {
        report({
          level: 'warning',
          code: 'missing-duration',
          videoId: id,
          message: 'משך הסרטון חסר או לא תקין',
        });
      }

      const parsedDate = parseCatalogDate(readString(raw.dateAdded));
      if (parsedDate == null) {
        report({
          level: 'warning',
          code: 'invalid-date',
          videoId: id,
          message: `תאריך לא תקין "${readString(raw.dateAdded)}"`,
        });
      }

      const channel = upsertChannel(channels, raw);
      if (channel == null) {
        report({
          level: 'warning',
          code: 'missing-channel',
          videoId: id,
          message: 'סרטון ללא ערוץ',
        });
      }

      const resolvedCategory = knownCategories.has(categoryId) ? categoryId : file.category;
      const tagSlugs = collectTags(raw.tags, tags, {
        channelSlug: channel?.slug ?? null,
        channelName: channel?.name ?? '',
        categoryId: resolvedCategory,
      });

      const searchable = [title, description, ...readStringArray(raw.tags)].join(' ');

      seenIds.add(id);
      videos.push({
        id,
        title,
        description,
        categoryId: resolvedCategory,
        channelSlug: channel?.slug ?? null,
        durationSeconds,
        isHebrew: readBoolean(raw.hebrewContent) ?? containsHebrew(title),
        language: (readBoolean(raw.hebrewContent) ?? containsHebrew(title)) ? 'he' : 'en',
        addedAt: parsedDate ?? options.fallbackDate,
        tagSlugs,
        vehicles: detectVehicles(searchable, options.vehicleIndex),
        years: detectYears(searchable),
      });
    }
  }

  const perCategory: Record<string, number> = {};
  for (const video of videos) {
    perCategory[video.categoryId] = (perCategory[video.categoryId] ?? 0) + 1;
  }

  return {
    videos,
    channels: [...channels.values()].sort((a, b) => b.videoCount - a.videoCount),
    tags: [...tags.values()].sort((a, b) => b.videoCount - a.videoCount),
    issues,
    summary: {
      sourceRows,
      imported: videos.length,
      skipped: sourceRows - videos.length,
      duplicates,
      errors: issues.filter((issue) => issue.level === 'error').length,
      warnings: issues.filter((issue) => issue.level === 'warning').length,
      channels: channels.size,
      tags: tags.size,
      withVehicle: videos.filter((video) => video.vehicles.length > 0).length,
      perCategory,
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Register the row's channel, merging duplicates by slug.
 *
 * Channel names in the legacy data carry stray whitespace, and 15 channels
 * appear with more than one avatar URL. The first non-empty image wins; the
 * admin can correct it afterwards.
 */
function upsertChannel(
  channels: Map<string, NormalizedChannel>,
  raw: LegacyVideo,
): NormalizedChannel | null {
  const name = readString(raw.channel);
  if (name.length === 0) return null;

  const slug = slugifyWithFallback(name, `channel-${String(channels.size + 1)}`);
  const image = readString(raw.channelImage);
  const existing = channels.get(slug);

  if (existing != null) {
    existing.videoCount += 1;
    if (existing.imageUrl == null && image.length > 0) existing.imageUrl = image;
    return existing;
  }

  const created: NormalizedChannel = {
    slug,
    name,
    imageUrl: image.length > 0 ? image : null,
    videoCount: 1,
  };
  channels.set(slug, created);
  return created;
}

/**
 * Normalise a row's tags and register them globally.
 *
 * Tags that only repeat the channel name or the category name are dropped:
 * those relationships now have their own columns, and keeping them would put
 * ~13,500 redundant rows into `video_tags` and pollute the popular-tags list.
 */
function collectTags(
  rawTags: unknown,
  tags: Map<string, NormalizedTag>,
  context: { channelSlug: string | null; channelName: string; categoryId: string },
): string[] {
  const channelTokens = new Set<string>();
  if (context.channelSlug != null) channelTokens.add(context.channelSlug);
  // Channel names are often written as "English | עברית"; either half alone is
  // also used as a tag.
  for (const part of context.channelName.split('|')) {
    const slug = slugify(part);
    if (slug.length > 0) channelTokens.add(slug);
  }

  const result: string[] = [];
  const seen = new Set<string>();

  for (const value of readStringArray(rawTags)) {
    const name = value.trim();
    const slug = slugify(name);
    if (slug.length === 0 || seen.has(slug)) continue;
    if (channelTokens.has(slug)) continue;
    if (slug === context.categoryId) continue;

    seen.add(slug);
    result.push(slug);

    const existing = tags.get(slug);
    if (existing == null) {
      tags.set(slug, { slug, name, videoCount: 1 });
    } else {
      existing.videoCount += 1;
    }
  }

  return result;
}

function readString(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return String(value);
  return '';
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function readBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value === 'true' || value === '1';
  return null;
}

/**
 * Names used when a category id is missing from the reference list. Exported so
 * the report can show a readable label rather than a slug.
 */
export function describeIssue(issue: ImportIssue): string {
  const location = `${issue.fileName}:${String(issue.rowNumber)}`;
  const id = issue.videoId == null ? '' : ` (${issue.videoId})`;
  return `[${issue.level}] ${location}${id} — ${issue.message}`;
}

/** Group issues by code, for a compact report table. */
export function summarizeIssues(
  issues: readonly ImportIssue[],
): { code: ImportIssue['code']; level: IssueLevel; count: number }[] {
  const groups = new Map<string, { code: ImportIssue['code']; level: IssueLevel; count: number }>();
  for (const issue of issues) {
    const key = `${issue.level}:${issue.code}`;
    const existing = groups.get(key);
    if (existing == null) groups.set(key, { code: issue.code, level: issue.level, count: 1 });
    else existing.count += 1;
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

/** Tag slugs are the normalised form; exposed for the SQL writer and tests. */
export const tagSlugOf = (name: string): string => indexText(name).replace(/\s+/g, '-');
