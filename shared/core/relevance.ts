/**
 * Scoring rules for "related videos" and for ordering search results.
 *
 * These are deliberately simple, explainable integer weights rather than a
 * learned model: an editor must be able to look at a result list and say why a
 * video is there. The weights live here — one place — because the D1 query, the
 * static fallback and the tests all have to agree.
 */

import type { VideoSummary } from '../types/catalog.js';

/**
 * How much each kind of match contributes to the "related" score.
 * Taken from the upgrade plan: same model 5, same manufacturer 4, same
 * category 3, shared tag 2, same channel 1.
 */
export const RELATED_WEIGHTS = {
  sameModel: 5,
  sameManufacturer: 4,
  sameCategory: 3,
  sharedTag: 2,
  sameChannel: 1,
  /** Small nudge so that, all else equal, newer videos win. */
  recencyBonus: 1,
} as const;

/**
 * Field weights used when ranking full-text search hits. Higher means the
 * match matters more. Mirrors the FTS5 `bm25()` column weights in
 * `worker/repositories/search-repository.ts`.
 */
export const SEARCH_FIELD_WEIGHTS = {
  title: 10,
  manufacturer: 8,
  model: 8,
  tags: 4,
  description: 2,
  channel: 1,
} as const;

/** The minimal shape `scoreRelated` needs — anything richer is ignored. */
export interface RelatableVideo {
  readonly id: string;
  readonly categoryId: string;
  readonly channelSlug: string | null;
  readonly tags: readonly string[];
  readonly manufacturers: readonly string[];
  readonly models: readonly string[];
  readonly addedAt: string;
}

/**
 * Score `candidate` against `source`. Higher is more related; `0` means
 * "nothing in common" and the candidate should be dropped.
 *
 * The function is intentionally total and side-effect free so it can be used
 * both by the static fallback repository and by unit tests that pin the
 * ordering of a fixed dataset.
 */
export function scoreRelated(
  source: RelatableVideo,
  candidate: RelatableVideo,
  now: Date = new Date(),
): number {
  if (candidate.id === source.id) return 0;

  let score = 0;

  if (shareAny(source.models, candidate.models)) score += RELATED_WEIGHTS.sameModel;
  if (shareAny(source.manufacturers, candidate.manufacturers)) {
    score += RELATED_WEIGHTS.sameManufacturer;
  }
  if (candidate.categoryId === source.categoryId) score += RELATED_WEIGHTS.sameCategory;

  const sharedTags = countShared(source.tags, candidate.tags);
  score += Math.min(sharedTags, 3) * RELATED_WEIGHTS.sharedTag;

  if (
    candidate.channelSlug != null &&
    source.channelSlug != null &&
    candidate.channelSlug === source.channelSlug
  ) {
    score += RELATED_WEIGHTS.sameChannel;
  }

  if (score > 0 && isRecent(candidate.addedAt, now)) score += RELATED_WEIGHTS.recencyBonus;

  return score;
}

/**
 * Rank and trim a candidate list. Ties break by recency so the order is stable
 * and predictable rather than depending on the database's row order.
 */
export function rankRelated<T extends RelatableVideo>(
  source: RelatableVideo,
  candidates: readonly T[],
  limit: number,
  now: Date = new Date(),
): T[] {
  return candidates
    .map((candidate) => ({ candidate, score: scoreRelated(source, candidate, now) }))
    .filter((entry) => entry.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score || Date.parse(b.candidate.addedAt) - Date.parse(a.candidate.addedAt),
    )
    .slice(0, limit)
    .map((entry) => entry.candidate);
}

/** Adapter from the API's `VideoSummary` to the shape the scorer needs. */
export function toRelatable(
  video: VideoSummary,
  extras: { manufacturers?: readonly string[]; models?: readonly string[] } = {},
): RelatableVideo {
  return {
    id: video.id,
    categoryId: video.categoryId,
    channelSlug: video.channel?.slug ?? null,
    tags: video.tags,
    manufacturers: extras.manufacturers ?? [],
    models: extras.models ?? [],
    addedAt: video.addedAt,
  };
}

function shareAny(left: readonly string[], right: readonly string[]): boolean {
  if (left.length === 0 || right.length === 0) return false;
  const set = new Set(right);
  return left.some((value) => set.has(value));
}

function countShared(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0 || right.length === 0) return 0;
  const set = new Set(right);
  return left.reduce((total, value) => (set.has(value) ? total + 1 : total), 0);
}

/** "Recent" for the ranking bonus means added in the last 90 days. */
function isRecent(isoDate: string, now: Date): boolean {
  const added = Date.parse(isoDate);
  if (Number.isNaN(added)) return false;
  return now.getTime() - added < 90 * 86_400_000;
}
