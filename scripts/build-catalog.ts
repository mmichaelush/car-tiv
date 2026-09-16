import { createHash } from 'node:crypto';
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
  CATALOG_EPOCH,
  type CatalogBuildResult,
  type LegacySourceFile,
  type LegacyVideo,
  buildCatalog,
  summarizeIssues,
} from './lib/legacy-catalog.js';
import { chunkStatements, insertMany, literal, type SqlValue } from './lib/sql.js';
// The counter SQL has exactly one definition; see the note at its use below.
import { COUNTER_REFRESH } from '../worker/repositories/counters-repository.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const digest = (text: string): string =>
  createHash('sha256').update(text).digest('hex').slice(0, 16);

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
  readonly id?: string;
  readonly youtubeChannelId?: string;
  readonly netfreeOpen?: boolean;
  readonly hasHebrewVideos?: boolean;
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
    fallbackDate: CATALOG_EPOCH,
  });

  const featured = await readFeaturedChannels(path.join(DATA_DIR, 'featured_channels.json'));

  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });

  for (const channel of result.channels) {
    if (channel.sourceId != null && !featured.has(channel.sourceId)) {
      throw new Error('Unknown channel identity: ' + channel.sourceId);
    }
  }
  const revision = digest(JSON.stringify([result.videos, [...featured]]));
  const groups = buildStatementGroups(result, manufacturers, featured, revision);
  const written: string[] = [];
  let fileIndex = 1;

  for (const group of groups) {
    for (const contents of chunkStatements(group.statements)) {
      const name = `${String(fileIndex).padStart(4, '0')}_${group.name}_${digest(contents)}.sql`;
      await writeFile(path.join(OUT_DIR, name), `-- ${group.title}\n\n${contents}`, 'utf8');
      written.push(name);
      fileIndex += 1;
    }
  }

  // Bound the expensive tag updates so each file fits the daily write budget.
  // Slug lookups use the unique index and also work against an existing database.
  const counterStatements: string[] = [COUNTER_REFRESH.categories, COUNTER_REFRESH.channels];
  for (let start = 0; start < result.tags.length; start += 1000) {
    const slugs = result.tags.slice(start, start + 1000).map((tag) => sql(tag.slug));
    counterStatements.push(COUNTER_REFRESH.tags + ` AND slug IN (${slugs.join(', ')})`);
  }
  // This final pass clears counts on old tags absent from the package.
  counterStatements.push(
    COUNTER_REFRESH.tags,
    COUNTER_REFRESH.categoryTagsUpsert,
    COUNTER_REFRESH.categoryTagsDelete,
    COUNTER_REFRESH.totals +
      "; UPDATE catalog_counters SET value = 0 WHERE key = 'maintenance.catalogDirty' AND value <> 0",
  );
  for (const statement of counterStatements) {
    const contents = `-- Counters for catalog ${revision}\n${statement};\n`;
    const name = `${String(fileIndex++).padStart(4, '0')}_counters_${digest(contents)}.sql`;
    await writeFile(path.join(OUT_DIR, name), contents, 'utf8');
    written.push(name);
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
    const slug = row.id ?? slugify(row.channel_name ?? '');
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
  revision: string,
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
      highlight?.channel_name ?? channel.name,
      channel.imageUrl ?? highlight?.channel_image_url ?? null,
      highlight?.channel_url ?? null,
      highlight?.content_description ?? '',
      highlight?.netfreeOpen === true,
      highlight != null ? order : 0,
      channel.sourceId,
      highlight?.youtubeChannelId ?? null,
      highlight?.netfreeOpen ?? null,
      highlight?.hasHebrewVideos ?? null,
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
      row.netfreeOpen === true,
      extraOrder,
      row.id ?? null,
      row.youtubeChannelId ?? null,
      row.netfreeOpen ?? null,
      row.hasHebrewVideos ?? null,
    ]);
  }

  groups.push({
    name: 'channels',
    title: `Channels (${String(channelRows.length)})`,
    statements: insertMany(
      'channels',
      [
        'slug',
        'name',
        'image_url',
        'youtube_url',
        'description',
        'is_featured',
        'featured_order',
        'source_id',
        'youtube_channel_id',
        'netfree_open',
        'has_hebrew_videos',
      ],
      channelRows,
      { orIgnore: false },
    ).map((statement) =>
      statement.replace(
        /;$/,
        ` ON CONFLICT(slug) DO UPDATE SET
      name=excluded.name, image_url=excluded.image_url, youtube_url=excluded.youtube_url,
      description=excluded.description, is_featured=excluded.is_featured,
      featured_order=excluded.featured_order, source_id=excluded.source_id,
      youtube_channel_id=excluded.youtube_channel_id, netfree_open=excluded.netfree_open,
      has_hebrew_videos=excluded.has_hebrew_videos;`,
      ),
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
    statements: buildVideoStatements(result, revision),
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

  groups.push({
    name: 'reconcile',
    title: 'Retire rows absent from this package',
    statements: [
      `UPDATE videos SET status = 'hidden', updated_at = CURRENT_TIMESTAMP
      WHERE catalog_revision IS NOT ${sql(revision)} AND status = 'published';`,
      `UPDATE channels SET is_visible = 0 WHERE is_visible = 1 AND
      (source_id IS NULL OR source_id NOT IN (${[...featured.keys()].map(sql).join(', ')}));`,
    ],
  });
  return groups;
}

function buildVideoStatements(result: CatalogBuildResult, revision: string): string[] {
  // channel_id is resolved from the slug at insert time, so this file never
  // hard-codes an autoincrement id.
  return result.videos.map((video) => {
    const channel =
      video.channelSlug == null
        ? 'NULL'
        : `(SELECT id FROM channels WHERE slug = ${sql(video.channelSlug)})`;

    // The final package is authoritative for imported metadata.
    return (
      `INSERT INTO videos\n` +
      `  (id, title, description, category_id, channel_id, duration_seconds, language, is_hebrew, added_at, published_at, netfree_open, catalog_revision, status)\n` +
      `  VALUES (${sql(video.id)}, ${sql(video.title)}, ${sql(video.description)}, ` +
      `${sql(video.categoryId)}, ${channel}, ${String(video.durationSeconds)}, ` +
      `${sql(video.language)}, ${video.isHebrew ? '1' : '0'}, ${sql(video.addedAt)}, ` +
      `${video.publishedAt == null ? 'NULL' : sql(video.publishedAt)}, ${sql(video.netfreeOpen)}, ${sql(revision)}, 'published')\n` +
      `  ON CONFLICT (id) DO UPDATE SET title=excluded.title, description=excluded.description,
        category_id=excluded.category_id, channel_id=excluded.channel_id,
        duration_seconds=excluded.duration_seconds, language=excluded.language,
        is_hebrew=excluded.is_hebrew, added_at=excluded.added_at,
        published_at=excluded.published_at, netfree_open=excluded.netfree_open, catalog_revision=excluded.catalog_revision;`
    );
  });
}

function buildVideoTagStatements(result: CatalogBuildResult): string[] {
  const statements: string[] = [];
  for (const video of result.videos) {
    statements.push(`DELETE FROM video_tags WHERE video_id = ${sql(video.id)};`);
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
    statements.push(`DELETE FROM video_vehicle_models WHERE video_id = ${sql(video.id)};`);
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

  const columns = [
    'video_id',
    'title',
    'manufacturers',
    'models',
    'tags',
    'description',
    'channel',
  ];
  const inserts = insertMany('videos_fts', columns, rows, {
    orIgnore: false,
    rowsPerStatement: 100,
  });

  // Delete before insert — the one place in the generated catalog that is not
  // idempotent on its own.
  //
  // `videos_fts` is a standalone FTS5 table. FTS5 has no UNIQUE constraint and
  // ignores `INSERT OR IGNORE`, so applying a search-index file twice does not
  // replace those documents, it adds a second copy of each: the same video
  // then matches twice, and every search that finds it returns it twice.
  //
  // That mattered the moment the import stopped being a single run. A file
  // interrupted by the daily write limit is re-applied on the next deploy, and
  // "re-apply what did not finish" is only safe if re-applying is a no-op.
  // Pairing each batch with a delete of exactly the ids it is about to write
  // makes it one, at the cost of one statement per hundred rows.
  const statements: string[] = [];
  for (let start = 0; start < rows.length; start += 100) {
    const ids = rows.slice(start, start + 100).map((row) => sql(row[0] ?? ''));
    statements.push(`DELETE FROM videos_fts WHERE video_id IN (${ids.join(', ')});`);
    const insert = inserts[start / 100];
    if (insert != null) statements.push(insert);
  }
  return statements;
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
