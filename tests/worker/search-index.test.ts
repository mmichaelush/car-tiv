/**
 * The search index, and the ways it silently went stale.
 *
 * `videos_fts` is a standalone FTS5 table: the indexed document is a join of
 * title, description, channel, tags and vehicle names, and it is written by
 * application code because a SQLite trigger cannot call `indexText()` — the
 * Hebrew normaliser that index and query must agree on.
 *
 * "Written by application code" is only true if the application actually does
 * it. `migrations/0001_catalog.sql` said a service maintained the index and
 * every write path called it; no such file existed, and no admin write path
 * called anything. An editor could rename a video and the site would show the
 * new title while search kept matching the old one — permanently, because
 * nothing else ever rewrites that row.
 *
 * These tests are the thing that makes the claim true.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AdminRepository } from '@worker/repositories/admin-repository.js';
import { SearchIndexRepository } from '@worker/repositories/search-index-repository.js';
import { VideoRepository } from '@worker/repositories/video-repository.js';
import { EMPTY_QUERY } from '@shared/core/query.js';
import type { VideoQuery } from '@shared/types/catalog.js';
import { createTestDatabase, type TestDatabase } from '../helpers/d1.js';
import { seedCatalog } from '../helpers/fixtures.js';

let db: TestDatabase;
let admin: AdminRepository;
let videos: VideoRepository;
let index: SearchIndexRepository;

beforeEach(async () => {
  db = await createTestDatabase();
  seedCatalog(db);
  admin = new AdminRepository(db);
  videos = new VideoRepository(db);
  index = new SearchIndexRepository(db);
});

afterEach(() => {
  db.close();
});

const search = async (q: string): Promise<string[]> => {
  const query: VideoQuery = { ...EMPTY_QUERY, q };
  const page = await videos.list(query);
  return page.items.map((video) => video.id);
};

describe('reindex after a title change', () => {
  it('finds the video by its new title', async () => {
    expect(await search('קורולה')).toContain('corolla0001');

    await admin.updateVideo('corolla0001', { title: 'החלפת מצתים בסקודה אוקטביה' }, null);
    await index.reindex(['corolla0001']);

    expect(await search('אוקטביה')).toContain('corolla0001');
  });

  it('stops finding it by the old one', async () => {
    // The half everyone forgets. Adding the new text is easy; the index is
    // wrong until the old text is gone. "קורולה" appears only in the original
    // title — not in the tags, the description or the vehicle names — so it is
    // the one word that proves the old document was replaced rather than
    // added to.
    await admin.updateVideo('corolla0001', { title: 'החלפת מצתים בסקודה אוקטביה' }, null);
    await index.reindex(['corolla0001']);

    expect(await search('קורולה')).not.toContain('corolla0001');
  });
});

describe('reindex after a tag change', () => {
  it('picks up a tag an editor added', async () => {
    await admin.addTag(['corolla0001'], 'מצתים', null);
    await index.reindex(['corolla0001']);

    expect(await search('מצתים')).toContain('corolla0001');
  });

  it('drops a tag an editor removed', async () => {
    await admin.addTag(['corolla0001'], 'מצתים', null);
    await index.reindex(['corolla0001']);
    expect(await search('מצתים')).toContain('corolla0001');

    await admin.removeTag(['corolla0001'], 'מצתים', null);
    await index.reindex(['corolla0001']);

    expect(await search('מצתים')).not.toContain('corolla0001');
  });

  it('removes a tag whose name ends in a final Hebrew letter', async () => {
    // The bug this catches: `removeTag` derived its slug with `indexText`,
    // which folds ם to מ for search, while `addTag` stores `slugify`'s output,
    // which does not. Every tag ending in ם, ן, ץ, ף or ך — a large share of
    // Hebrew words — was therefore unremovable, and the button silently did
    // nothing.
    for (const name of ['מצתים', 'בלמים', 'צמיגים']) {
      await admin.addTag(['corolla0002'], name, null);
      const removed = await admin.removeTag(['corolla0002'], name, null);
      expect(removed, `removing ${name}`).toBe(1);
    }
  });
});

describe('what reindex reads', () => {
  it('rebuilds from the database, not from what the caller believed', async () => {
    // Reindexing from a title passed in by the caller would happily write a
    // stale document and nothing would notice. The database is the only thing
    // that is definitely current.
    db.runRaw(`UPDATE videos SET title = ? WHERE id = ?`, 'כותרת חדשה לגמרי', 'corolla0001');
    await index.reindex(['corolla0001']);

    expect(await search('לגמרי')).toContain('corolla0001');
  });

  it('removes the row for a video that no longer exists', async () => {
    // A hard-deleted video whose index row survived would stay findable by
    // search forever, and clicking the result would 404.
    db.runRaw(`DELETE FROM video_tags WHERE video_id = 'corolla0001'`);
    db.runRaw(`DELETE FROM video_vehicle_models WHERE video_id = 'corolla0001'`);
    db.runRaw(`DELETE FROM videos WHERE id = 'corolla0001'`);

    await index.reindex(['corolla0001']);

    expect(db.queryRaw(`SELECT 1 FROM videos_fts WHERE video_id = 'corolla0001'`)).toHaveLength(0);
  });

  it('leaves exactly one index row per video', async () => {
    await index.reindex(['corolla0001']);
    await index.reindex(['corolla0001']);

    expect(db.queryRaw(`SELECT 1 FROM videos_fts WHERE video_id = 'corolla0001'`)).toHaveLength(1);
  });

  it('does nothing when given no ids', async () => {
    const before = db.queryRaw(`SELECT 1 FROM videos_fts`).length;
    await index.reindex([]);
    expect(db.queryRaw(`SELECT 1 FROM videos_fts`)).toHaveLength(before);
  });
});

describe('bulk edits', () => {
  it('applies every field the request schema accepts', async () => {
    // `bulkUpdate` used to apply three of seven fields while the schema
    // accepted all of them, and wrote the whole patch into the audit log — so
    // the log recorded changes that never happened.
    await admin.bulkUpdate(
      ['corolla0001', 'corolla0002'],
      { title: 'כותרת אחידה', isHebrew: false, adminNote: 'נבדק' },
      null,
    );

    const rows = db.queryRaw<{ title: string; is_hebrew: number; admin_note: string }>(
      `SELECT title, is_hebrew, admin_note FROM videos WHERE id IN ('corolla0001','corolla0002')`,
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.title).toBe('כותרת אחידה');
      expect(row.is_hebrew).toBe(0);
      expect(row.admin_note).toBe('נבדק');
    }
  });

  it('writes the audit row with the change, not after it', async () => {
    await admin.bulkUpdate(['corolla0001'], { status: 'hidden' }, null);

    const audit = db.queryRaw<{ action: string }>(
      `SELECT action FROM admin_audit_log WHERE action = 'video.bulk-update'`,
    );
    expect(audit).toHaveLength(1);
  });

  it('changes nothing for a patch with no fields', async () => {
    const changed = await admin.bulkUpdate(['corolla0001'], {}, null);
    expect(changed).toBe(0);
  });
});
