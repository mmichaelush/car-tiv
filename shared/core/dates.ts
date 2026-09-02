/**
 * Date parsing and Hebrew formatting.
 *
 * The legacy catalog stores `dateAdded` as `DD/MM/YYYY`, which `new Date(...)`
 * parses as US `MM/DD/YYYY` in some runtimes — the classic source of "videos
 * from the future" bugs. Everything therefore goes through `parseCatalogDate`,
 * and the database only ever stores ISO-8601.
 */

const DAY_MONTH_YEAR = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/;

/**
 * Parse a catalog date into an ISO `YYYY-MM-DD` string.
 * Returns `null` when the value is missing or not a real calendar date, so the
 * importer can report it instead of silently storing garbage.
 *
 * @example
 * parseCatalogDate('17/09/2024') // '2024-09-17'
 * parseCatalogDate('2024-09-17') // '2024-09-17'
 * parseCatalogDate('31/02/2024') // null  (no such day)
 */
export function parseCatalogDate(value: string | null | undefined): string | null {
  if (value == null) return null;
  const text = value.trim();
  if (text.length === 0) return null;

  const iso = ISO_DATE.exec(text);
  if (iso) {
    const [, year, month, day] = iso;
    return toIsoDate(Number(year), Number(month), Number(day));
  }

  const dmy = DAY_MONTH_YEAR.exec(text);
  if (dmy) {
    const [, day, month, year] = dmy;
    return toIsoDate(Number(year), Number(month), Number(day));
  }

  return null;
}

/** Build an ISO date, verifying the calendar accepts it (rejects 31/02). */
function toIsoDate(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date.toISOString().slice(0, 10);
}

/** Current timestamp as an ISO string. Wrapped so tests can stub it. */
export function nowIso(): string {
  return new Date().toISOString();
}

const HEBREW_DATE_FORMAT = new Intl.DateTimeFormat('he-IL', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

/** `17 בספטמבר 2024`. Returns an empty string for an unparseable date. */
export function formatHebrewDate(isoDate: string | null | undefined): string {
  if (isoDate == null || isoDate.length === 0) return '';
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) return '';
  return HEBREW_DATE_FORMAT.format(date);
}

/**
 * A short relative label for cards: `היום`, `לפני 3 ימים`, `לפני חודשיים`.
 * Falls back to the absolute date once the difference passes a year.
 */
export function formatRelativeDate(isoDate: string | null | undefined, now = new Date()): string {
  if (isoDate == null || isoDate.length === 0) return '';
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) return '';

  const days = Math.floor((now.getTime() - date.getTime()) / 86_400_000);
  if (days < 0) return formatHebrewDate(isoDate);
  if (days === 0) return 'היום';
  if (days === 1) return 'אתמול';
  if (days < 7) return `לפני ${String(days)} ימים`;
  if (days < 14) return 'לפני שבוע';
  if (days < 31) return `לפני ${String(Math.floor(days / 7))} שבועות`;
  if (days < 61) return 'לפני חודש';
  if (days < 365) return `לפני ${String(Math.floor(days / 30))} חודשים`;
  return formatHebrewDate(isoDate);
}

/** ISO date N days before `reference`. Used by "added this week" counters. */
export function isoDaysAgo(days: number, reference = new Date()): string {
  return new Date(reference.getTime() - days * 86_400_000).toISOString();
}
