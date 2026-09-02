/**
 * Reading the editor's file in the browser.
 *
 * CSV and TSV go through our own parser (`shared/core/csv.ts`). XLSX needs a
 * real spreadsheet reader, and that library is ~400 KB — so it is behind a
 * dynamic `import()` and is fetched only when someone actually picks an `.xlsx`
 * file. Nobody browsing the catalog, and nobody using the rest of the admin,
 * ever downloads it.
 *
 * Parsing here rather than on the server is what keeps a 5,000-row workbook out
 * of a Worker request entirely: the rows are sent afterwards, in batches, as
 * plain JSON.
 */

import { parseDelimited, type ParsedTable } from '@shared/core/csv.js';

export type ImportFormat = 'csv' | 'xlsx';

export interface ReadFileResult extends ParsedTable {
  readonly format: ImportFormat;
  readonly filename: string;
}

/** Files bigger than this are refused before anything is parsed. */
export const MAX_IMPORT_BYTES = 12 * 1024 * 1024;

export class ImportFileError extends Error {}

/** Read a picked file into a table. */
export async function readImportFile(file: File): Promise<ReadFileResult> {
  if (file.size > MAX_IMPORT_BYTES) {
    throw new ImportFileError(
      `הקובץ גדול מדי (עד ${String(Math.round(MAX_IMPORT_BYTES / 1024 / 1024))}MB)`,
    );
  }

  const name = file.name.toLowerCase();

  if (name.endsWith('.csv') || name.endsWith('.tsv') || name.endsWith('.txt')) {
    const table = parseDelimited(await file.text());
    return { ...table, format: 'csv', filename: file.name };
  }

  if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
    return { ...(await readWorkbook(file)), format: 'xlsx', filename: file.name };
  }

  throw new ImportFileError('אפשר להעלות קובץ CSV או XLSX');
}

/**
 * Read the first sheet of a workbook.
 *
 * Every cell is taken as text (`raw: false`), so a date formatted in the
 * spreadsheet arrives as the editor sees it rather than as a serial number,
 * and an id like `0012345678` keeps its leading zeros.
 */
async function readWorkbook(file: File): Promise<ParsedTable> {
  const XLSX = await import('xlsx');

  const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: false });
  const sheetName = workbook.SheetNames[0];
  if (sheetName == null) throw new ImportFileError('הקובץ אינו מכיל גיליונות');

  const sheet = workbook.Sheets[sheetName];
  if (sheet == null) throw new ImportFileError('לא הצלחנו לקרוא את הגיליון הראשון');

  // Round-tripping through CSV means one parser, one set of rules and one set
  // of tests for both formats — rather than a second code path here that would
  // handle quoting and blank rows slightly differently.
  const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false, rawNumbers: false });
  return parseDelimited(csv, ',');
}
