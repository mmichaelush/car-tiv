/**
 * Video duration parsing and formatting.
 *
 * The legacy JSON stores durations as display strings ("8:42", "1:02:15") and
 * occasionally as an ISO-8601 period from the YouTube API ("PT8M42S").
 * D1 stores an integer number of seconds, which is the only form that can be
 * sorted and filtered. Everything converts through here.
 */

/** Buckets offered in the duration filter. */
export const DURATION_BUCKETS = {
  short: { label: 'עד 5 דקות', min: 0, max: 300 },
  medium: { label: '5–20 דקות', min: 300, max: 1_200 },
  long: { label: 'מעל 20 דקות', min: 1_200, max: null },
} as const;

export type DurationBucket = keyof typeof DURATION_BUCKETS;

const ISO_PERIOD = /^P(?:\d+D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/i;

/**
 * Parse any duration the catalog has ever contained into whole seconds.
 * Returns `0` for empty or unparseable input rather than throwing, because a
 * bad duration must never block an import — the importer reports it instead.
 *
 * @example
 * parseDuration('8:42')      // 522
 * parseDuration('1:02:15')   // 3735
 * parseDuration('PT8M42S')   // 522
 * parseDuration(522)         // 522
 */
export function parseDuration(value: string | number | null | undefined): number {
  if (value == null) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;

  const text = value.trim();
  if (text.length === 0) return 0;

  if (/^\d+$/.test(text)) return Number.parseInt(text, 10);

  const iso = ISO_PERIOD.exec(text);
  if (iso) {
    const [, hours, minutes, seconds] = iso;
    return (
      Number.parseInt(hours ?? '0', 10) * 3_600 +
      Number.parseInt(minutes ?? '0', 10) * 60 +
      Math.round(Number.parseFloat(seconds ?? '0'))
    );
  }

  // "h:mm:ss", "m:ss" — reject anything with a non-numeric segment.
  const parts = text.split(':');
  if (parts.length < 2 || parts.length > 3) return 0;
  if (!parts.every((part) => /^\d+$/.test(part.trim()))) return 0;

  return parts.reduce((total, part) => total * 60 + Number.parseInt(part, 10), 0);
}

/**
 * Format seconds for display on a thumbnail: `8:42`, `1:02:15`.
 * Returns an empty string for `0`, so callers can hide the badge entirely.
 */
export function formatDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return '';

  const seconds = Math.round(totalSeconds);
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remaining = seconds % 60;
  const pad = (value: number): string => String(value).padStart(2, '0');

  return hours > 0
    ? `${String(hours)}:${pad(minutes)}:${pad(remaining)}`
    : `${String(minutes)}:${pad(remaining)}`;
}

/** A spoken Hebrew label used by screen readers and `aria-label`. */
export function describeDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return 'משך לא ידוע';

  const seconds = Math.round(totalSeconds);
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.round((seconds % 3_600) / 60);

  if (hours > 0 && minutes > 0) return `${String(hours)} שעות ו־${String(minutes)} דקות`;
  if (hours > 0) return `${String(hours)} שעות`;
  if (minutes > 0) return `${String(minutes)} דקות`;
  return `${String(seconds)} שניות`;
}

/** Translate a filter bucket into the numeric range the API expects. */
export function bucketToRange(bucket: DurationBucket): { min: number; max: number | null } {
  const { min, max } = DURATION_BUCKETS[bucket];
  return { min, max };
}
