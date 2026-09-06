import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CATALOG = path.join(ROOT, 'build', 'catalog');

/**
 * These run against generated files, which are not committed — `build/catalog`
 * exists only after `npm run catalog:build`. In CI the build step runs first;
 * on a fresh clone it has not, and a suite that failed for that reason would
 * be teaching people to ignore it.
 */
const built = existsSync(CATALOG) && readdirSync(CATALOG).some((n) => n.endsWith('.sql'));
const whenBuilt = built ? describe : describe.skip;

function schema(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  for (const file of readdirSync(path.join(ROOT, 'migrations'))
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    db.exec(readFileSync(path.join(ROOT, 'migrations', file), 'utf8'));
  }
  db.exec(readFileSync(path.join(ROOT, 'seeds', '0001_reference_data.sql'), 'utf8'));
  return db;
}

function catalogFiles(): string[] {
  return readdirSync(CATALOG)
    .filter((name) => name.endsWith('.sql'))
    .sort();
}

function applyAll(db: DatabaseSync): void {
  for (const file of catalogFiles()) db.exec(readFileSync(path.join(CATALOG, file), 'utf8'));
}

function count(db: DatabaseSync, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n;
}

whenBuilt('the generated catalog', () => {
  /**
   * The property the whole paced import rests on.
   *
   * The importer now stops when the day's write budget runs out and resumes on
   * the next deploy, which means a file can be applied twice — once partly,
   * once fully — and `SEED_CATALOG=1` re-applies every file on purpose. All of
   * that is only safe if applying a file changes nothing the second time.
   *
   * It was not. `videos_fts` is a standalone FTS5 table: it has no UNIQUE
   * constraint and ignores `INSERT OR IGNORE`, so a second run added a second
   * document per video and every search that matched one returned it twice.
   * This is the test that would have caught it.
   */
  it('applies twice with no duplicates and no changes', () => {
    const db = schema();
    applyAll(db);

    const tables = [
      'videos',
      'channels',
      'tags',
      'video_tags',
      'video_vehicle_models',
      'manufacturers',
      'vehicle_models',
      'videos_fts',
    ];
    const first = Object.fromEntries(tables.map((table) => [table, count(db, table)]));

    // A fingerprint of the rows themselves, not just how many there are: a
    // second run that replaced a title with a different one would keep the
    // count identical.
    const fingerprint = (): string =>
      JSON.stringify(
        db
          .prepare(
            `SELECT id, title, category_id, duration_seconds, added_at, published_at, status
             FROM videos ORDER BY id LIMIT 200`,
          )
          .all(),
      );
    const before = fingerprint();

    applyAll(db);

    const second = Object.fromEntries(tables.map((table) => [table, count(db, table)]));

    expect(second).toEqual(first);
    expect(fingerprint()).toBe(before);
    db.close();
  });

  it('indexes every video exactly once for search', () => {
    const db = schema();
    applyAll(db);
    applyAll(db);

    const videos = count(db, 'videos');
    const documents = count(db, 'videos_fts');
    expect(documents).toBe(videos);

    // And the search itself returns a video once, which is the symptom a
    // duplicated document actually produces.
    const duplicated = db
      .prepare(
        `SELECT video_id, COUNT(*) AS n FROM videos_fts GROUP BY video_id HAVING n > 1 LIMIT 5`,
      )
      .all();
    expect(duplicated).toEqual([]);
    db.close();
  });

  it('costs more than one day of the free plan, and the manifest says so', () => {
    // Not a limit to enforce — a fact to keep visible. The import was written
    // as a single pass because nobody had this number; it is 3.4 times the
    // daily allowance, so the paced importer is not an optimisation but the
    // only way the catalog can load at all on the free plan.
    const manifestPath = path.join(CATALOG, 'manifest.json');
    if (!existsSync(manifestPath)) return;

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      totalRowsWritten: number;
      dailyLimit: number;
      files: { file: string; estimatedRowsWritten: number }[];
    };

    expect(manifest.files.length).toBe(catalogFiles().length);
    expect(manifest.totalRowsWritten).toBeGreaterThan(manifest.dailyLimit);

    // No single file may need more than a day's budget on its own: the
    // importer applies the first pending file unconditionally to avoid a
    // deadlock, so one oversized file would fail every day for ever.
    for (const entry of manifest.files) {
      expect(entry.estimatedRowsWritten).toBeLessThan(manifest.dailyLimit);
    }
  });
});
