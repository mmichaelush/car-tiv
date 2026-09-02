/**
 * Minimal SQL emitter for the offline import.
 *
 * The Worker never builds SQL this way — it uses prepared statements with
 * bindings. This module exists only for the one-off migration, which has to
 * produce `.sql` files that `wrangler d1 execute --file` can run, and it is
 * therefore strict about escaping: every value goes through `literal()`, and
 * identifiers are validated rather than interpolated blindly.
 */

/** Values that can appear in a generated INSERT. */
export type SqlValue = string | number | boolean | null | undefined;

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/** Validate a table or column name. Throws rather than emitting unsafe SQL. */
export function identifier(name: string): string {
  if (!IDENTIFIER.test(name)) throw new Error(`Unsafe SQL identifier: ${name}`);
  return name;
}

/**
 * Render a value as a SQL literal.
 *
 * Strings are single-quoted with quotes doubled. Control characters that SQLite
 * would accept but that make a `.sql` file unreadable (and that can break the
 * line-oriented statement splitting in some tools) are stripped.
 */
export function literal(value: SqlValue): string {
  if (value == null) return 'NULL';
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Cannot serialise ${String(value)} to SQL`);
    return String(value);
  }
  // eslint-disable-next-line no-control-regex -- deliberately removing control chars
  const cleaned = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  return `'${cleaned.replace(/'/g, "''")}'`;
}

export interface InsertOptions {
  /** `OR IGNORE` makes the whole import re-runnable. */
  readonly orIgnore?: boolean;
  /** Rows per statement. Keeps each statement well under D1's size limits. */
  readonly rowsPerStatement?: number;
}

/**
 * Build multi-row INSERT statements.
 *
 * @example
 * insertMany('tags', ['slug', 'name'], [['a', 'A'], ['b', 'B']])
 * // ["INSERT OR IGNORE INTO tags (slug, name) VALUES\n  ('a','A'),\n  ('b','B');"]
 */
export function insertMany(
  table: string,
  columns: readonly string[],
  rows: readonly (readonly SqlValue[])[],
  options: InsertOptions = {},
): string[] {
  if (rows.length === 0) return [];

  const safeTable = identifier(table);
  const safeColumns = columns.map(identifier).join(', ');
  const verb = options.orIgnore === false ? 'INSERT' : 'INSERT OR IGNORE';
  const chunkSize = options.rowsPerStatement ?? 200;
  const statements: string[] = [];

  for (let start = 0; start < rows.length; start += chunkSize) {
    const chunk = rows.slice(start, start + chunkSize);
    const values = chunk
      .map((row) => {
        if (row.length !== columns.length) {
          throw new Error(
            `Row has ${String(row.length)} values but ${String(columns.length)} columns were declared`,
          );
        }
        return `  (${row.map(literal).join(', ')})`;
      })
      .join(',\n');
    statements.push(`${verb} INTO ${safeTable} (${safeColumns}) VALUES\n${values};`);
  }

  return statements;
}

/**
 * Split a list of statements into files no larger than `maxBytes`.
 *
 * D1 rejects very large scripts, and a single 250 MB file is impossible to
 * review, so the import is emitted as a numbered sequence applied in order.
 */
export function chunkStatements(statements: readonly string[], maxBytes = 400_000): string[] {
  const files: string[] = [];
  let current: string[] = [];
  let size = 0;

  for (const statement of statements) {
    const bytes = Buffer.byteLength(statement, 'utf8') + 2;
    if (current.length > 0 && size + bytes > maxBytes) {
      files.push(`${current.join('\n\n')}\n`);
      current = [];
      size = 0;
    }
    current.push(statement);
    size += bytes;
  }

  if (current.length > 0) files.push(`${current.join('\n\n')}\n`);
  return files;
}
