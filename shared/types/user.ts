/**
 * User-facing types: account, preferences and the personal library.
 *
 * Every one of these works in "guest mode" too. The guest implementation keeps
 * the same shapes in IndexedDB, so signing in later is a merge, not a rewrite.
 */

import type { Role } from '../constants.js';
import type { VideoId, VideoSummary } from './catalog.js';

export interface User {
  readonly id: string;
  readonly email: string | null;
  readonly displayName: string;
  readonly avatarUrl: string | null;
  readonly roles: readonly Role[];
  readonly createdAt: string;
}

/** Visual density of the interface. */
export type Density = 'compact' | 'comfortable' | 'large';

/** How the catalog grid lays out cards. */
export type ViewMode = 'grid' | 'list' | 'compact';

/** Named colour schemes. `system` follows the operating system. */
export type ThemeName =
  'system' | 'purple' | 'midnight' | 'ocean' | 'black' | 'light' | 'sepia' | 'contrast';

/**
 * Text size, independent of density.
 *
 * Someone who needs bigger words does not necessarily want bigger cards, so
 * this multiplies the type ramp and nothing else.
 */
export type TextSize = 'small' | 'medium' | 'large' | 'xlarge';

/** Accent colour applied on top of the chosen theme. */
export type AccentName = 'purple' | 'blue' | 'green' | 'orange' | 'gold';

export interface UserPreferences {
  readonly theme: ThemeName;
  readonly accent: AccentName;
  readonly density: Density;
  readonly textSize: TextSize;
  readonly viewMode: ViewMode;
  readonly defaultSort: string;
  readonly resultsPerPage: number;
  readonly hebrewOnly: boolean;
  readonly autoplay: boolean;
  /** `true` loads the next page automatically instead of showing a button. */
  readonly infiniteScroll: boolean;
  readonly saveHistory: boolean;
  /**
   * Suppress non-essential animation regardless of the operating system
   * setting — some people want a calm page on one device only.
   */
  readonly reduceMotion: boolean;
}

/**
 * A filter set the visitor named and kept.
 *
 * `query` is a serialised query string (`?q=…&category=…`) rather than a
 * structured object, so a saved search survives the addition of new filter
 * fields without a migration — `parseQuery` simply ignores what it does not
 * know and clamps what it does.
 */
export interface SavedSearch {
  readonly id: string;
  readonly name: string;
  /** The query string, without the leading `?`. */
  readonly query: string;
  readonly createdAt: string;
}

/** One of the three system lists every visitor has. */
export type LibraryListName = 'favorites' | 'watchLater' | 'history';

/** A stored reference to a video, kept small enough to survive offline. */
export interface LibraryEntry {
  readonly videoId: VideoId;
  /** ISO timestamp of when the entry was created or last touched. */
  readonly savedAt: string;
  /** Snapshot so the list still renders when the API is unreachable. */
  readonly snapshot: VideoSummary | null;
}

/** A history entry additionally remembers playback position. */
export interface HistoryEntry extends LibraryEntry {
  readonly progressSeconds: number;
  readonly completed: boolean;
}

export interface Playlist {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly visibility: 'private' | 'unlisted';
  readonly itemCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** `true` for built-in lists such as "Watch later" that cannot be deleted. */
  readonly isSystem: boolean;
}

export interface PlaylistItem {
  readonly videoId: VideoId;
  readonly position: number;
  readonly addedAt: string;
  readonly snapshot: VideoSummary | null;
}

/** A vehicle the visitor owns, used by the "for your car" filters. */
export interface UserVehicle {
  readonly id: string;
  readonly manufacturer: string;
  readonly model: string;
  readonly year: number | null;
  readonly engine: string | null;
  readonly nickname: string | null;
  readonly isPrimary: boolean;
}
