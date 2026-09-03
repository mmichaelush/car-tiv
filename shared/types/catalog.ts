/**
 * Catalog domain types.
 *
 * These are the shapes the API speaks. They are deliberately *not* the database
 * rows: the repository layer maps snake_case D1 columns onto these camelCase
 * objects, so the storage engine can change without touching the UI.
 */

import type { SortOption, VideoStatus } from '../constants.js';

/**
 * An 11-character YouTube id. Branded so a plain string cannot be passed where
 * a validated id is expected.
 */
export type VideoId = string & { readonly __brand: 'VideoId' };

/** Stable slug of a category, e.g. `maintenance`. */
export type CategoryId = string;

/** URL-safe slug of a channel, e.g. `auto-il`. */
export type ChannelSlug = string;

/** URL-safe slug of a tag. */
export type TagSlug = string;

/** A category as shown in the filter bar and on `/category/:slug`. */
export interface Category {
  readonly id: CategoryId;
  readonly name: string;
  readonly description: string;
  /** Icon key. Legacy Font Awesome names are mapped in `src/ui/icons.ts`. */
  readonly icon: string;
  /**
   * The two ends of the category's gradient, as CSS colours.
   *
   * The legacy site hard-coded a Tailwind gradient class per category in the
   * JavaScript bundle; storing the colours instead means an editor can restyle
   * a category from the admin, and a new category does not need a deployment.
   */
  readonly colorFrom: string;
  readonly colorTo: string;
  readonly sortOrder: number;
  readonly isVisible: boolean;
  /** Number of published videos. Present on list endpoints, omitted elsewhere. */
  readonly videoCount?: number;
}

/** A YouTube channel represented in the catalog. */
export interface Channel {
  readonly id: number;
  readonly slug: ChannelSlug;
  readonly name: string;
  readonly description: string;
  readonly imageUrl: string | null;
  /** Canonical YouTube URL of the channel. */
  readonly youtubeUrl: string | null;
  readonly youtubeChannelId: string | null;
  readonly isFeatured: boolean;
  readonly isVisible: boolean;
  readonly videoCount?: number;
}

/** A free-form tag attached to videos. */
export interface Tag {
  readonly id: number;
  readonly slug: TagSlug;
  readonly name: string;
  readonly videoCount?: number;
}

/** A car manufacturer, e.g. Hyundai. */
export interface Manufacturer {
  readonly id: number;
  readonly slug: string;
  readonly name: string;
  /** Hebrew spelling, when it differs from `name`. */
  readonly nameHe: string | null;
}

/** A model belonging to a manufacturer, e.g. i40. */
export interface VehicleModel {
  readonly id: number;
  readonly manufacturerId: number;
  readonly slug: string;
  readonly name: string;
  readonly nameHe: string | null;
}

/** The reference to a channel embedded in a video payload. */
export interface VideoChannelRef {
  readonly slug: ChannelSlug;
  readonly name: string;
  readonly imageUrl: string | null;
}

/**
 * The compact form used by grids, carousels, search results and related lists.
 * Everything a card needs to render, and nothing more.
 */
export interface VideoSummary {
  readonly id: VideoId;
  readonly title: string;
  readonly categoryId: CategoryId;
  readonly categoryName: string;
  readonly channel: VideoChannelRef | null;
  readonly durationSeconds: number;
  /** ISO date the video was added to CAR-טיב. */
  readonly addedAt: string;
  /** ISO date the video was published on YouTube, when known. */
  readonly publishedAt: string | null;
  /** Explicit override, or `null` to derive the YouTube thumbnail from the id. */
  readonly thumbnailUrl: string | null;
  readonly isHebrew: boolean;
  readonly isFeatured: boolean;
  /** A short slice of the video's tags, for the card footer. */
  readonly tags: readonly string[];
  /**
   * The opening of the description, capped in SQL.
   *
   * Enough for the list view to fill the space beside the thumbnail on a wide
   * screen, without a listing response carrying a full description per row.
   */
  readonly excerpt: string;
}

/** The full document behind `/video/:id`. */
export interface VideoDetail extends VideoSummary {
  readonly description: string;
  readonly status: VideoStatus;
  readonly language: string;
  readonly vehicles: readonly VideoVehicle[];
  readonly updatedAt: string;

  /**
   * Present only when the caller asked for `?include=related`.
   *
   * `null` means "not requested"; an empty array means "requested, and there
   * are none". The video page needs that distinction — one is a section still
   * to be filled, the other is a section to hide.
   */
  readonly related?: readonly VideoSummary[] | null;

  /** The channel's other videos. Present only with `?include=channel`. */
  readonly channelVideos?: readonly VideoSummary[] | null;
}

/** A vehicle a video applies to, with an optional model-year range. */
export interface VideoVehicle {
  readonly manufacturer: string;
  readonly model: string;
  readonly yearFrom: number | null;
  readonly yearTo: number | null;
}

/** Filters accepted by the catalog listing endpoint. */
export interface VideoQuery {
  /** Free-text search. Empty string means "no search". */
  readonly q: string;
  /** A category id, or the sentinel `'all'` meaning every category. */
  readonly category: CategoryId;
  readonly channel: ChannelSlug | null;
  readonly tags: readonly TagSlug[];
  readonly manufacturer: string | null;
  readonly model: string | null;
  readonly year: number | null;
  /** Restrict to Hebrew-language content. */
  readonly hebrewOnly: boolean;
  /** Restrict to videos an editor has marked as featured. */
  readonly featuredOnly: boolean;
  readonly minDurationSeconds: number | null;
  readonly maxDurationSeconds: number | null;
  readonly sort: SortOption;
  readonly page: number;
  readonly limit: number;
}

/** A single autocomplete row under the search box. */
export interface SearchSuggestion {
  readonly type: 'video' | 'tag' | 'channel' | 'category' | 'manufacturer' | 'model';
  /** Human-readable label to show. */
  readonly label: string;
  /** Where selecting the row should navigate to. */
  readonly href: string;
  /** Optional secondary line, e.g. the channel name of a video. */
  readonly hint?: string;
}

/** A configurable row of videos on the home page. */
export interface HomeSection {
  readonly id: string;
  readonly title: string;
  readonly type:
    | 'recent'
    | 'featured'
    | 'popular'
    | 'category'
    | 'channel'
    | 'continue-watching'
    | 'for-your-car';
  /** Where "see all" should link to, when the section has a dedicated page. */
  readonly href: string | null;
  readonly videos: readonly VideoSummary[];
}

/** Aggregate counters shown in the hero and in the admin dashboard. */
export interface CatalogStats {
  readonly videos: number;
  readonly channels: number;
  readonly categories: number;
  readonly addedThisWeek: number;
}
