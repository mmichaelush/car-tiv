-- ============================================================================
-- 0001 — Catalog core
--
-- Categories, channels, videos, tags and the vehicle model that lets a visitor
-- ask for "Hyundai i40 2012 maintenance". Everything a public page reads lives
-- in this migration; users, moderation and admin tooling come later so this
-- file stays readable.
--
-- Conventions used by every migration in this folder:
--   * snake_case table and column names; `id` is the primary key.
--   * timestamps are ISO-8601 TEXT in UTC, defaulting to CURRENT_TIMESTAMP.
--   * booleans are INTEGER 0/1 with an explicit CHECK.
--   * every foreign key states its ON DELETE behaviour.
--   * soft delete via `deleted_at`; rows are never removed by the application.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Categories. Seeded in seeds/0001_reference_data.sql, editable from the admin.
-- The id is the URL slug (`/category/maintenance`), so it is stable and human
-- readable rather than an autoincrement number.
-- ---------------------------------------------------------------------------
CREATE TABLE categories (
  id           TEXT PRIMARY KEY,
  name         TEXT    NOT NULL,
  description  TEXT    NOT NULL DEFAULT '',
  -- Font Awesome icon name without the `fa-` prefix, e.g. `oil-can`.
  icon         TEXT    NOT NULL DEFAULT 'film',
  -- Two brand colours used for the category chip gradient.
  color_from   TEXT    NOT NULL DEFAULT '',
  color_to     TEXT    NOT NULL DEFAULT '',
  sort_order   INTEGER NOT NULL DEFAULT 0,
  is_visible   INTEGER NOT NULL DEFAULT 1 CHECK (is_visible IN (0, 1)),
  created_at   TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_categories_visible_order ON categories (is_visible, sort_order);

-- ---------------------------------------------------------------------------
-- Channels. In the legacy JSON the channel name and avatar were repeated on
-- every video row; normalising them here is what makes "more from this channel"
-- and channel pages possible, and removes ~8000 duplicated strings.
-- ---------------------------------------------------------------------------
CREATE TABLE channels (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  slug                TEXT    NOT NULL UNIQUE,
  name                TEXT    NOT NULL,
  -- YouTube's own channel id (UC...), when known. Unique but nullable, because
  -- the legacy catalog only carries display names.
  youtube_channel_id  TEXT    UNIQUE,
  youtube_url         TEXT,
  image_url           TEXT,
  description         TEXT    NOT NULL DEFAULT '',
  is_featured         INTEGER NOT NULL DEFAULT 0 CHECK (is_featured IN (0, 1)),
  is_visible          INTEGER NOT NULL DEFAULT 1 CHECK (is_visible IN (0, 1)),
  featured_order      INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_channels_featured ON channels (is_featured DESC, featured_order, name);
CREATE INDEX idx_channels_visible ON channels (is_visible);

-- ---------------------------------------------------------------------------
-- Manufacturers and models. Richer than a free-text tag: a video can be filed
-- against "Hyundai i40, 2011-2019" and matched to a visitor's own car.
-- ---------------------------------------------------------------------------
CREATE TABLE manufacturers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  slug        TEXT    NOT NULL UNIQUE,
  name        TEXT    NOT NULL,
  -- Hebrew spelling, so "יונדאי" and "Hyundai" resolve to the same row.
  name_he     TEXT,
  is_visible  INTEGER NOT NULL DEFAULT 1 CHECK (is_visible IN (0, 1)),
  created_at  TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE vehicle_models (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  manufacturer_id  INTEGER NOT NULL REFERENCES manufacturers (id) ON DELETE CASCADE,
  slug             TEXT    NOT NULL,
  name             TEXT    NOT NULL,
  name_he          TEXT,
  year_from        INTEGER,
  year_to          INTEGER,
  created_at       TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (manufacturer_id, slug)
);

CREATE INDEX idx_vehicle_models_manufacturer ON vehicle_models (manufacturer_id, name);

-- ---------------------------------------------------------------------------
-- Videos. The primary key is the 11-character YouTube id: it is the natural
-- key, it is what duplicate detection compares, and it keeps `/video/:id` URLs
-- identical to the ones the old site handed out.
-- ---------------------------------------------------------------------------
CREATE TABLE videos (
  id                TEXT    PRIMARY KEY
                            CHECK (length(id) = 11),
  title             TEXT    NOT NULL,
  description       TEXT    NOT NULL DEFAULT '',
  category_id       TEXT    NOT NULL REFERENCES categories (id) ON DELETE RESTRICT,
  channel_id        INTEGER          REFERENCES channels (id)   ON DELETE SET NULL,
  duration_seconds  INTEGER NOT NULL DEFAULT 0 CHECK (duration_seconds >= 0),
  -- BCP-47 language tag. `he` for Hebrew content, `en` for the rest.
  language          TEXT    NOT NULL DEFAULT 'he',
  is_hebrew         INTEGER NOT NULL DEFAULT 1 CHECK (is_hebrew IN (0, 1)),
  -- When the video was published on YouTube (may be unknown for legacy rows).
  published_at      TEXT,
  -- When it was added to CAR-טיב. Drives "recently added" and default sorting.
  added_at          TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Editor-supplied image. NULL means "derive from the YouTube id".
  thumbnail_url     TEXT,
  status            TEXT    NOT NULL DEFAULT 'published'
                            CHECK (status IN ('draft', 'pending', 'published', 'hidden', 'broken', 'removed')),
  is_featured       INTEGER NOT NULL DEFAULT 0 CHECK (is_featured IN (0, 1)),
  -- Internal editorial note. Never sent to the public API.
  admin_note        TEXT    NOT NULL DEFAULT '',
  -- Soft delete. Public queries filter on `deleted_at IS NULL`.
  deleted_at        TEXT,
  created_at        TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- The single index every public listing uses: live rows, newest first.
CREATE INDEX idx_videos_live_added   ON videos (status, deleted_at, added_at DESC);
CREATE INDEX idx_videos_category     ON videos (category_id, added_at DESC);
CREATE INDEX idx_videos_channel      ON videos (channel_id, added_at DESC);
CREATE INDEX idx_videos_featured     ON videos (is_featured, added_at DESC);
CREATE INDEX idx_videos_duration     ON videos (duration_seconds);
CREATE INDEX idx_videos_updated      ON videos (updated_at DESC);

-- ---------------------------------------------------------------------------
-- Tags. `slug` is the normalised form produced by shared/core/text.ts, so
-- "יונדאי", "יונדאי " and "Hyundai" can be merged by an editor without losing
-- the display spelling.
-- ---------------------------------------------------------------------------
CREATE TABLE tags (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  slug        TEXT    NOT NULL UNIQUE,
  name        TEXT    NOT NULL,
  is_visible  INTEGER NOT NULL DEFAULT 1 CHECK (is_visible IN (0, 1)),
  created_at  TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE video_tags (
  video_id  TEXT    NOT NULL REFERENCES videos (id) ON DELETE CASCADE,
  tag_id    INTEGER NOT NULL REFERENCES tags (id)   ON DELETE CASCADE,
  PRIMARY KEY (video_id, tag_id)
);

-- Reverse lookup: every video carrying a tag.
CREATE INDEX idx_video_tags_tag ON video_tags (tag_id, video_id);

-- ---------------------------------------------------------------------------
-- Which vehicles a video applies to.
-- ---------------------------------------------------------------------------
CREATE TABLE video_vehicle_models (
  video_id   TEXT    NOT NULL REFERENCES videos (id)         ON DELETE CASCADE,
  model_id   INTEGER NOT NULL REFERENCES vehicle_models (id) ON DELETE CASCADE,
  year_from  INTEGER,
  year_to    INTEGER,
  PRIMARY KEY (video_id, model_id)
);

CREATE INDEX idx_video_vehicles_model ON video_vehicle_models (model_id, video_id);

-- ---------------------------------------------------------------------------
-- Full-text search.
--
-- A standalone FTS5 table rather than an external-content one: the indexed
-- document is a *join* (title + description + channel name + tags + vehicle
-- names), which triggers on `videos` alone cannot produce. It is therefore
-- maintained explicitly by `worker/repositories/search-index-repository.ts`,
-- which every admin write path calls. `npm run catalog:import` rebuilds it from
-- scratch, and the importer writes its own rows as it goes.
--
-- `remove_diacritics 2` folds Hebrew niqqud, matching shared/core/text.ts.
-- ---------------------------------------------------------------------------
CREATE VIRTUAL TABLE videos_fts USING fts5 (
  video_id UNINDEXED,
  title,
  manufacturers,
  models,
  tags,
  description,
  channel,
  tokenize = 'unicode61 remove_diacritics 2'
);

-- ---------------------------------------------------------------------------
-- Search synonyms, so "מזגן" also finds "מיזוג" and "גיר" finds
-- "תיבת הילוכים". Applied at query time by the search service.
-- ---------------------------------------------------------------------------
CREATE TABLE search_synonyms (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Both sides are stored in the normalised (indexed) form.
  term        TEXT NOT NULL,
  synonym     TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (term, synonym)
);

CREATE INDEX idx_search_synonyms_term ON search_synonyms (term);

-- ---------------------------------------------------------------------------
-- Aggregated per-video counters. Kept in a separate table so a view counter
-- update never touches (and never invalidates the cache of) the `videos` row.
-- Updated in batches, never on every card impression.
-- ---------------------------------------------------------------------------
CREATE TABLE video_stats (
  video_id      TEXT    PRIMARY KEY REFERENCES videos (id) ON DELETE CASCADE,
  view_count    INTEGER NOT NULL DEFAULT 0,
  -- Rolling 7-day count used by "trending".
  recent_views  INTEGER NOT NULL DEFAULT 0,
  favorites     INTEGER NOT NULL DEFAULT 0,
  updated_at    TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_video_stats_popular ON video_stats (view_count DESC);
CREATE INDEX idx_video_stats_trending ON video_stats (recent_views DESC);
