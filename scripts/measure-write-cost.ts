/**
 * What the generated catalog costs in D1 `rows_written`, per file.
 *
 *     npm run catalog:cost
 *
 * ## Why this exists
 *
 * D1's free plan allows 100,000 rows written per day, per account. The site's
 * *running* cost was measured to death — bound parameters, queries per
 * invocation, rows read per endpoint, the write cost of the counters — and the
 * one thing that was never measured was the import that fills the database in
 * the first place. It went over the daily limit on the first deploy that ran
 * it, which is a thing this repository had the habit and the tooling to catch
 * and simply had not pointed at the importer.
 *
 * ## Why a row is not a row
 *
 * Cloudflare counts a write to an index as a row written, so inserting into a
 * table with six indexes costs seven. That is the whole reason the naive
 * estimate — "7,876 videos, so 7,876 writes" — is off by an order of
 * magnitude. This walks the real schema, counts the indexes SQLite actually
 * created for each table (including the implicit ones behind PRIMARY KEY and
 * UNIQUE, which `sqlite_master` lists with an `sqlite_autoindex_` name), and
 * multiplies.
 *
 * FTS5 is counted separately: one document becomes rows in the `_data`,
 * `_idx`, `_content` and `_docsize` shadow tables, so its cost is measured by
 * counting those rows directly rather than guessed at.
 *
 * ## What it produces
 *
 * `build/catalog/manifest.json` — one entry per file, with the rows it writes
 * and what they cost. `scripts/ci-database.ts` reads it to decide how much of
 * the catalog it may import today, and `tests/scripts/catalog-cost.test.ts`
 * fails if the total moves without anyone noticing.
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { PLAN_LIMITS } from '../shared/constants.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const MIGRATIONS = path.join(ROOT, 'migrations');
const CATALOG = path.join(ROOT, 'build', 'catalog');

/** One generated file and what applying it costs. */
export interface CatalogFileCost {
  readonly file: string;
  /** Rows the file adds to ordinary tables. */
  readonly logicalRows: number;
  /** Those rows plus the index writes they cause, plus FTS shadow rows. */
  readonly estimatedRowsWritten: number;
  /** Per-table detail, for working out where a jump came from. */
  readonly tables: Readonly<Record<string, number>>;
}

export interface CatalogManifest {
  readonly generatedAt: string;
  readonly dailyLimit: number;
  readonly totalRowsWritten: number;
  readonly files: readonly CatalogFileCost[];
}

/**
 * Tables SQLite keeps for an FTS5 index, and which of them grow per document.
 *
 * Counted rather than modelled: the number of `_data` rows per document
 * depends on the tokenizer, the text and the segment merges FTS5 decides to
 * do, and no constant would survive a change to any of them.
 */
const FTS_SHADOW = [
  'videos_fts_data',
  'videos_fts_idx',
  'videos_fts_docsize',
  'videos_fts_content',
];

/**
 * The schema and the reference rows, which is the state a catalog import
 * actually starts from — every video names a category, and without those rows
 * the first file fails on a foreign key rather than measuring anything.
 */
function openWithSchema(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  const files = readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  for (const file of files) db.exec(readFileSync(path.join(MIGRATIONS, file), 'utf8'));
  db.exec(readFileSync(path.join(ROOT, 'seeds', '0001_reference_data.sql'), 'utf8'));
  return db;
}

/** Every ordinary table, and how many indexes a write to it also touches. */
function indexCost(db: DatabaseSync): Map<string, number> {
  const tables = db
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%'`,
    )
    .all() as { name: string }[];

  const cost = new Map<string, number>();
  for (const { name } of tables) {
    const indexes = db
      .prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index' AND tbl_name = ?`)
      .get(name) as { n: number };
    // The row itself, plus one per index it appears in.
    cost.set(name, 1 + indexes.n);
  }
  return cost;
}

function rowCounts(db: DatabaseSync, tables: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const table of tables) {
    try {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number };
      counts.set(table, row.n);
    } catch {
      // A shadow table that does not exist in this schema version.
      counts.set(table, 0);
    }
  }
  return counts;
}

export function measure(): CatalogManifest {
  const db = openWithSchema();
  const perIndex = indexCost(db);
  const watched = [...perIndex.keys(), ...FTS_SHADOW];

  const files = readdirSync(CATALOG)
    .filter((name) => name.endsWith('.sql'))
    .sort();

  const results: CatalogFileCost[] = [];
  let before = rowCounts(db, watched);
  const mutations = new Map<string, number>();
  db.function('audit_catalog_write', (table) => {
    const name = String(table);
    mutations.set(name, (mutations.get(name) ?? 0) + 1);
    return 0;
  });
  for (const table of perIndex.keys()) {
    for (const action of ['INSERT', 'UPDATE', 'DELETE']) {
      db.exec(`CREATE TEMP TRIGGER audit_${table}_${action} AFTER ${action} ON "${table}"
        BEGIN SELECT audit_catalog_write('${table}'); END;`);
    }
  }
  const totalChanges = (): number =>
    Number((db.prepare('SELECT total_changes() AS n').get() as { n: number }).n);

  for (const pass of [0, 1]) {
    for (const file of files) {
      mutations.clear();
      const changesBefore = totalChanges();
      db.exec(readFileSync(path.join(CATALOG, file), 'utf8'));
      const after = rowCounts(db, watched);

      const tables: Record<string, number> = {};
      let logical = 0;
      let written = 0;

      for (const [table, changed] of mutations) {
        tables[table] = changed;
        logical += changed;
        written += changed * (perIndex.get(table) ?? 1);
      }
      // SQLite total_changes includes FTS shadow mutations, including rewrites
      // and deletes which net table-size growth cannot measure.
      const shadowWrites = Math.max(0, totalChanges() - changesBefore - logical);
      written += shadowWrites;
      for (const table of FTS_SHADOW) {
        tables[table] = Math.max(0, (after.get(table) ?? 0) - (before.get(table) ?? 0));
      }

      const measured = {
        file,
        logicalRows: logical,
        estimatedRowsWritten: written,
        tables,
      };
      if (pass === 0) results.push(measured);
      else {
        const index = results.findIndex((entry) => entry.file === file);
        if (written > (results[index]?.estimatedRowsWritten ?? 0)) results[index] = measured;
      }
      before = after;
    }
  }

  db.close();

  return {
    generatedAt: new Date().toISOString(),
    dailyLimit: PLAN_LIMITS.rowsWrittenPerDay,
    totalRowsWritten: results.reduce((sum, entry) => sum + entry.estimatedRowsWritten, 0),
    files: results,
  };
}

function main(): void {
  const manifest = measure();
  const target = path.join(CATALOG, 'manifest.json');
  writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const limit = manifest.dailyLimit;
  const days = Math.ceil(manifest.totalRowsWritten / limit);

  console.log(`\nCatalog write cost — ${String(manifest.files.length)} files\n`);
  for (const entry of manifest.files) {
    if (entry.estimatedRowsWritten === 0) continue;
    console.log(
      `  ${entry.file.padEnd(34)} ${String(entry.logicalRows).padStart(7)} rows` +
        ` → ${String(entry.estimatedRowsWritten).padStart(8)} written`,
    );
  }

  console.log(
    `\n  total ${manifest.totalRowsWritten.toLocaleString('en')} rows written,` +
      ` against a daily free-plan limit of ${limit.toLocaleString('en')}.`,
  );
  console.log(`  A full import therefore needs at least ${String(days)} days on the free plan.\n`);
  console.log(`  Written to build/catalog/manifest.json`);
}

if (process.argv[1]?.endsWith('measure-write-cost.ts') === true) {
  main();
}
