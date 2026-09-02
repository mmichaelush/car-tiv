-- ============================================================================
-- 0002 — Accounts, roles and preferences
--
-- Accounts are behind the `FEATURE_ACCOUNTS` flag: the schema ships first so
-- that guest data (kept in IndexedDB) has somewhere to be merged into the day
-- sign-in is switched on. Nothing in this migration is required for the public
-- catalog to work.
--
-- There is deliberately no `is_admin` column. Permissions are roles, checked in
-- worker/middleware/auth.ts, so a moderator can handle reports without also
-- being able to delete the catalog.
-- ============================================================================

CREATE TABLE users (
  id             TEXT PRIMARY KEY,
  email          TEXT UNIQUE,
  display_name   TEXT NOT NULL DEFAULT '',
  avatar_url     TEXT,
  status         TEXT NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'suspended', 'deleted')),
  created_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_login_at  TEXT
);

CREATE INDEX idx_users_status ON users (status, created_at DESC);

-- ---------------------------------------------------------------------------
-- Roles. Seeded in seeds/0001_reference_data.sql.
-- ---------------------------------------------------------------------------
CREATE TABLE roles (
  id           TEXT PRIMARY KEY CHECK (id IN ('admin', 'editor', 'moderator', 'user')),
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT ''
);

CREATE TABLE user_roles (
  user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role_id     TEXT NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
  granted_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  granted_by  TEXT          REFERENCES users (id) ON DELETE SET NULL,
  PRIMARY KEY (user_id, role_id)
);

CREATE INDEX idx_user_roles_role ON user_roles (role_id, user_id);

-- ---------------------------------------------------------------------------
-- Sessions. Opaque, hashed tokens: the raw token exists only in the visitor's
-- cookie, so a database leak cannot be replayed as a login.
-- ---------------------------------------------------------------------------
CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- SHA-256 of the session token.
  token_hash   TEXT NOT NULL UNIQUE,
  user_agent   TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at   TEXT NOT NULL,
  revoked_at   TEXT
);

CREATE INDEX idx_sessions_user ON sessions (user_id, expires_at DESC);
CREATE INDEX idx_sessions_expiry ON sessions (expires_at);

-- ---------------------------------------------------------------------------
-- Preferences. Mirrors the guest preference object stored in IndexedDB, so
-- merging on sign-in is a field-by-field copy with no translation layer.
-- `preferences_json` holds anything added later without needing a migration.
-- ---------------------------------------------------------------------------
CREATE TABLE user_settings (
  user_id           TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  theme             TEXT    NOT NULL DEFAULT 'system',
  accent            TEXT    NOT NULL DEFAULT 'purple',
  density           TEXT    NOT NULL DEFAULT 'comfortable'
                            CHECK (density IN ('compact', 'comfortable', 'large')),
  view_mode         TEXT    NOT NULL DEFAULT 'grid'
                            CHECK (view_mode IN ('grid', 'list', 'compact')),
  default_sort      TEXT    NOT NULL DEFAULT 'date-desc',
  results_per_page  INTEGER NOT NULL DEFAULT 24 CHECK (results_per_page BETWEEN 6 AND 60),
  hebrew_only       INTEGER NOT NULL DEFAULT 0 CHECK (hebrew_only IN (0, 1)),
  autoplay          INTEGER NOT NULL DEFAULT 0 CHECK (autoplay IN (0, 1)),
  infinite_scroll   INTEGER NOT NULL DEFAULT 0 CHECK (infinite_scroll IN (0, 1)),
  save_history      INTEGER NOT NULL DEFAULT 1 CHECK (save_history IN (0, 1)),
  language          TEXT    NOT NULL DEFAULT 'he',
  preferences_json  TEXT    NOT NULL DEFAULT '{}',
  updated_at        TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ---------------------------------------------------------------------------
-- "My car". A visitor may register several vehicles — their own, a spouse's, a
-- previous car — with exactly one marked primary.
-- ---------------------------------------------------------------------------
CREATE TABLE user_vehicles (
  id               TEXT    PRIMARY KEY,
  user_id          TEXT    NOT NULL REFERENCES users (id)           ON DELETE CASCADE,
  manufacturer_id  INTEGER          REFERENCES manufacturers (id)   ON DELETE SET NULL,
  model_id         INTEGER          REFERENCES vehicle_models (id)  ON DELETE SET NULL,
  -- Free text kept alongside the ids so a car we do not have in the reference
  -- data is still usable.
  manufacturer_name TEXT   NOT NULL DEFAULT '',
  model_name        TEXT   NOT NULL DEFAULT '',
  year             INTEGER,
  engine           TEXT,
  variant          TEXT,
  nickname         TEXT,
  is_primary       INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  created_at       TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_user_vehicles_user ON user_vehicles (user_id, is_primary DESC);
