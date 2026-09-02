/**
 * Build the D1 import from the legacy JSON catalog.
 *
 *     npm run catalog:build
 *
 * Reads `data/videos/*.json`, `data/featured_channels.json` and
 * `data/reference/vehicles.json`; writes numbered `.sql` files plus a report
 * under `build/catalog/`. Nothing is written to any database — applying the
 * files is a separate, deliberate step:
 *
 *     wrangler d1 execute car-tiv-dev --local --file=build/catalog/0001_....sql
 *     # or, for every file in order:
 *     npm run catalog:import:local
 *
 * The report is the deliverable that decides whether the migration is safe to
 * apply: it lists the source count, the imported count, every duplicate and
 * every row that lost data.
 */

import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { parseVehicleReference, buildVehicleIndex } from '@shared/core/vehicles.js';
import { indexText, slugify } from '@shared/core/text.js';
import type { RawVehicleReference } from '@shared/core/vehicles.js';
import {
  type CatalogBuildResult,
  type LegacySourceFile,
  type LegacyVideo,
  buildCatalog,
  summarizeIssues,
} from './lib/legacy-catalog.js';
import { chunkStatements, insertMany, literal, type SqlValue } from './lib/sql.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const OUT_DIR = path.join(ROOT, 'build', 'catalog');

/** Category ids that exist in `seeds/0001_reference_data.sql`. */
const KNOWN_CATEGORIES = [
  'review',
  'maintenance',
  'diy',
  'troubleshooting',
  'systems',
  'safety',
  'driving',
  'offroad',
  'upgrades',
  'collectors',
] as const;

interface FeaturedChannelRow {
  readonly channel_name?: string;
  readonly channel_url?: string;
  readonly channel_image_url?: string;
  readonly content_description?: string;
}

async function main(): Promise<void> {
  const started = Date.now();

  const reference = JSON.parse(
    await readFile(path.join(DATA_DIR, 'reference', 'vehicles.json'), 'utf8'),
  ) as RawVehicleReference;
  const manufacturers = parseVehicleReference(reference);
  const vehicleIndex = buildVehicleIndex(manufacturers);

  const files = await readLegacyFiles(path.join(DATA_DIR, 'videos'));
  const result = buildCatalog(files, {
    knownCategories: [...KNOWN_CATEGORIES],
    vehicleIndex,
    fallbackDate: new Date().toISOString().slice(0, 10),
  });

  const featured = await readFeaturedChannels(path.join(DATA_DIR, 'featured_channels.json'));

  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });

  const groups = buildStatementGroups(result, manufacturers, featured);
  const written: string[] = [];
  let fileIndex = 1;

  for (const group of groups) {
    for (const contents of chunkStatements(group.statements)) {
      const name = `${String(fileIndex).padStart(4, '0')}_${group.name}.sql`;
      await writeFile(path.join(OUT_DIR, name), `-- ${group.title}\n\n${contents}`, 'utf8');
      written.push(name);
      fileIndex += 1;
    }
  }

  const report = buildReport(result, featured.size, written);
  await writeFile(path.join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
  await writeFile(path.join(OUT_DIR, 'report.md'), renderReport(report), 'utf8');

  printSummary(report, written.length, Date.now() - started);

  // A duplicate or an unparseable row is expected in a 7,876-row legacy file and
  // must not fail the build; only an empty result is a real failure.
  if (result.videos.length === 0) {
    console.error('No videos were produced — refusing to write an empty catalog.');
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

async function readLegacyFiles(directory: string): Promise<LegacySourceFile[]> {
  const entries = (await readdir(directory)).filter((name) => name.endsWith('.json')).sort();

  return Promise.all(
    entries.map(async (fileName) => {
      const parsed = JSON.parse(await readFile(path.join(directory, fileName), 'utf8')) as
        { videos?: LegacyVideo[] } | LegacyVideo[];
      const videos = Array.isArray(parsed) ? parsed : (parsed.videos ?? []);
      return { category: path.basename(fileName, '.json'), fileName, videos };
    }),
  );
}

/** Featured channels, keyed by the slug of their name so they can be matched. */
async function readFeaturedChannels(file: string): Promise<Map<string, FeaturedChannelRow>> {
  const parsed = JSON.parse(await readFile(file, 'utf8')) as
    { channels?: FeaturedChannelRow[] } | FeaturedChannelRow[];
  const rows = Array.isArray(parsed) ? parsed : (parsed.channels ?? []);

  const map = new Map<string, FeaturedChannelRow>();
  for (const row of rows) {
    const slug = slugify(row.channel_name ?? '');
    if (slug.length > 0) map.set(slug, row);
  }
  return map;
}

// ---------------------------------------------------------------------------
// SQL generation
// ---------------------------------------------------------------------------

interface StatementGroup {
  readonly name: string;
  readonly title: string;
  readonly statements: string[];
}

function buildStatementGroups(
  result: CatalogBuildResult,
  manufacturers: ReturnType<typeof parseVehicleReference>,
  featured: Map<string, FeaturedChannelRow>,
): StatementGroup[] {
  const groups: StatementGroup[] = [];

  // 1. Vehicle reference data. Models reference manufacturers by slug through a
  //    sub-select so the file does not depend on autoincrement ids.
  groups.push({
    name: 'manufacturers',
    title: 'Manufacturers and models',
    statements: [
      ...insertMany(
        'manufacturers',
        ['slug', 'name', 'name_he'],
        manufacturers.map((item) => [item.slug, item.name, item.nameHe]),
      ),
      ...manufacturers.flatMap((manufacturer) =>
        manufacturer.models.map(
          (model) =>
            `INSERT OR IGNORE INTO vehicle_models (manufacturer_id, slug, name, name_he)\n` +
            `  SELECT id, ${sql(model.slug)}, ${sql(model.name)}, ${sql(model.nameHe)}\n` +
            `  FROM manufacturers WHERE slug = ${sql(manufacturer.slug)};`,
        ),
      ),
    ],
  });

  // 2. Channels, with the "featured" flag applied from featured_channels.json.
  //    Seven featured channels have no video in the catalog yet; they are still
  //    inserted so the "channels worth knowing" strip keeps all 79 entries.
  const channelRows: SqlValue[][] = result.channels.map((channel, order) => {
    const highlight = featured.get(channel.slug);
    return [
      channel.slug,
      channel.name,
      channel.imageUrl ?? highlight?.channel_image_url ?? null,
      highlight?.channel_url ?? null,
      highlight?.content_description ?? '',
      highlight != null,
      highlight != null ? order : 0,
    ];
  });

  const knownSlugs = new Set(result.channels.map((channel) => channel.slug));
  let extraOrder = channelRows.length;
  for (const [slug, row] of featured) {
    if (knownSlugs.has(slug)) continue;
    extraOrder += 1;
    channelRows.push([
      slug,
      row.channel_name ?? slug,
      row.channel_image_url ?? null,
      row.channel_url ?? null,
      row.content_description ?? '',
      true,
      extraOrder,
    ]);
  }

  groups.push({
    name: 'channels',
    title: `Channels (${String(channelRows.length)})`,
    statements: insertMany(
      'channels',
      ['slug', 'name', 'image_url', 'youtube_url', 'description', 'is_featured', 'featured_order'],
      channelRows,
    ),
  });

  // 3. Tags.
  groups.push({
    name: 'tags',
    title: `Tags (${String(result.tags.length)})`,
    statements: insertMany(
      'tags',
      ['slug', 'name'],
      result.tags.map((tag) => [tag.slug, tag.name]),
    ),
  });

  // 4. Videos.
  groups.push({
    name: 'videos',
    title: `Videos (${String(result.videos.length)})`,
    statements: buildVideoStatements(result),
  });

  // 5. Relations.
  groups.push({
    name: 'video_tags',
    title: 'Video ↔ tag relations',
    statements: buildVideoTagStatements(result),
  });

  groups.push({
    name: 'video_vehicles',
    title: 'Video ↔ vehicle relations',
    statements: buildVideoVehicleStatements(result),
  });

  // 6. Search index.
  groups.push({
    name: 'search_index',
    title: 'Full-text search index',
    statements: buildSearchIndexStatements(result, manufacturers),
  });

  return groups;
}

function buildVideoStatements(result: CatalogBuildResult): string[] {
  // channel_id is resolved from the slug at insert time, so this file never
  // hard-codes an autoincrement id.
  return result.videos.map((video) => {
    const channel =
      video.channelSlug == null
        ? 'NULL'
        : `(SELECT id FROM channels WHERE slug = ${sql(video.channelSlug)})`;

    return (
      `INSERT OR IGNORE INTO videos\n` +
      `  (id, title, description, category_id, channel_id, duration_seconds, language, is_hebrew, added_at, status)\n` +
      `  VALUES (${sql(video.id)}, ${sql(video.title)}, ${sql(video.description)}, ` +
      `${sql(video.categoryId)}, ${channel}, ${String(video.durationSeconds)}, ` +
      `${sql(video.language)}, ${video.isHebrew ? '1' : '0'}, ${sql(video.addedAt)}, 'published');`
    );
  });
}

function buildVideoTagStatements(result: CatalogBuildResult): string[] {
  const statements: string[] = [];
  for (const video of result.videos) {
    for (const tagSlug of video.tagSlugs) {
      statements.push(
        `INSERT OR IGNORE INTO video_tags (video_id, tag_id)\n` +
          `  SELECT ${sql(video.id)}, id FROM tags WHERE slug = ${sql(tagSlug)};`,
      );
    }
  }
  return statements;
}

function buildVideoVehicleStatements(result: CatalogBuildResult): string[] {
  const statements: string[] = [];
  for (const video of result.videos) {
    for (const match of video.vehicles) {
      if (match.modelSlug == null) continue;
      const year = video.years.length > 0 ? video.years[0] : null;
      statements.push(
        `INSERT OR IGNORE INTO video_vehicle_models (video_id, model_id, year_from, year_to)\n` +
          `  SELECT ${sql(video.id)}, m.id, ${year == null ? 'NULL' : String(year)}, ${year == null ? 'NULL' : String(year)}\n` +
          `  FROM vehicle_models m JOIN manufacturers mk ON mk.id = m.manufacturer_id\n` +
          `  WHERE mk.slug = ${sql(match.manufacturerSlug)} AND m.slug = ${sql(match.modelSlug)};`,
      );
    }
  }
  return statements;
}

function buildSearchIndexStatements(
  result: CatalogBuildResult,
  manufacturers: ReturnType<typeof parseVehicleReference>,
): string[] {
  const nameBySlug = new Map(manufacturers.map((item) => [item.slug, item.name]));
  const modelNames = new Map<string, string>();
  for (const manufacturer of manufacturers) {
    for (const model of manufacturer.models) {
      modelNames.set(`${manufacturer.slug}/${model.slug}`, model.name);
    }
  }

  const channelNames = new Map(result.channels.map((channel) => [channel.slug, channel.name]));
  const tagNames = new Map(result.tags.map((tag) => [tag.slug, tag.name]));

  const rows: SqlValue[][] = result.videos.map((video) => {
    const vehicleNames = video.vehicles.map(
      (match) => nameBySlug.get(match.manufacturerSlug) ?? '',
    );
    const modelLabels = video.vehicles
      .filter((match) => match.modelSlug != null)
      .map((match) => modelNames.get(`${match.manufacturerSlug}/${String(match.modelSlug)}`) ?? '');

    return [
      video.id,
      indexText(video.title),
      indexText(vehicleNames.join(' ')),
      indexText(modelLabels.join(' ')),
      indexText(video.tagSlugs.map((slug) => tagNames.get(slug) ?? slug).join(' ')),
      indexText(video.description),
      indexText(video.channelSlug == null ? '' : (channelNames.get(video.channelSlug) ?? '')),
    ];
  });

  return insertMany(
    'videos_fts',
    ['video_id', 'title', 'manufacturers', 'models', 'tags', 'description', 'channel'],
    rows,
    { orIgnore: false, rowsPerStatement: 100 },
  );
}

/** Short alias so the generated SQL stays readable inline. */
const sql = (value: SqlValue): string => literal(value);

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

interface Report {
  readonly generatedAt: string;
  readonly summary: CatalogBuildResult['summary'];
  readonly featuredChannels: number;
  readonly sqlFiles: readonly string[];
  readonly issueCounts: ReturnType<typeof summarizeIssues>;
  readonly issues: CatalogBuildResult['issues'];
}

function buildReport(
  result: CatalogBuildResult,
  featuredChannels: number,
  sqlFiles: readonly string[],
): Report {
  return {
    generatedAt: new Date().toISOString(),
    summary: result.summary,
    featuredChannels,
    sqlFiles,
    issueCounts: summarizeIssues(result.issues),
    issues: result.issues,
  };
}

function renderReport(report: Report): string {
  const { summary } = report;
  const lines = [
    '# דוח ייבוא קטלוג',
    '',
    `נוצר: ${report.generatedAt}`,
    '',
    '## סיכום',
    '',
    '| מדד | ערך |',
    '| --- | --- |',
    `| שורות במקור | ${String(summary.sourceRows)} |`,
    `| יובאו | ${String(summary.imported)} |`,
    `| נדחו | ${String(summary.skipped)} |`,
    `| כפילויות | ${String(summary.duplicates)} |`,
    `| שגיאות | ${String(summary.errors)} |`,
    `| אזהרות | ${String(summary.warnings)} |`,
    `| ערוצים | ${String(summary.channels)} |`,
    `| ערוצים מומלצים | ${String(report.featuredChannels)} |`,
    `| תגיות | ${String(summary.tags)} |`,
    `| סרטונים עם זיהוי רכב | ${String(summary.withVehicle)} |`,
    '',
    '## לפי קטגוריה',
    '',
    '| קטגוריה | סרטונים |',
    '| --- | --- |',
    ...Object.entries(summary.perCategory)
      .sort((a, b) => b[1] - a[1])
      .map(([category, count]) => `| ${category} | ${String(count)} |`),
    '',
    '## בעיות לפי סוג',
    '',
    '| רמה | קוד | מופעים |',
    '| --- | --- | --- |',
    ...report.issueCounts.map((row) => `| ${row.level} | ${row.code} | ${String(row.count)} |`),
    '',
    '## קובצי SQL',
    '',
    ...report.sqlFiles.map((file) => `- \`build/catalog/${file}\``),
    '',
  ];
  return lines.join('\n');
}

function printSummary(report: Report, fileCount: number, elapsedMs: number): void {
  const { summary } = report;
  console.log('');
  console.log('  CAR-טיב — catalog import');
  console.log('  ────────────────────────────────');
  console.log(`  source rows       ${String(summary.sourceRows)}`);
  console.log(`  imported          ${String(summary.imported)}`);
  console.log(
    `  skipped           ${String(summary.skipped)} (duplicates: ${String(summary.duplicates)})`,
  );
  console.log(`  channels          ${String(summary.channels)}`);
  console.log(`  tags              ${String(summary.tags)}`);
  console.log(`  with a vehicle    ${String(summary.withVehicle)}`);
  console.log(`  errors / warnings ${String(summary.errors)} / ${String(summary.warnings)}`);
  console.log(`  sql files         ${String(fileCount)} in build/catalog/`);
  console.log(`  took              ${String(Math.round(elapsedMs))} ms`);
  console.log('');
}

await main();
