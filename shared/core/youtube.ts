/**
 * YouTube identifiers and media URLs.
 *
 * The catalog is keyed by the 11-character YouTube video id, so extracting that
 * id reliably from anything a visitor might paste is a correctness requirement,
 * not a convenience: duplicate detection depends on it.
 */

import { YOUTUBE_ID_PATTERN } from '../constants.js';
import type { VideoId } from '../types/catalog.js';

/** Thumbnail qualities YouTube serves, smallest first. */
export const THUMBNAIL_QUALITIES = {
  /** 120×90 — list rows. */
  default: 'default',
  /** 320×180 — compact cards. */
  medium: 'mqdefault',
  /** 480×360 — grid cards. */
  high: 'hqdefault',
  /** 640×480 — hero and share previews. */
  standard: 'sddefault',
  /** 1280×720 — Open Graph. Not available for every video. */
  max: 'maxresdefault',
} as const;

export type ThumbnailQuality = keyof typeof THUMBNAIL_QUALITIES;

/** `true` when the value is exactly a YouTube video id. */
export function isVideoId(value: unknown): value is VideoId {
  return typeof value === 'string' && YOUTUBE_ID_PATTERN.test(value);
}

/** Assert-and-brand helper for code paths that already validated the id. */
export function asVideoId(value: string): VideoId {
  if (!isVideoId(value)) throw new Error(`Not a YouTube video id: ${value}`);
  return value;
}

/**
 * Pull the video id out of anything a person might paste: a bare id, a watch
 * URL, a short `youtu.be` link, an embed, a Shorts link, a live link, or any of
 * those with extra query parameters.
 *
 * Returns `null` when no id is present — callers turn that into a validation
 * message rather than guessing.
 *
 * @example
 * extractVideoId('https://youtu.be/dQw4w9WgXcQ?t=42')          // 'dQw4w9WgXcQ'
 * extractVideoId('https://www.youtube.com/shorts/dQw4w9WgXcQ') // 'dQw4w9WgXcQ'
 * extractVideoId('not a link')                                 // null
 */
export function extractVideoId(input: string | null | undefined): VideoId | null {
  if (input == null) return null;
  const text = input.trim();
  if (text.length === 0) return null;

  if (isVideoId(text)) return text;

  // `v=` works for watch URLs regardless of host or extra parameters.
  const queryMatch = /[?&]v=([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])/.exec(text);
  if (queryMatch?.[1] != null) return queryMatch[1] as VideoId;

  const pathMatch =
    /(?:youtu\.be\/|\/embed\/|\/shorts\/|\/live\/|\/v\/)([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])/.exec(
      text,
    );
  if (pathMatch?.[1] != null) return pathMatch[1] as VideoId;

  return null;
}

/** Canonical watch URL, used for "open on YouTube" links. */
export function watchUrl(id: VideoId): string {
  return `https://www.youtube.com/watch?v=${id}`;
}

/**
 * Privacy-preserving embed URL. `youtube-nocookie.com` avoids setting tracking
 * cookies until the visitor actually plays the video.
 */
export function embedUrl(
  id: VideoId,
  options: { autoplay?: boolean; startSeconds?: number } = {},
): string {
  const params = new URLSearchParams({ rel: '0', modestbranding: '1', playsinline: '1' });
  if (options.autoplay === true) params.set('autoplay', '1');
  if (options.startSeconds != null && options.startSeconds > 0) {
    params.set('start', String(Math.floor(options.startSeconds)));
  }
  return `https://www.youtube-nocookie.com/embed/${id}?${params.toString()}`;
}

/**
 * Thumbnail URL for a video. `override` wins when an editor has uploaded a
 * custom image, which is why every caller passes the whole video, not just the id.
 */
export function thumbnailUrl(
  id: VideoId,
  quality: ThumbnailQuality = 'high',
  override?: string | null,
): string {
  if (override != null && override.length > 0) return override;
  return `https://i.ytimg.com/vi/${id}/${THUMBNAIL_QUALITIES[quality]}.jpg`;
}

/** Normalise any channel URL to its canonical form, or `null` if unusable. */
export function normalizeChannelUrl(input: string | null | undefined): string | null {
  if (input == null) return null;
  const text = input.trim();
  if (text.length === 0) return null;
  if (!/^https?:\/\//i.test(text)) return null;
  try {
    const url = new URL(text);
    if (!/(^|\.)youtube\.com$/i.test(url.hostname)) return null;
    return `https://www.youtube.com${url.pathname.replace(/\/$/, '')}`;
  } catch {
    return null;
  }
}
