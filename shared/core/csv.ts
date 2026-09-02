/**
 * Reading a delimited text file.
 *
 * Written rather than taken from a package because the requirement is small,
 * exactly specifiable, and the failure mode of getting it wrong is silent: a
 * title containing a comma turns into two columns and the import quietly
 * shifts every field after it.
 *
 * It follows RFC 4180 where that matters:
 *
 *  * a field may be quoted with `"`, and a quoted field may contain the
 *    delimiter, a line break, or a doubled `""` meaning one literal quote;
 *  * `\r\n` and `\n` both end a record;
 *  * a UTF-8 byte-order mark at the start of the file is dropped, because
 *    Excel writes one and it would otherwise become part of the first header.
 *
 * The delimiter is detected rather than assumed: Excel in a Hebrew locale
 * exports semicolon-separated files, and telling a visitor "your file is
 * broken" when it is merely European is not acceptable.
 */

/** A parsed file: the header row plus every data row. */
export interface ParsedTable {
  readonly headers: readonly string[];
  /** One record per row, already aligned to `headers`. */
  readonly rows: readonly Record<string, string>[];
  readonly delimiter: string;
  /** Rows whose field count did not match the header. */
  readonly malformedRows: readonly number[];
}

const DELIMITERS = [',', ';', '\t', '|'] as const;

/**
 * Guess the delimiter from the first line.
 *
 * Counts only characters outside quotes, so `"Smith, John";42` is correctly
 * read as semicolon-separated rather than comma-separated.
 */
export function detectDelimiter(sample: string): string {
  const firstLine = sample.split(/\r?\n/, 1)[0] ?? '';

  let best = ',';
  let bestCount = 0;

  for (const candidate of DELIMITERS) {
    let count = 0;
    let inQuotes = false;

    for (const character of firstLine) {
      if (character === '"') inQuotes = !inQuotes;
      else if (character === candidate && !inQuotes) count += 1;
    }

    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }

  return best;
}

/** Split delimited text into records. */
export function parseDelimited(text: string, delimiter?: string): ParsedTable {
  // U+FEFF, written as an escape so the character itself is not in the source.
  const clean = text.replace(/^\uFEFF/, '');
  const separator = delimiter ?? detectDelimiter(clean);

  const records = splitRecords(clean, separator);
  if (records.length === 0) {
    return { headers: [], rows: [], delimiter: separator, malformedRows: [] };
  }

  const headers = (records[0] ?? []).map((header, index) =>
    header.trim().length === 0 ? `עמודה ${String(index + 1)}` : header.trim(),
  );

  const rows: Record<string, string>[] = [];
  const malformedRows: number[] = [];

  for (let index = 1; index < records.length; index += 1) {
    const record = records[index] ?? [];

    // A trailing blank line is not a malformed row, it is a trailing blank line.
    if (record.length === 1 && (record[0] ?? '').trim().length === 0) continue;

    if (record.length !== headers.length) malformedRows.push(index + 1);

    const row: Record<string, string> = {};
    headers.forEach((header, column) => {
      row[header] = (record[column] ?? '').trim();
    });
    rows.push(row);
  }

  return { headers, rows, delimiter: separator, malformedRows };
}

/** The state machine. One pass, no regular expressions, no backtracking. */
function splitRecords(text: string, delimiter: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];

    if (inQuotes) {
      if (character === '"') {
        // `""` inside a quoted field is one literal quote.
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += character;
      }
      continue;
    }

    if (character === '"' && field.length === 0) {
      inQuotes = true;
    } else if (character === delimiter) {
      record.push(field);
      field = '';
    } else if (character === '\n' || character === '\r') {
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      record.push(field);
      records.push(record);
      record = [];
      field = '';
    } else {
      field += character;
    }
  }

  // Whatever is left when the text ends is the final field of the final record.
  if (field.length > 0 || record.length > 0) {
    record.push(field);
    records.push(record);
  }

  return records;
}
