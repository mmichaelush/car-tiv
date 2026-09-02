-- ============================================================================
-- 0003 — Personal library
--
-- Favourites, playlists, watch history and saved searches. Every table here has
-- a guest-mode counterpart in IndexedDB with the same field names; sign-in
-- merges the two, it does not translate between them.
--
-- "Watch later" is a system playlist rather than its own table, so the playlist
-- UI (reorder, remove, move between lists) works on it for free.
-- ============================================================================

CREATE TABLE favorites (
  user_id     TEXT NOT NULL REFERENCES users (id)  ON DELETE CASCADE,
  video_id    TEXT NOT NULL REFERENCES videos (id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, video_id)
);

CREATE INDEX idx_favorites_recent ON favorites (user_id, created_at DESC);
CREATE INDEX idx_favorites_video  ON favorites (video_id);

CREATE TABLE playlists (
  id           TEXT    PRIMARY KEY,
  user_id      TEXT    NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name         TEXT    NOT NULL,
  description  TEXT    NOT NULL DEFAULT '',
  visibility   TEXT    NOT NULL DEFAULT 'private'
                       CHECK (visibility IN ('private', 'unlisted')),
  -- Built-in lists such as "Watch later" cannot be renamed or deleted.
  is_system    INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0, 1)),
  -- Identifies which built-in list this is, e.g. `watch-later`.
  system_key   TEXT,
  created_at   TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- A visitor has at most one of each system list.
CREATE UNIQUE INDEX idx_playlists_system ON playlists (user_id, system_key)
  WHERE system_key IS NOT NULL;
CREATE INDEX idx_playlists_user ON playlists (user_id, updated_at DESC);

CREATE TABLE playlist_items (
  playlist_id  TEXT    NOT NULL REFERENCES playlists (id) ON DELETE CASCADE,
  video_id     TEXT    NOT NULL REFERENCES videos (id)    ON DELETE CASCADE,
  -- Sparse ordering (10, 20, 30...) so a drag-and-drop reorder rewrites one row
  -- rather than the whole list.
  position     INTEGER NOT NULL,
  added_at     TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (playlist_id, video_id)
);

CREATE INDEX idx_playlist_items_order ON playlist_items (playlist_id, position);

-- ---------------------------------------------------------------------------
-- Watch history and "continue watching".
--
-- `progress_seconds` is written with a debounce from the client — never on
-- every tick of the player — and only when the visitor has left
-- `user_settings.save_history` on.
-- ---------------------------------------------------------------------------
CREATE TABLE watch_history (
  user_id           TEXT    NOT NULL REFERENCES users (id)  ON DELETE CASCADE,
  video_id          TEXT    NOT NULL REFERENCES videos (id) ON DELETE CASCADE,
  progress_seconds  INTEGER NOT NULL DEFAULT 0 CHECK (progress_seconds >= 0),
  is_completed      INTEGER NOT NULL DEFAULT 0 CHECK (is_completed IN (0, 1)),
  watch_count       INTEGER NOT NULL DEFAULT 1,
  last_watched_at   TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, video_id)
);

CREATE INDEX idx_watch_history_recent ON watch_history (user_id, last_watched_at DESC);
-- Powers "continue watching": started but not finished.
CREATE INDEX idx_watch_history_unfinished ON watch_history (user_id, is_completed, last_watched_at DESC);

-- ---------------------------------------------------------------------------
-- Saved filters and searches. `query_json` stores a serialised `VideoQuery`,
-- so a saved search survives the addition of new filter fields.
-- ---------------------------------------------------------------------------
CREATE TABLE saved_searches (
  id          TEXT NOT NULL PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  query_json  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_saved_searches_user ON saved_searches (user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Following a channel, for "what is new in the channels I follow".
-- ---------------------------------------------------------------------------
CREATE TABLE channel_follows (
  user_id     TEXT    NOT NULL REFERENCES users (id)    ON DELETE CASCADE,
  channel_id  INTEGER NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
  created_at  TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, channel_id)
);

CREATE INDEX idx_channel_follows_channel ON channel_follows (channel_id);
