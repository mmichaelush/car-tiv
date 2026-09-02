/**
 * A `D1Database` implementation backed by `node:sqlite`.
 *
 * Repository tests run against the real migrations and the real SQL — including
 * FTS5 — instead of a mock that would happily accept a query D1 would reject.
 * `node:sqlite` ships with Node 22 and is the same SQLite engine D1 is built
 * on, so a query that works here works there.
 *
 * Only the surface the Worker actually uses is implemented; anything else
 * throws, so an untested code path cannot silently pass.
 */

import { DatabaseSync } from 'node:sqlite';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

type SqlValue = string | number | null;

/** Rows come back from node:sqlite as null-prototype objects; normalise them. */
function plain<T>(row: unknown): T {
  return { ...(row as object) } as T;
}

/** One statement a repository issued, as the recorder saw it. */
export interface RecordedStatement {
  readonly sql: string;
  readonly bindings: readonly SqlValue[];
  /** Rows the statement returned. Not the same as rows *read*; see below. */
  readonly rows: number;
}

class TestPreparedStatement {
  readonly #db: DatabaseSync;
  readonly #sql: string;
  readonly #log: RecordedStatement[] | null;
  #bindings: SqlValue[] = [];

  constructor(db: DatabaseSync, sql: string, log: RecordedStatement[] | null) {
    this.#db = db;
    this.#sql = sql;
    this.#log = log;
  }

  #record(rows: number): void {
    this.#log?.push({ sql: this.#sql, bindings: [...this.#bindings], rows });
  }

  bind(...values: unknown[]): TestPreparedStatement {
    const next = new TestPreparedStatement(this.#db, this.#sql, this.#log);
    next.#bindings = values.map(normalizeBinding);
    return next;
  }

  first<T>(column?: string): Promise<T | null> {
    const row = this.#db.prepare(this.#sql).get(...this.#bindings);
    this.#record(row == null ? 0 : 1);
    if (row == null) return Promise.resolve(null);
    const object = plain<Record<string, unknown>>(row);
    return Promise.resolve((column == null ? object : object[column]) as T);
  }

  all<T>(): Promise<{ results: T[]; success: true; meta: Record<string, number> }> {
    const rows = this.#db.prepare(this.#sql).all(...this.#bindings);
    this.#record(rows.length);
    return Promise.resolve({
      results: rows.map((row) => plain<T>(row)),
      success: true,
      meta: { rows_read: rows.length, rows_written: 0 },
    });
  }

  run(): Promise<{ success: true; meta: { changes: number; last_row_id: number } }> {
    const result = this.#db.prepare(this.#sql).run(...this.#bindings);
    this.#record(0);
    return Promise.resolve({
      success: true,
      meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) },
    });
  }

  raw(): never {
    throw new Error('raw() is not implemented in the test D1 adapter');
  }
}

class TestD1Database {
  readonly #db: DatabaseSync;
  #log: RecordedStatement[] | null = null;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  prepare(sql: string): TestPreparedStatement {
    return new TestPreparedStatement(this.#db, sql, this.#log);
  }

  /**
   * Record every statement issued while `work` runs.
   *
   * This is how the query-plan tests can assert on the SQL the *real*
   * repositories produce, rather than on a copy of it pasted into a test that
   * would then quietly stop matching the code it is meant to guard.
   */
  async record<T>(work: () => Promise<T>): Promise<RecordedStatement[]> {
    const log: RecordedStatement[] = [];
    this.#log = log;
    try {
      await work();
    } finally {
      this.#log = null;
    }
    return log;
  }

  /**
   * SQLite's plan for a statement, one line per step.
   *
   * A step beginning `SCAN <table>` — without `USING INDEX` — is a full table
   * scan: every row read, every time. That is the shape this whole round of
   * work existed to remove, and `tests/worker/query-cost.test.ts` fails if one
   * comes back.
   */
  explain(statement: RecordedStatement): string[] {
    const rows = this.#db
      .prepare(`EXPLAIN QUERY PLAN ${statement.sql}`)
      .all(...statement.bindings) as { detail: string }[];
    return rows.map((row) => row.detail);
  }

  /** Rows currently in a table, for turning a scan into a row count. */
  rowCount(table: string): number {
    const row = this.#db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number };
    return row.n;
  }

  /** D1 runs a batch inside a transaction; so does this. */
  async batch<T>(statements: readonly TestPreparedStatement[]): Promise<T[]> {
    this.#db.exec('BEGIN');
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.#db.exec('COMMIT');
      return results as T[];
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  exec(sql: string): Promise<{ count: number; duration: number }> {
    this.#db.exec(sql);
    return Promise.resolve({ count: 0, duration: 0 });
  }

  /** Escape hatch for test setup and assertions — never used by the Worker. */
  runRaw(sql: string, ...bindings: SqlValue[]): void {
    this.#db.prepare(sql).run(...bindings);
  }

  queryRaw<T>(sql: string, ...bindings: SqlValue[]): T[] {
    return this.#db
      .prepare(sql)
      .all(...bindings)
      .map((row) => plain<T>(row));
  }

  close(): void {
    this.#db.close();
  }
}

export type TestDatabase = TestD1Database & D1Database;

/**
 * Create an in-memory database with every migration and the reference seed
 * applied. Each test gets its own, so tests never share state.
 */
export async function createTestDatabase(options: { seed?: boolean } = {}): Promise<TestDatabase> {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');

  for (const file of await sqlFiles(path.join(ROOT, 'migrations'))) {
    db.exec(await readFile(file, 'utf8'));
  }

  if (options.seed !== false) {
    for (const file of await sqlFiles(path.join(ROOT, 'seeds'))) {
      db.exec(await readFile(file, 'utf8'));
    }
  }

  return new TestD1Database(db) as TestDatabase;
}

async function sqlFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory);
  return entries
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => path.join(directory, name));
}

/** node:sqlite accepts only these types; booleans and undefined need mapping. */
function normalizeBinding(value: unknown): SqlValue {
  if (value == null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number' || typeof value === 'string') return value;
  throw new TypeError(`Unsupported SQL binding of type ${typeof value}`);
}
