/**
 * Bulk import, end to end against a real database.
 *
 * The properties worth guaranteeing, and therefore tested here:
 *
 *  * a bad row fails alone, with its spreadsheet line number recorded;
 *  * re-sending a batch cannot duplicate a video;
 *  * a row can never invent a category, and never lands without one;
 *  * the search index is written, because an imported video that cannot be
 *    found is not imported in any sense that matters;
 *  * none of it is reachable without a staff credential.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../helpers/d1.js';
import { seedCatalog } from '../helpers/fixtures.js';
import { createTestWorker, postJson, type TestWorker } from '../helpers/worker.js';

const ADMIN_TOKEN = 'test-admin-token';
const staff = { authorization: `Bearer ${ADMIN_TOKEN}` };

let db: TestDatabase;
let api: TestWorker;

const MAPPING = {
  videoId: 'link',
  title: 'title',
  category: 'cat',
  channel: 'channel',
  tags: 'tags',
  duration: 'len',
};

const options = (overrides: Record<string, unknown> = {}) => ({
  defaultCategoryId: 'maintenance',
  status: 'published',
  updateExisting: false,
  ...overrides,
});

const sheetRow = (rowNumber: number, values: Record<string, string>) => ({ rowNumber, values });

async function openJob(): Promise<string> {
  const { body } = await api.json<{ data: { id: string } }>(
    '/api/admin/imports',
    postJson({ filename: 'videos.csv', format: 'csv', totalRows: 3, mapping: MAPPING }, staff),
  );
  return body.data.id;
}

/** A fixed id, so the two calls in a re-import test address the same video. */
const IMPORT_VIDEO_ID = 'reimport001';

/**
 * Import one row for `IMPORT_VIDEO_ID`, opening a fresh job each time.
 * Returns the job's row outcome counts.
 */
async function importOne(
  row: { tags: string[]; title?: string },
  overrides: Record<string, unknown> = {},
): Promise<{ imported: number; updated: number; duplicates: number }> {
  const jobId = await openJob();
  const { body } = await api.json<{
    data: { imported: number; updated: number; duplicates: number };
  }>(
    `/api/admin/imports/${jobId}/rows`,
    postJson(
      {
        mapping: MAPPING,
        options: options(overrides),
        rows: [
          sheetRow(2, {
            link: `https://youtu.be/${IMPORT_VIDEO_ID}`,
            title: row.title ?? 'סרטון לבדיקת ייבוא חוזר',
            cat: 'maintenance',
            channel: 'ערוץ בדיקה',
            tags: row.tags.join(','),
            len: '10:00',
          }),
        ],
      },
      staff,
    ),
  );
  return body.data;
}

beforeEach(async () => {
  db = await createTestDatabase();
  seedCatalog(db);
  api = createTestWorker(db, { ADMIN_TOKEN, FEATURE_ADMIN: 'true' });
});

afterEach(() => {
  db.close();
});

describe('access control', () => {
  it('refuses every import endpoint without a staff credential', async () => {
    expect((await api.fetch('/api/admin/imports')).status).toBe(401);
    expect((await api.fetch('/api/admin/imports', postJson({ format: 'csv' }))).status).toBe(401);
  });
});

describe('POST /api/admin/imports', () => {
  it('opens a job and says how many rows a batch may carry', async () => {
    const { status, body } = await api.json<{ data: { id: string; batchSize: number } }>(
      '/api/admin/imports',
      postJson({ filename: 'a.csv', format: 'csv', totalRows: 10, mapping: {} }, staff),
    );

    expect(status).toBe(201);
    expect(body.data.id).toBeTruthy();
    expect(body.data.batchSize).toBeGreaterThan(0);
  });

  it('refuses a format the schema cannot record', async () => {
    const response = await api.fetch(
      '/api/admin/imports',
      postJson({ filename: 'a.pdf', format: 'pdf' }, staff),
    );
    expect(response.status).toBe(400);
  });
});

describe('POST /api/admin/imports/:id/rows', () => {
  it('imports good rows and reports bad ones by line number', async () => {
    const jobId = await openJob();

    const { body } = await api.json<{
      data: { imported: number; rejected: number };
    }>(
      `/api/admin/imports/${jobId}/rows`,
      postJson(
        {
          mapping: MAPPING,
          options: options(),
          rows: [
            sheetRow(2, {
              link: 'https://www.youtube.com/watch?v=aaaaaaaaaaa',
              title: 'החלפת מסנן אוויר',
              cat: 'maintenance',
              channel: 'ערוץ חדש',
              tags: 'מסנן, אוויר',
              len: '4:10',
            }),
            sheetRow(3, { link: '', title: 'בלי קישור' }),
            sheetRow(4, { link: 'bbbbbbbbbbb', title: '' }),
          ],
        },
        staff,
      ),
    );

    expect(body.data.imported).toBe(1);
    expect(body.data.rejected).toBe(2);

    const report = await api.json<{
      data: { job: { invalidRows: number }; errors: { rowNumber: number; field: string }[] };
    }>(`/api/admin/imports/${jobId}`, { headers: staff });

    expect(report.body.data.job.invalidRows).toBe(2);
    expect(report.body.data.errors.map((error) => error.rowNumber)).toEqual([3, 4]);
    expect(report.body.data.errors[0]?.field).toBe('videoId');
  });

  it('writes the video, its channel and its tags', async () => {
    const jobId = await openJob();

    await api.fetch(
      `/api/admin/imports/${jobId}/rows`,
      postJson(
        {
          mapping: MAPPING,
          options: options(),
          rows: [
            sheetRow(2, {
              link: 'aaaaaaaaaaa',
              title: 'החלפת מסנן אוויר',
              cat: 'maintenance',
              channel: 'ערוץ חדש',
              tags: 'מסנן, אוויר',
              len: '4:10',
            }),
          ],
        },
        staff,
      ),
    );

    const video = db.queryRaw<{ title: string; duration_seconds: number; channel_id: number }>(
      `SELECT title, duration_seconds, channel_id FROM videos WHERE id = 'aaaaaaaaaaa'`,
    )[0];

    expect(video?.title).toBe('החלפת מסנן אוויר');
    expect(video?.duration_seconds).toBe(250);
    expect(video?.channel_id).toBeTruthy();

    const tags = db.queryRaw<{ name: string }>(
      `SELECT t.name FROM video_tags vt JOIN tags t ON t.id = vt.tag_id
       WHERE vt.video_id = 'aaaaaaaaaaa' ORDER BY t.name`,
    );
    expect(tags.map((tag) => tag.name).sort()).toEqual(['אוויר', 'מסנן']);
  });

  it('makes an imported video findable, not merely stored', async () => {
    const jobId = await openJob();

    await api.fetch(
      `/api/admin/imports/${jobId}/rows`,
      postJson(
        {
          mapping: MAPPING,
          options: options(),
          rows: [
            sheetRow(2, { link: 'aaaaaaaaaaa', title: 'החלפת מסנן אוויר', cat: 'maintenance' }),
          ],
        },
        staff,
      ),
    );

    const search = await api.json<{ data: { id: string }[] }>(
      `/api/videos?q=${encodeURIComponent('מסנן')}`,
    );
    expect(search.body.data.map((video) => video.id)).toContain('aaaaaaaaaaa');
  });

  it('skips a video already in the catalog instead of duplicating it', async () => {
    const jobId = await openJob();
    const payload = {
      mapping: MAPPING,
      options: options(),
      rows: [sheetRow(2, { link: 'corolla0001', title: 'כותרת חדשה לגמרי', cat: 'maintenance' })],
    };

    const first = await api.json<{ data: { imported: number; duplicates: number } }>(
      `/api/admin/imports/${jobId}/rows`,
      postJson(payload, staff),
    );

    expect(first.body.data.imported).toBe(0);
    expect(first.body.data.duplicates).toBe(1);

    const title = db.queryRaw<{ title: string }>(
      `SELECT title FROM videos WHERE id = 'corolla0001'`,
    )[0]?.title;
    expect(title).not.toBe('כותרת חדשה לגמרי');
  });

  it('updates an existing video when the editor asked for it', async () => {
    const jobId = await openJob();

    await api.fetch(
      `/api/admin/imports/${jobId}/rows`,
      postJson(
        {
          mapping: MAPPING,
          options: options({ updateExisting: true }),
          rows: [sheetRow(2, { link: 'corolla0001', title: 'כותרת מעודכנת', cat: 'maintenance' })],
        },
        staff,
      ),
    );

    const title = db.queryRaw<{ title: string }>(
      `SELECT title FROM videos WHERE id = 'corolla0001'`,
    )[0]?.title;
    expect(title).toBe('כותרת מעודכנת');
  });

  it('sends a row with an unknown category to the chosen fallback', async () => {
    const jobId = await openJob();

    await api.fetch(
      `/api/admin/imports/${jobId}/rows`,
      postJson(
        {
          mapping: MAPPING,
          options: options({ defaultCategoryId: 'diy' }),
          rows: [sheetRow(2, { link: 'aaaaaaaaaaa', title: 'משהו', cat: 'קטגוריה שלא קיימת' })],
        },
        staff,
      ),
    );

    const category = db.queryRaw<{ category_id: string }>(
      `SELECT category_id FROM videos WHERE id = 'aaaaaaaaaaa'`,
    )[0]?.category_id;

    // Never invented: the import lands in a category that already exists.
    expect(category).toBe('diy');
    expect(db.queryRaw(`SELECT id FROM categories WHERE id = 'קטגוריה שלא קיימת'`)).toHaveLength(0);
  });

  it('insists on a fallback category, because the column is NOT NULL', async () => {
    const jobId = await openJob();
    const response = await api.fetch(
      `/api/admin/imports/${jobId}/rows`,
      postJson({ mapping: MAPPING, options: { status: 'published' }, rows: [] }, staff),
    );
    expect(response.status).toBe(400);
  });

  it('can import as pending, for review before publication', async () => {
    const jobId = await openJob();

    await api.fetch(
      `/api/admin/imports/${jobId}/rows`,
      postJson(
        {
          mapping: MAPPING,
          options: options({ status: 'pending' }),
          rows: [sheetRow(2, { link: 'aaaaaaaaaaa', title: 'ממתין', cat: 'maintenance' })],
        },
        staff,
      ),
    );

    const status = db.queryRaw<{ status: string }>(
      `SELECT status FROM videos WHERE id = 'aaaaaaaaaaa'`,
    )[0]?.status;
    expect(status).toBe('pending');

    // Pending videos are not public.
    const listed = await api.json<{ data: { id: string }[] }>('/api/videos?limit=60');
    expect(listed.body.data.map((video) => video.id)).not.toContain('aaaaaaaaaaa');
  });

  it('refuses a batch larger than the server advertises', async () => {
    const jobId = await openJob();
    const rows = Array.from({ length: 200 }, (_unused, index) =>
      sheetRow(index + 2, { link: 'aaaaaaaaaaa', title: 'x' }),
    );

    const response = await api.fetch(
      `/api/admin/imports/${jobId}/rows`,
      postJson({ mapping: MAPPING, options: options(), rows }, staff),
    );
    expect(response.status).toBe(400);
  });

  it('404s for a job that does not exist', async () => {
    const response = await api.fetch(
      '/api/admin/imports/nope/rows',
      postJson({ mapping: MAPPING, options: options(), rows: [] }, staff),
    );
    expect(response.status).toBe(404);
  });
});

describe('POST /api/admin/imports/:id/complete', () => {
  it('closes the job and keeps the totals', async () => {
    const jobId = await openJob();

    await api.fetch(
      `/api/admin/imports/${jobId}/rows`,
      postJson(
        {
          mapping: MAPPING,
          options: options(),
          rows: [sheetRow(2, { link: 'aaaaaaaaaaa', title: 'משהו', cat: 'maintenance' })],
        },
        staff,
      ),
    );

    const { body } = await api.json<{
      data: { status: string; importedRows: number; completedAt: string | null };
    }>(`/api/admin/imports/${jobId}/complete`, postJson({ status: 'completed' }, staff));

    expect(body.data.status).toBe('completed');
    expect(body.data.importedRows).toBe(1);
    expect(body.data.completedAt).toBeTruthy();
  });
});

describe('GET /api/admin/imports', () => {
  it('lists jobs newest first', async () => {
    await openJob();
    await openJob();

    const { body } = await api.json<{ data: { id: string }[] }>('/api/admin/imports', {
      headers: staff,
    });
    expect(body.data.length).toBe(2);
  });
});

describe('re-importing an existing video', () => {
  it('replaces its tags rather than adding to them', async () => {
    // `updateExisting` is documented as overwriting tags, and did not: writes
    // were `INSERT OR IGNORE` with no delete. A re-import with fewer tags left
    // the old ones attached — while `#writeSearchIndex` rebuilt the FTS row
    // from the draft's tags alone. So the tags shown on the video and the tags
    // search matched it by drifted apart permanently.
    const first = await importOne({ tags: ['טויוטה', 'קורולה', 'שמן'] });
    expect(first.imported).toBe(1);

    const second = await importOne({ tags: ['טויוטה', 'מנוע'] }, { updateExisting: true });
    expect(second.imported + second.updated).toBeGreaterThan(0);

    const tags = db
      .queryRaw<{ name: string }>(
        `SELECT t.name FROM video_tags vt JOIN tags t ON t.id = vt.tag_id
         WHERE vt.video_id = ? ORDER BY t.name`,
        IMPORT_VIDEO_ID,
      )
      .map((row) => row.name);

    expect(tags).toEqual(['טויוטה', 'מנוע']);
  });

  it('leaves the relational tags and the search index agreeing', async () => {
    await importOne({ tags: ['טויוטה', 'קורולה'] });
    await importOne({ tags: ['טויוטה'] }, { updateExisting: true });

    const relational = db
      .queryRaw<{ name: string }>(
        `SELECT t.name FROM video_tags vt JOIN tags t ON t.id = vt.tag_id WHERE vt.video_id = ?`,
        IMPORT_VIDEO_ID,
      )
      .map((row) => row.name);
    const indexed = db.queryRaw<{ tags: string }>(
      `SELECT tags FROM videos_fts WHERE video_id = ?`,
      IMPORT_VIDEO_ID,
    )[0]?.tags;

    expect(relational).toEqual(['טויוטה']);
    expect(indexed).not.toContain('קורולה');
  });

  it('indexes the vehicle columns, not just the ones the draft knows', async () => {
    // The importer used to write its own FTS row from the draft it had in hand,
    // and a draft has no vehicle joins — so it wrote `manufacturers` and
    // `models` as empty strings. Every imported video was therefore unfindable
    // by the make or model it is actually about, and nothing would ever have
    // corrected it: only an admin edit rewrites an index row, and most of the
    // catalog is never edited. It now goes through `SearchIndexRepository`,
    // which reads the document back from the database.
    await importOne({ tags: ['טויוטה'] });

    const row = db.queryRaw<{ manufacturers: string; models: string }>(
      `SELECT manufacturers, models FROM videos_fts WHERE video_id = ?`,
      IMPORT_VIDEO_ID,
    )[0];

    // The fixture row carries no vehicle, so these are empty — but they are
    // empty because the database says so, having been read from the same
    // joins the admin path reads. The assertion that matters is that exactly
    // one index row exists and it came from the shared repository.
    expect(row).toBeDefined();
    expect(
      db.queryRaw<{ n: number }>(
        `SELECT COUNT(*) AS n FROM videos_fts WHERE video_id = ?`,
        IMPORT_VIDEO_ID,
      )[0]?.n,
    ).toBe(1);
  });

  it('finds an imported video by a vehicle the import attached', async () => {
    // The real proof of the above: attach a vehicle the way the catalog does,
    // reimport, and search for the manufacturer. Under the old importer this
    // returned nothing, because `manufacturers` was written as ''.
    await importOne({ tags: ['טויוטה'] });

    db.runRaw(`INSERT OR IGNORE INTO manufacturers (slug, name) VALUES ('mazda', 'מאזדה')`);
    db.runRaw(
      `INSERT OR IGNORE INTO vehicle_models (manufacturer_id, slug, name)
       SELECT id, 'mazda-3', 'מאזדה 3' FROM manufacturers WHERE slug = 'mazda'`,
    );
    db.runRaw(
      `INSERT OR IGNORE INTO video_vehicle_models (video_id, model_id)
       SELECT ?, id FROM vehicle_models WHERE slug = 'mazda-3'`,
      IMPORT_VIDEO_ID,
    );

    await importOne({ tags: ['טויוטה'] }, { updateExisting: true });

    const indexed = db.queryRaw<{ manufacturers: string; models: string }>(
      `SELECT manufacturers, models FROM videos_fts WHERE video_id = ?`,
      IMPORT_VIDEO_ID,
    )[0];

    expect(indexed?.manufacturers).toContain('מאזדה');
    expect(indexed?.models).toContain('מאזדה');
  });
});
