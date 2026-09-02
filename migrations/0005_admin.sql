-- ============================================================================
-- 0005 — Admin tooling
--
-- Audit log, bulk import bookkeeping, editorial collections, configurable home
-- sections and feature flags. The admin is a first-class part of the system,
-- not a side panel: everything an editor changes is recorded and reversible.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Audit log. Every write an editor makes lands here with a before/after
-- snapshot, which is what makes "who changed this video and when" answerable
-- and gives Undo something to restore from.
-- ---------------------------------------------------------------------------
CREATE TABLE admin_audit_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       TEXT          REFERENCES users (id) ON DELETE SET NULL,
  action        TEXT NOT NULL,
  entity_type   TEXT NOT NULL,
  entity_id     TEXT NOT NULL,
  -- JSON snapshots. NULL on create (nothing before) and on delete (nothing after).
  before_json   TEXT,
  after_json    TEXT,
  -- Groups the rows written by one bulk operation, so the whole batch can be
  -- reviewed or undone together.
  batch_id      TEXT,
  created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_audit_entity ON admin_audit_log (entity_type, entity_id, created_at DESC);
CREATE INDEX idx_audit_user   ON admin_audit_log (user_id, created_at DESC);
CREATE INDEX idx_audit_batch  ON admin_audit_log (batch_id);

-- ---------------------------------------------------------------------------
-- Bulk import. An import is never applied straight from the uploaded file:
-- upload → parse → validate → preview → confirm → import, with the job row
-- tracking where it got to and the error table explaining every rejected row.
-- ---------------------------------------------------------------------------
CREATE TABLE import_jobs (
  id             TEXT    PRIMARY KEY,
  filename       TEXT    NOT NULL,
  source_format  TEXT    NOT NULL CHECK (source_format IN ('json', 'csv', 'xlsx', 'youtube-urls')),
  created_by     TEXT             REFERENCES users (id) ON DELETE SET NULL,
  status         TEXT    NOT NULL DEFAULT 'parsing'
                         CHECK (status IN ('parsing', 'validated', 'importing', 'completed', 'failed', 'cancelled')),
  -- Column mapping chosen in the preview step, as JSON.
  mapping_json   TEXT    NOT NULL DEFAULT '{}',
  total_rows     INTEGER NOT NULL DEFAULT 0,
  valid_rows     INTEGER NOT NULL DEFAULT 0,
  duplicate_rows INTEGER NOT NULL DEFAULT 0,
  invalid_rows   INTEGER NOT NULL DEFAULT 0,
  imported_rows  INTEGER NOT NULL DEFAULT 0,
  error_message  TEXT    NOT NULL DEFAULT '',
  created_at     TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at   TEXT
);

CREATE INDEX idx_import_jobs_recent ON import_jobs (created_at DESC);

CREATE TABLE import_job_errors (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id      TEXT    NOT NULL REFERENCES import_jobs (id) ON DELETE CASCADE,
  row_number  INTEGER NOT NULL,
  field       TEXT    NOT NULL DEFAULT '',
  error_code  TEXT    NOT NULL,
  message     TEXT    NOT NULL,
  -- The original row, so an editor can fix it without re-opening the file.
  raw_json    TEXT    NOT NULL DEFAULT '{}'
);

CREATE INDEX idx_import_errors_job ON import_job_errors (job_id, row_number);

-- ---------------------------------------------------------------------------
-- Editorial collections — an admin-curated list, as opposed to a visitor's
-- playlist. "A guide to periodic servicing", "best videos for beginners".
-- ---------------------------------------------------------------------------
CREATE TABLE collections (
  id           TEXT    PRIMARY KEY,
  slug         TEXT    NOT NULL UNIQUE,
  title        TEXT    NOT NULL,
  description  TEXT    NOT NULL DEFAULT '',
  image_url    TEXT,
  is_visible   INTEGER NOT NULL DEFAULT 1 CHECK (is_visible IN (0, 1)),
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_by   TEXT             REFERENCES users (id) ON DELETE SET NULL,
  created_at   TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE collection_items (
  collection_id  TEXT    NOT NULL REFERENCES collections (id) ON DELETE CASCADE,
  video_id       TEXT    NOT NULL REFERENCES videos (id)      ON DELETE CASCADE,
  position       INTEGER NOT NULL,
  note           TEXT    NOT NULL DEFAULT '',
  PRIMARY KEY (collection_id, video_id)
);

CREATE INDEX idx_collection_items_order ON collection_items (collection_id, position);

-- ---------------------------------------------------------------------------
-- Home page composition.
--
-- The home page is a list of rows read from this table, so re-ordering it or
-- adding "New safety reviews" is an admin action, not a deployment.
-- `filter_json` is a serialised `VideoQuery`.
-- ---------------------------------------------------------------------------
CREATE TABLE home_sections (
  id           TEXT    PRIMARY KEY,
  title        TEXT    NOT NULL,
  subtitle     TEXT    NOT NULL DEFAULT '',
  type         TEXT    NOT NULL
                       CHECK (type IN ('recent', 'featured', 'popular', 'trending',
                                       'category', 'channel', 'collection',
                                       'continue-watching', 'for-your-car')),
  filter_json  TEXT    NOT NULL DEFAULT '{}',
  item_limit   INTEGER NOT NULL DEFAULT 12 CHECK (item_limit BETWEEN 1 AND 24),
  -- Optional "see all" destination.
  link_href    TEXT,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  is_visible   INTEGER NOT NULL DEFAULT 1 CHECK (is_visible IN (0, 1)),
  -- Personalised sections are skipped for signed-out visitors.
  requires_account INTEGER NOT NULL DEFAULT 0 CHECK (requires_account IN (0, 1)),
  updated_at   TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_home_sections_order ON home_sections (is_visible, sort_order);

-- ---------------------------------------------------------------------------
-- Feature flags, so code can ship before a feature is open to everyone.
-- Environment variables win over this table; see worker/services/flags.ts.
-- ---------------------------------------------------------------------------
CREATE TABLE feature_flags (
  key          TEXT    PRIMARY KEY,
  description  TEXT    NOT NULL DEFAULT '',
  is_enabled   INTEGER NOT NULL DEFAULT 0 CHECK (is_enabled IN (0, 1)),
  updated_at   TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by   TEXT             REFERENCES users (id) ON DELETE SET NULL
);

-- ---------------------------------------------------------------------------
-- Daily usage counters, so approaching a Cloudflare free-tier limit is visible
-- before it becomes an outage. Written by the scheduled maintenance job.
-- ---------------------------------------------------------------------------
CREATE TABLE usage_daily (
  day             TEXT    PRIMARY KEY,
  worker_requests INTEGER NOT NULL DEFAULT 0,
  rows_read       INTEGER NOT NULL DEFAULT 0,
  rows_written    INTEGER NOT NULL DEFAULT 0,
  api_errors      INTEGER NOT NULL DEFAULT 0,
  updated_at      TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
);
