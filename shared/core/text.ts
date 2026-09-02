/**
 * Text normalisation used by search, slugs and duplicate detection.
 *
 * Hebrew needs more care than English: the same word is written with and
 * without niqqud, with a geresh (׳) or an apostrophe ('), with a maqaf (־) or a
 * hyphen, and its last letter changes form. Search must treat all of those as
 * the same word, so both the indexer and the query go through `normalizeText`.
 *
 * Every function here is pure and runs identically in the browser, in the
 * Worker and in the import scripts.
 */

/**
 * Hebrew points and cantillation marks (U+0591-U+05C7), minus U+05BE (maqaf),
 * which is a word separator and is handled by `DASH_LIKE` instead.
 */
const HEBREW_DIACRITICS = /[\u0591-\u05BD\u05BF-\u05C7]/g;

/** Geresh, gershayim and the typographic quotes people type instead. */
const QUOTE_LIKE = /[\u05F3\u05F4\u2018\u2019\u201C\u201D`\u00B4'"]/g;

/** Maqaf, en/em dashes, non-breaking hyphen, underscore - all become a space. */
const DASH_LIKE = /[\u05BE\u2010-\u2015_]/g;

/** Zero-width and bidi-control characters that survive copy-paste from the web. */
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\uFEFF]/g;

/** Final letter forms mapped to their regular counterparts. */
const FINAL_LETTERS: ReadonlyMap<string, string> = new Map([
  ['ך', 'כ'], // ך -> כ
  ['ם', 'מ'], // ם -> מ
  ['ן', 'נ'], // ן -> נ
  ['ף', 'פ'], // ף -> פ
  ['ץ', 'צ'], // ץ -> צ
]);

export interface NormalizeOptions {
  /**
   * Fold final letter forms (ך ם ן ף ץ) into their regular forms.
   * Used when building the search index and when normalising a query, so
   * "רכבים" and "רכבים" written either way match. Off for display text.
   */
  readonly foldFinalLetters?: boolean;
}

/**
 * Collapse a string to a comparable form: no diacritics, no invisible
 * characters, uniform quotes and dashes, single spaces, lower case.
 *
 * @example
 * normalizeText('טוֹיוֹטָה  קוֹרוֹלָה') // 'טויוטה קורולה'
 * normalizeText('TOYOTA Corolla')      // 'toyota corolla'
 */
export function normalizeText(value: string, options: NormalizeOptions = {}): string {
  let text = value
    .normalize('NFKD')
    .replace(INVISIBLE, '')
    // Dashes run first: the maqaf sits inside the Hebrew diacritics block and
    // must become a space, not disappear.
    .replace(DASH_LIKE, ' ')
    .replace(HEBREW_DIACRITICS, '')
    .replace(QUOTE_LIKE, '')
    // Anything that is not a letter, a digit or a space becomes a space.
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

  if (options.foldFinalLetters === true) {
    text = [...text].map((character) => FINAL_LETTERS.get(character) ?? character).join('');
  }

  return text;
}

/**
 * The form stored in the search index and used to build a query.
 * Always pair `indexText` with `indexText` — never compare a raw string to an
 * indexed one.
 */
export function indexText(value: string): string {
  return normalizeText(value, { foldFinalLetters: true });
}

/**
 * Split normalised text into search terms, dropping single characters that
 * only add noise.
 */
export function tokenize(value: string): string[] {
  return indexText(value)
    .split(' ')
    .filter((token) => token.length > 1);
}

/**
 * Build a URL-safe slug. Hebrew is kept as-is (browsers and Workers handle
 * percent-encoded Hebrew paths fine) because transliterating it produces
 * unreadable URLs.
 *
 * @example
 * slugify('Auto IL | אוטו')  // 'auto-il-אוטו'
 */
export function slugify(value: string): string {
  const slug = normalizeText(value).replace(/\s+/g, '-').replace(/-+/g, '-');
  return slug.replace(/^-|-$/g, '');
}

/**
 * A slug guaranteed to be non-empty and unique-ish, for rows whose name is
 * empty or made only of punctuation.
 */
export function slugifyWithFallback(value: string, fallback: string): string {
  const slug = slugify(value);
  return slug.length > 0 ? slug : fallback;
}

/**
 * Escape a string for safe interpolation into HTML.
 *
 * Rendering helpers use this on every value that comes from the database or
 * from a visitor. See CONTRIBUTING.md: no catalog text ever reaches innerHTML
 * without passing through here.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Shorten text for a card or a meta description, breaking on a word boundary. */
export function truncate(value: string, maxLength: number): string {
  const text = value.trim();
  if (text.length <= maxLength) return text;
  const cut = text.slice(0, maxLength);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > maxLength * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * `true` when the text contains Hebrew letters. Used to fill `isHebrew` for
 * legacy rows that do not carry the flag.
 */
export function containsHebrew(value: string): boolean {
  return /[\u05D0-\u05EA]/.test(value);
}
