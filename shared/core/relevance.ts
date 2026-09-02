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
 *
 * Same model 5, same manufacturer 4, same category 3, shared tag 2 (up to
 * three tags), same channel 1.
 *
 * `video-repository.ts` interpolates these numbers into the SQL rather than
 * restating them, which is what the paragraph above finally means. It did
 * restate them, and the two copies had already drifted: this object carried a
 * `recencyBonus: 1` that the query never applied and `docs/api.md` documented
 * as if it did. Recency is not a weight here — the query breaks ties with
 * `ORDER BY score DESC, added_at DESC`, which is the same intent expressed
 * where it belongs.
 */
export const RELATED_WEIGHTS = {
  sameModel: 5,
  sameManufacturer: 4,
  sameCategory: 3,
  sharedTag: 2,
  sameChannel: 1,
  /**
   * How many shared tags can count. A video sharing eight tags is not four
   * times as related as one sharing two; without the cap, tags outweigh the
   * vehicle match that is usually the real reason someone is watching.
   */
  maxSharedTags: 3,
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
 * This is the same arithmetic `VideoRepository.findRelated` expresses in SQL,
 * and it now uses the same constants — the `scored` CTE interpolates
 * `RELATED_WEIGHTS`. `tests/shared/relevance.test.ts` pins the ordering on a
 * fixed dataset, which is the cheap way to reason about a ranking rule without
 * a database.
 *
 * Total and side-effect free, so it can also serve a listing assembled in
 * memory — the ranking rule does not have to move to wherever the data is.
 */
export function scoreRelated(source: RelatableVideo, candidate: RelatableVideo): number {
  if (candidate.id === source.id) return 0;

  let score = 0;

  if (shareAny(source.models, candidate.models)) score += RELATED_WEIGHTS.sameModel;
  if (shareAny(source.manufacturers, candidate.manufacturers)) {
    score += RELATED_WEIGHTS.sameManufacturer;
  }
  if (candidate.categoryId === source.categoryId) score += RELATED_WEIGHTS.sameCategory;

  const sharedTags = countShared(source.tags, candidate.tags);
  score += Math.min(sharedTags, RELATED_WEIGHTS.maxSharedTags) * RELATED_WEIGHTS.sharedTag;

  if (
    candidate.channelSlug != null &&
    source.channelSlug != null &&
    candidate.channelSlug === source.channelSlug
  ) {
    score += RELATED_WEIGHTS.sameChannel;
  }

  // No recency term. There used to be one here and nowhere in the SQL, so the
  // two rankings disagreed and `docs/api.md` documented the one that does not
  // run. Recency breaks ties in `rankRelated` and in the query's `ORDER BY`,
  // which is the same intent without a second, invisible copy of it.
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
): T[] {
  return candidates
    .map((candidate) => ({ candidate, score: scoreRelated(source, candidate) }))
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
