/**
 * Shared repository plumbing.
 *
 * Rules that hold for every repository in this folder:
 *   * SQL lives here and nowhere else in the code base.
 *   * every value reaches the database through a binding — no interpolation.
 *   * a D1 failure becomes a `ServiceUnavailableError`, so a route never has to
 *     know what a `D1_ERROR` is.
 *   * rows are mapped to the camelCase domain types from `shared/types` before
 *     leaving the repository, so nothing above this layer sees a column name.
 */

import type { D1Database, D1Result } from '@cloudflare/workers-types';
import { ServiceUnavailableError } from '../lib/errors.js';

/** A value D1 accepts as a bound parameter. */
export type Binding = string | number | null;

/**
 * D1's hard ceiling on bound parameters in one statement.
 *
 * Not a guideline. A statement with 101 parameters fails with "too many SQL
 * variables", and every list-shaped write in this folder — a link-check batch
 * of 200 ids, a bulk admin edit of 500 — was over it. Nothing caught that,
 * because `node:sqlite` (which the tests run on) allows 32,766; the test
 * adapter now enforces this number so the suite can see the difference.
 *
 * @see https://developers.cloudflare.com/d1/platform/limits/
 */
export const MAX_BOUND_PARAMETERS = 100;

/**
 * Parameters held back from every chunk.
 *
 * `fixed` below is the honest way to declare the parameters a statement binds
 * alongside its list, and every call site here does declare it. This reserve is
 * what protects the one that forgets: a statement that quietly grew a `LIMIT`
 * lands at 91 parameters instead of 101, and fails a test rather than a
 * production request.
 *
 * It used to be a flat cap of 80 rows per chunk instead, which is the same
 * protection for an `id IN (…)` list and a much more expensive one for a
 * multi-row `INSERT`: seven columns a row turned a 100-parameter budget into
 * eleven rows rather than twelve, and the difference is paid in *statements*,
 * against a limit of fifty per invocation.
 */
export const BINDING_RESERVE = 10;

/**
 * Split a list so each chunk fits inside one statement's binding budget.
 *
 * `perItem` is how many parameters each element contributes: 1 for an
 * `id IN (…)` list, 7 for a multi-row `INSERT` whose rows have seven columns.
 * `fixed` is the number of parameters the statement binds regardless of the
 * list length.
 *
 * Chunking is the whole answer to the 100-parameter limit, and it is preferred
 * over the alternative — one statement per id — because that trades a binding
 * problem for a query-count one: D1's free plan also caps queries per Worker
 * invocation at 50, so 200 single-id statements is just a different way to
 * fail. One set-based statement per chunk stays inside both — but only if the
 * chunk is as large as the budget allows, which is why this function spends the
 * whole budget rather than a round fraction of it.
 */
export function chunkForBindings<T>(
  items: readonly T[],
  { perItem = 1, fixed = 0 }: { perItem?: number; fixed?: number } = {},
): T[][] {
  const budget = MAX_BOUND_PARAMETERS - fixed - BINDING_RESERVE;
  const size = Math.max(1, Math.floor(budget / perItem));

  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

/**
 * The largest list `chunkForBindings` will fit into `statements` statements.
 *
 * Used to derive the admin bulk ceiling from the query budget rather than
 * choosing a round number and hoping. See `MAX_BULK_IDS`.
 */
export function chunkSize({ perItem = 1, fixed = 0 }: { perItem?: number; fixed?: number }): number {
  return Math.max(1, Math.floor((MAX_BOUND_PARAMETERS - fixed - BINDING_RESERVE) / perItem));
}

/** `?, ?, ?` for a list of `count` values. */
export function placeholders(count: number): string {
  return new Array(count).fill('?').join(', ');
}

/**
 * A WHERE clause under construction.
 *
 * Conditions and their bindings are appended together, which makes it
 * impossible to add a condition and forget its parameter — the classic source
 * of "wrong number of bindings" bugs in hand-built SQL.
 */
export class ConditionBuilder {
  readonly #conditions: string[] = [];
  readonly #bindings: Binding[] = [];

  /** Add `sql` with its parameters, in order. */
  add(sql: string, ...bindings: readonly Binding[]): this {
    this.#conditions.push(sql);
    this.#bindings.push(...bindings);
    return this;
  }

  /** Add only when `condition` holds. Keeps call sites free of `if` blocks. */
  addIf(condition: boolean, sql: string, ...bindings: readonly Binding[]): this {
    if (condition) this.add(sql, ...bindings);
    return this;
  }

  /** `WHERE a AND b`, or an empty string when there are no conditions. */
  whereClause(): string {
    return this.#conditions.length === 0 ? '' : `WHERE ${this.#conditions.join('\n  AND ')}`;
  }

  bindings(): Binding[] {
    return [...this.#bindings];
  }

  get isEmpty(): boolean {
    return this.#conditions.length === 0;
  }
}

/** Base class holding the database handle and the error translation. */
export abstract class BaseRepository {
  protected readonly db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  /** Run a query returning many rows. */
  protected async all<TRow>(sql: string, bindings: readonly Binding[] = []): Promise<TRow[]> {
    try {
      const statement = this.db.prepare(sql).bind(...bindings);
      const result = await statement.all<TRow>();
      return result.results;
    } catch (cause) {
      throw wrap(cause, sql);
    }
  }

  /** Run a query returning at most one row. */
  protected async first<TRow>(
    sql: string,
    bindings: readonly Binding[] = [],
  ): Promise<TRow | null> {
    try {
      return await this.db
        .prepare(sql)
        .bind(...bindings)
        .first<TRow>();
    } catch (cause) {
      throw wrap(cause, sql);
    }
  }

  /**
   * Run a query whose answer is a single number.
   * The query must alias the column as `value`, e.g. `SELECT COUNT(*) AS value`.
   */
  protected async count(sql: string, bindings: readonly Binding[] = []): Promise<number> {
    const row = await this.first<{ value: number }>(sql, bindings);
    return row?.value ?? 0;
  }

  /** Run a statement for its effect. */
  protected async run(sql: string, bindings: readonly Binding[] = []): Promise<D1Result> {
    try {
      return await this.db
        .prepare(sql)
        .bind(...bindings)
        .run();
    } catch (cause) {
      throw wrap(cause, sql);
    }
  }

  /**
   * Run several statements as one D1 batch.
   * D1 executes a batch inside an implicit transaction, so either all of the
   * statements apply or none do.
   */
  protected async batch(
    statements: readonly { sql: string; bindings?: readonly Binding[] }[],
  ): Promise<void> {
    await this.batchWithResults(statements);
  }

  /**
   * The same, returning each statement's result.
   *
   * Needed wherever a mutation and its audit row must land together *and* the
   * caller needs the row count — writing those as two separate calls means a
   * failure between them leaves the change with no record of who made it.
   */
  protected async batchWithResults(
    statements: readonly { sql: string; bindings?: readonly Binding[] }[],
  ): Promise<D1Result[]> {
    if (statements.length === 0) return [];
    try {
      return await this.db.batch(
        statements.map((statement) =>
          this.db.prepare(statement.sql).bind(...(statement.bindings ?? [])),
        ),
      );
    } catch (cause) {
      throw wrap(cause, statements[0]?.sql ?? '');
    }
  }
}

/**
 * Translate a driver error.
 *
 * A UNIQUE violation is business logic and is re-thrown untouched so the
 * calling service can turn it into a 409; anything else is an outage from the
 * caller's point of view.
 */
function wrap(cause: unknown, sql: string): Error {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (message.includes('UNIQUE constraint failed')) {
    return cause instanceof Error ? cause : new Error(message);
  }
  return new ServiceUnavailableError('בסיס הנתונים אינו זמין כרגע', {
    cause,
    // Only the first line of the statement, so the log stays readable and no
    // bound value can be reconstructed from it.
    logContext: { sql: sql.split('\n')[0] },
  });
}

/** `true` when an error is a UNIQUE constraint violation. */
export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && error.message.includes('UNIQUE constraint failed');
}

/** D1 stores booleans as 0/1. */
export const toBoolean = (value: number | null | undefined): boolean => value === 1;

/**
 * Separator used by every `group_concat` in this folder. A unit separator
 * cannot appear in a title or a tag, so splitting it back apart is lossless.
 */
export const LIST_SEPARATOR = '\u001F';

/** Split a `group_concat` result into a list, dropping empties. */
export function splitList(value: string | null | undefined): string[] {
  if (value == null || value.length === 0) return [];
  return value.split(LIST_SEPARATOR).filter((item) => item.length > 0);
}
