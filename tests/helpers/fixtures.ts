/**
 * A small, fixed catalog used by the repository and route tests.
 *
 * Nine videos is enough to exercise every filter, the ranking rules and the
 * pagination edges, and small enough that a failing assertion is readable. The
 * data deliberately mirrors the real catalog's shape: Hebrew titles, a channel
 * shared by several videos, tags, and vehicles with model years.
 */

import { indexText } from '@shared/core/text.js';
import type { TestDatabase } from './d1.js';

export interface SeedVideo {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly category: string;
  readonly channel?: string;
  readonly durationSeconds?: number;
  readonly addedAt?: string;
  readonly isHebrew?: boolean;
  readonly isFeatured?: boolean;
  readonly tags?: readonly string[];
  readonly vehicle?: { manufacturer: string; model: string; year?: number };
}

/** The default dataset. Ids are valid 11-character YouTube ids. */
export const SEED_VIDEOS: readonly SeedVideo[] = [
  {
    id: 'corolla0001',
    title: 'החלפת שמן בטויוטה קורולה 2015',
    description: 'מדריך מלא להחלפת שמן מנוע',
    category: 'maintenance',
    channel: 'auto-il',
    durationSeconds: 522,
    addedAt: '2026-08-20',
    tags: ['שמן מנוע', 'טיפול'],
    vehicle: { manufacturer: 'toyota', model: 'corolla', year: 2015 },
  },
  {
    id: 'corolla0002',
    title: 'טויוטה קורולה 2015 - מבחן דרכים',
    category: 'review',
    channel: 'auto-il',
    durationSeconds: 900,
    addedAt: '2026-08-15',
    isFeatured: true,
    tags: ['מבחן דרכים'],
    vehicle: { manufacturer: 'toyota', model: 'corolla', year: 2015 },
  },
  {
    id: 'yaris000001',
    title: 'טויוטה יאריס - סקירה',
    category: 'review',
    channel: 'auto-il',
    durationSeconds: 600,
    addedAt: '2026-08-10',
    tags: ['מבחן דרכים'],
    vehicle: { manufacturer: 'toyota', model: 'yaris' },
  },
  {
    id: 'i4000000001',
    title: 'יונדאי i40 2012 - טיפול גדול',
    category: 'maintenance',
    channel: 'garage-tv',
    durationSeconds: 1_500,
    addedAt: '2026-08-05',
    tags: ['שמן מנוע', 'טיפול'],
    vehicle: { manufacturer: 'hyundai', model: 'i40', year: 2012 },
  },
  {
    id: 'brakes00001',
    title: 'החלפת רפידות בלמים - מדריך',
    category: 'diy',
    channel: 'garage-tv',
    durationSeconds: 780,
    addedAt: '2026-07-30',
    tags: ['בלמים', 'עשה זאת בעצמך'],
  },
  {
    id: 'english0001',
    title: 'How to change your oil',
    description: 'A complete guide',
    category: 'diy',
    channel: 'chrisfix',
    durationSeconds: 1_200,
    addedAt: '2026-07-20',
    isHebrew: false,
    tags: ['oil change'],
  },
  {
    id: 'short000001',
    title: 'טיפ מהיר לחורף',
    category: 'safety',
    channel: 'auto-il',
    durationSeconds: 59,
    addedAt: '2026-07-10',
    tags: ['בטיחות'],
  },
  {
    id: 'offroad0001',
    title: 'נהיגת שטח - חילוץ עצמי',
    category: 'offroad',
    channel: 'shvilim',
    durationSeconds: 2_400,
    addedAt: '2026-06-01',
    tags: ['שטח'],
  },
  {
    id: 'hidden00001',
    title: 'סרטון מוסתר',
    category: 'review',
    channel: 'auto-il',
    addedAt: '2026-08-25',
    tags: [],
  },
];

export interface SeedOptions {
  readonly videos?: readonly SeedVideo[];
  /** Ids to store with a non-published status, so tests can prove they hide. */
  readonly hiddenIds?: readonly string[];
}

/**
 * Insert the fixture catalog, including channels, tags, vehicles and the
 * search index — the same rows `scripts/build-catalog.ts` produces.
 */
export function seedCatalog(db: TestDatabase, options: SeedOptions = {}): void {
  const videos = options.videos ?? SEED_VIDEOS;
  const hidden = new Set(options.hiddenIds ?? ['hidden00001']);

  const channelIds = new Map<string, number>();
  const tagIds = new Map<string, number>();
  const modelIds = new Map<string, number>();

  const channelName = (slug: string): string =>
    ({
      'auto-il': 'Auto IL | אוטו',
      'garage-tv': 'Garage TV | מוסך',
      chrisfix: 'ChrisFix',
      shvilim: 'שבילים',
    })[slug] ?? slug;

  for (const video of videos) {
    if (video.channel == null || channelIds.has(video.channel)) continue;
    db.runRaw(
      `INSERT INTO channels (slug, name, is_featured) VALUES (?, ?, ?)`,
      video.channel,
      channelName(video.channel),
      video.channel === 'auto-il' ? 1 : 0,
    );
    const [row] = db.queryRaw<{ id: number }>(
      `SELECT id FROM channels WHERE slug = ?`,
      video.channel,
    );
    channelIds.set(video.channel, row?.id ?? 0);
  }

  const makes = new Map<string, number>();
  for (const video of videos) {
    const vehicle = video.vehicle;
    if (vehicle == null) continue;

    if (!makes.has(vehicle.manufacturer)) {
      db.runRaw(
        `INSERT INTO manufacturers (slug, name) VALUES (?, ?)`,
        vehicle.manufacturer,
        vehicle.manufacturer,
      );
      const [row] = db.queryRaw<{ id: number }>(
        `SELECT id FROM manufacturers WHERE slug = ?`,
        vehicle.manufacturer,
      );
      makes.set(vehicle.manufacturer, row?.id ?? 0);
    }

    const key = `${vehicle.manufacturer}/${vehicle.model}`;
    if (!modelIds.has(key)) {
      db.runRaw(
        `INSERT INTO vehicle_models (manufacturer_id, slug, name) VALUES (?, ?, ?)`,
        makes.get(vehicle.manufacturer) ?? 0,
        vehicle.model,
        vehicle.model,
      );
      const [row] = db.queryRaw<{ id: number }>(
        `SELECT id FROM vehicle_models WHERE manufacturer_id = ? AND slug = ?`,
        makes.get(vehicle.manufacturer) ?? 0,
        vehicle.model,
      );
      modelIds.set(key, row?.id ?? 0);
    }
  }

  for (const video of videos) {
    db.runRaw(
      `INSERT INTO videos (id, title, description, category_id, channel_id, duration_seconds,
                           language, is_hebrew, is_featured, added_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      video.id,
      video.title,
      video.description ?? '',
      video.category,
      video.channel == null ? null : (channelIds.get(video.channel) ?? null),
      video.durationSeconds ?? 0,
      video.isHebrew === false ? 'en' : 'he',
      video.isHebrew === false ? 0 : 1,
      video.isFeatured === true ? 1 : 0,
      video.addedAt ?? '2026-01-01',
      hidden.has(video.id) ? 'hidden' : 'published',
    );

    for (const tag of video.tags ?? []) {
      const slug = indexText(tag).replace(/\s+/g, '-');
      if (!tagIds.has(slug)) {
        db.runRaw(`INSERT OR IGNORE INTO tags (slug, name) VALUES (?, ?)`, slug, tag);
        const [row] = db.queryRaw<{ id: number }>(`SELECT id FROM tags WHERE slug = ?`, slug);
        tagIds.set(slug, row?.id ?? 0);
      }
      db.runRaw(
        `INSERT OR IGNORE INTO video_tags (video_id, tag_id) VALUES (?, ?)`,
        video.id,
        tagIds.get(slug) ?? 0,
      );
    }

    const vehicle = video.vehicle;
    if (vehicle != null) {
      db.runRaw(
        `INSERT INTO video_vehicle_models (video_id, model_id, year_from, year_to) VALUES (?, ?, ?, ?)`,
        video.id,
        modelIds.get(`${vehicle.manufacturer}/${vehicle.model}`) ?? 0,
        vehicle.year ?? null,
        vehicle.year ?? null,
      );
    }

    db.runRaw(
      `INSERT INTO videos_fts (video_id, title, manufacturers, models, tags, description, channel)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      video.id,
      indexText(video.title),
      indexText(vehicle?.manufacturer ?? ''),
      indexText(vehicle?.model ?? ''),
      indexText((video.tags ?? []).join(' ')),
      indexText(video.description ?? ''),
      indexText(video.channel == null ? '' : channelName(video.channel)),
    );
  }

  refreshCounters(db);
}

/**
 * Recompute the maintained counters, the way an import or the hourly cron does.
 *
 * Seeding calls this, so a fixture database is in the state production is in
 * for all but the first hour of its life: counts stored, not computed. A test
 * that wants to prove what happens *before* the first refresh — that the site
 * falls back to a real count rather than reporting an empty catalog — resets
 * them with `clearCounters` instead.
 *
 * The statements are the ones in `CountersRepository`. They are duplicated here
 * rather than imported because the repository is async and these helpers are
 * synchronous, and there is a test that runs the repository itself against this
 * same fixture to prove the two agree.
 */
export function refreshCounters(db: TestDatabase): void {
  db.runRaw(`UPDATE categories SET video_count = (
    SELECT COUNT(*) FROM videos v WHERE v.category_id = categories.id
      AND v.status = 'published' AND v.deleted_at IS NULL)`);
  db.runRaw(`UPDATE channels SET video_count = (
    SELECT COUNT(*) FROM videos v WHERE v.channel_id = channels.id
      AND v.status = 'published' AND v.deleted_at IS NULL)`);
  db.runRaw(`UPDATE tags SET video_count = (
    SELECT COUNT(*) FROM video_tags vt JOIN videos v ON v.id = vt.video_id
      WHERE vt.tag_id = tags.id AND v.status = 'published' AND v.deleted_at IS NULL)`);

  db.runRaw(`DELETE FROM category_tag_counts`);
  // The fixture is nine videos, so the production threshold of "at least two
  // videos" would leave the table almost empty and make the category-scoped
  // tag panel untestable. Every pair is stored here instead.
  db.runRaw(`INSERT INTO category_tag_counts (category_id, tag_id, video_count)
    SELECT v.category_id, vt.tag_id, COUNT(*)
    FROM video_tags vt JOIN videos v ON v.id = vt.video_id JOIN tags t ON t.id = vt.tag_id
    WHERE v.status = 'published' AND v.deleted_at IS NULL AND t.is_visible = 1
    GROUP BY v.category_id, vt.tag_id`);

  db.runRaw(`INSERT INTO catalog_counters (key, value, updated_at)
    SELECT 'videos.live',
      (SELECT COUNT(*) FROM videos WHERE status = 'published' AND deleted_at IS NULL),
      CURRENT_TIMESTAMP
    UNION ALL SELECT 'videos.addedThisWeek',
      (SELECT COUNT(*) FROM videos WHERE status = 'published' AND deleted_at IS NULL
        AND added_at >= date('now', '-7 days')), CURRENT_TIMESTAMP
    UNION ALL SELECT 'channels.visible',
      (SELECT COUNT(*) FROM channels WHERE is_visible = 1), CURRENT_TIMESTAMP
    UNION ALL SELECT 'categories.visible',
      (SELECT COUNT(*) FROM categories WHERE is_visible = 1), CURRENT_TIMESTAMP
    UNION ALL SELECT 'tags.visible',
      (SELECT COUNT(*) FROM tags WHERE is_visible = 1 AND video_count > 0), CURRENT_TIMESTAMP
    ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`);
}

/** Put the counters back to their never-refreshed state. */
export function clearCounters(db: TestDatabase): void {
  db.runRaw(`UPDATE categories SET video_count = 0`);
  db.runRaw(`UPDATE channels SET video_count = 0`);
  db.runRaw(`UPDATE tags SET video_count = 0`);
  db.runRaw(`DELETE FROM category_tag_counts`);
  db.runRaw(`UPDATE catalog_counters SET value = 0`);
}
