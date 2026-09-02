/**
 * Generate the static catalog snapshots.
 *
 *     npm run static:build
 *
 * These files are the answer to a question the plan asks directly: what happens
 * if D1 approaches its free-tier limit, or is briefly unavailable? With
 * `STATIC_CATALOG_MODE=true` the Worker serves the reference endpoints from
 * these snapshots instead of the database — same shapes, same URLs, no code
 * change anywhere above the repository layer.
 *
 * They are written to `public/static-data/`, which means they ship with the
 * built site as ordinary static assets: free to serve, and cached at the edge.
 *
 * The snapshots are derived from the same normalised catalog the D1 import
 * uses, so the two cannot disagree about what a category or a channel is.
 */

import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { parseVehicleReference, buildVehicleIndex } from '@shared/core/vehicles.js';
import type { RawVehicleReference } from '@shared/core/vehicles.js';
import { formatDuration } from '@shared/core/duration.js';
import { buildCatalog, type LegacyVideo, type NormalizedVideo } from './lib/legacy-catalog.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const OUT_DIR = path.join(ROOT, 'public', 'static-data');

/** How many videos go into each catalog page file. */
const PAGE_SIZE = 500;

/** Categories, mirroring `seeds/0001_reference_data.sql`. */
const CATEGORIES: readonly { id: string; name: string; description: string; icon: string }[] = [
  {
    id: 'review',
    name: 'סקירות רכב',
    description: 'מבחנים והשוואות',
    icon: 'magnifying-glass-chart',
  },
  { id: 'maintenance', name: 'טיפולים', description: 'תחזוקה שוטפת ומניעתית', icon: 'oil-can' },
  {
    id: 'diy',
    name: 'עשה זאת בעצמך',
    description: 'מדריכי תיקונים ותחזוקה',
    icon: 'screwdriver-wrench',
  },
  {
    id: 'troubleshooting',
    name: 'איתור ותיקון תקלות',
    description: 'אבחון ופתרון בעיות',
    icon: 'microscope',
  },
  {
    id: 'systems',
    name: 'מערכות הרכב',
    description: 'הסברים על מכלולים וטכנולוגיות',
    icon: 'gears',
  },
  {
    id: 'safety',
    name: 'מבחני בטיחות',
    description: 'מבחני ריסוק וציוני בטיחות',
    icon: 'shield-halved',
  },
  { id: 'driving', name: 'נהיגה נכונה', description: 'טיפים לנהיגה בכביש ובשטח', icon: 'road' },
  { id: 'offroad', name: 'שטח ו־4X4', description: 'טיולים, עבירות וחילוצים', icon: 'mountain' },
  {
    id: 'upgrades',
    name: 'שיפורים ושדרוגים',
    description: 'שדרוג הרכב והוספת אביזרים',
    icon: 'rocket',
  },
  {
    id: 'collectors',
    name: 'רכבי אספנות',
    description: 'רכבים נוסטלגיים שחזרו לכביש',
    icon: 'car-side',
  },
];

async function main(): Promise<void> {
  const reference = JSON.parse(
    await readFile(path.join(DATA_DIR, 'reference', 'vehicles.json'), 'utf8'),
  ) as RawVehicleReference;

  const files = await readLegacyFiles(path.join(DATA_DIR, 'videos'));
  const result = buildCatalog(files, {
    knownCategories: CATEGORIES.map((category) => category.id),
    vehicleIndex: buildVehicleIndex(parseVehicleReference(reference)),
    fallbackDate: new Date().toISOString().slice(0, 10),
  });

  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });

  const channelsBySlug = new Map(result.channels.map((channel) => [channel.slug, channel]));
  const categoryNames = new Map(CATEGORIES.map((category) => [category.id, category.name]));

  // Newest first, so page 1 of the snapshot matches page 1 of the live site.
  const videos = [...result.videos].sort((a, b) => b.addedAt.localeCompare(a.addedAt));

  const summaries = videos.map((video) => toSummary(video, channelsBySlug, categoryNames));

  await write('categories.json', {
    data: CATEGORIES.map((category) => ({
      ...category,
      sortOrder: 0,
      isVisible: true,
      videoCount: result.summary.perCategory[category.id] ?? 0,
    })),
    meta: { count: CATEGORIES.length },
    error: null,
  });

  await write('channels.json', {
    data: result.channels.map((channel, index) => ({
      id: index + 1,
      slug: channel.slug,
      name: channel.name,
      description: '',
      imageUrl: channel.imageUrl,
      youtubeUrl: null,
      youtubeChannelId: null,
      isFeatured: false,
      isVisible: true,
      videoCount: channel.videoCount,
    })),
    meta: { count: result.channels.length },
    error: null,
  });

  await write('tags.json', {
    data: result.tags.slice(0, 200).map((tag, index) => ({
      id: index + 1,
      slug: tag.slug,
      name: tag.name,
      videoCount: tag.videoCount,
    })),
    meta: { count: Math.min(200, result.tags.length) },
    error: null,
  });

  await write('recent.json', {
    data: summaries.slice(0, 48),
    meta: { page: 1, limit: 48, total: summaries.length, pages: 1 },
    error: null,
  });

  // The catalog itself, paged. A visitor in static mode browses these.
  const pages = Math.ceil(summaries.length / PAGE_SIZE);
  for (let page = 1; page <= pages; page += 1) {
    await write(`catalog-${String(page).padStart(3, '0')}.json`, {
      data: summaries.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
      meta: { page, limit: PAGE_SIZE, total: summaries.length, pages },
      error: null,
    });
  }

  await write('index.json', {
    generatedAt: new Date().toISOString(),
    videos: summaries.length,
    channels: result.channels.length,
    categories: CATEGORIES.length,
    pageSize: PAGE_SIZE,
    pages,
  });

  console.log('');
  console.log('  Static catalog snapshot');
  console.log('  ────────────────────────────────');
  console.log(`  videos       ${String(summaries.length)}`);
  console.log(`  channels     ${String(result.channels.length)}`);
  console.log(`  catalog pages ${String(pages)} (${String(PAGE_SIZE)} per file)`);
  console.log(`  written to   public/static-data/`);
  console.log('');
}

/** The same `VideoSummary` shape the API returns. */
function toSummary(
  video: NormalizedVideo,
  channels: ReadonlyMap<string, { name: string; imageUrl: string | null }>,
  categoryNames: ReadonlyMap<string, string>,
): Record<string, unknown> {
  const channel = video.channelSlug == null ? null : channels.get(video.channelSlug);

  return {
    id: video.id,
    title: video.title,
    categoryId: video.categoryId,
    categoryName: categoryNames.get(video.categoryId) ?? video.categoryId,
    channel:
      channel == null || video.channelSlug == null
        ? null
        : { slug: video.channelSlug, name: channel.name, imageUrl: channel.imageUrl },
    durationSeconds: video.durationSeconds,
    // Included so a snapshot is readable on its own, without the formatter.
    duration: formatDuration(video.durationSeconds),
    addedAt: video.addedAt,
    publishedAt: null,
    thumbnailUrl: null,
    isHebrew: video.isHebrew,
    isFeatured: false,
    tags: video.tagSlugs.slice(0, 6),
  };
}

async function readLegacyFiles(directory: string) {
  const entries = (await readdir(directory)).filter((name) => name.endsWith('.json')).sort();

  return Promise.all(
    entries.map(async (fileName) => {
      const parsed = JSON.parse(await readFile(path.join(directory, fileName), 'utf8')) as {
        videos?: LegacyVideo[];
      };
      return {
        category: path.basename(fileName, '.json'),
        fileName,
        videos: parsed.videos ?? [],
      };
    }),
  );
}

async function write(name: string, body: unknown): Promise<void> {
  await writeFile(path.join(OUT_DIR, name), JSON.stringify(body), 'utf8');
}

await main();
