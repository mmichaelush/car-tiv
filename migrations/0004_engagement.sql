-- ============================================================================
-- 0004 — Visitor input: reports, feedback, submissions, contact and rate limits
--
-- Everything a visitor can send us. All four inbox tables share the same
-- status vocabulary so the admin can render them with one component, and all
-- four accept anonymous input, which is why they carry a hashed sender
-- fingerprint instead of a user id.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- "Report a problem with this video" — a defect, not an opinion.
-- ---------------------------------------------------------------------------
CREATE TABLE video_reports (
  id             TEXT PRIMARY KEY,
  video_id       TEXT NOT NULL REFERENCES videos (id) ON DELETE CASCADE,
  user_id        TEXT          REFERENCES users (id)  ON DELETE SET NULL,
  reason         TEXT NOT NULL
                      CHECK (reason IN ('broken', 'removed', 'wrong-details',
                                        'wrong-category', 'inaccurate-title',
                                        'inappropriate', 'other')),
  message        TEXT NOT NULL DEFAULT '',
  contact_email  TEXT,
  status         TEXT NOT NULL DEFAULT 'new'
                      CHECK (status IN ('new', 'reviewing', 'waiting', 'resolved', 'closed')),
  admin_note     TEXT NOT NULL DEFAULT '',
  -- SHA-256 of the client IP. Used only for rate limiting and abuse review.
  reporter_hash  TEXT,
  created_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  handled_at     TEXT,
  handled_by     TEXT          REFERENCES users (id)  ON DELETE SET NULL
);

CREATE INDEX idx_reports_open  ON video_reports (status, created_at DESC);
CREATE INDEX idx_reports_video ON video_reports (video_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- "Send a note about this video" — extra knowledge, not a defect.
-- Example: "this also fits the Hyundai i30".
-- ---------------------------------------------------------------------------
CREATE TABLE video_feedback (
  id             TEXT PRIMARY KEY,
  video_id       TEXT NOT NULL REFERENCES videos (id) ON DELETE CASCADE,
  user_id        TEXT          REFERENCES users (id)  ON DELETE SET NULL,
  message        TEXT NOT NULL,
  contact_email  TEXT,
  status         TEXT NOT NULL DEFAULT 'new'
                      CHECK (status IN ('new', 'reviewing', 'waiting', 'resolved', 'closed')),
  admin_note     TEXT NOT NULL DEFAULT '',
  sender_hash    TEXT,
  created_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  handled_at     TEXT,
  handled_by     TEXT          REFERENCES users (id)  ON DELETE SET NULL
);

CREATE INDEX idx_feedback_open  ON video_feedback (status, created_at DESC);
CREATE INDEX idx_feedback_video ON video_feedback (video_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- "Suggest a video". Replaces the Google Form once validated in production.
-- The partial unique index makes a second pending submission of the same video
-- impossible at the database level, not just in application code.
-- ---------------------------------------------------------------------------
CREATE TABLE video_submissions (
  id                  TEXT PRIMARY KEY,
  youtube_id          TEXT NOT NULL CHECK (length(youtube_id) = 11),
  youtube_url         TEXT NOT NULL DEFAULT '',
  title               TEXT NOT NULL DEFAULT '',
  suggested_category  TEXT          REFERENCES categories (id) ON DELETE SET NULL,
  message             TEXT NOT NULL DEFAULT '',
  submitter_name      TEXT NOT NULL DEFAULT '',
  submitter_email     TEXT,
  user_id             TEXT          REFERENCES users (id) ON DELETE SET NULL,
  status              TEXT NOT NULL DEFAULT 'new'
                           CHECK (status IN ('new', 'reviewing', 'approved', 'rejected', 'duplicate')),
  admin_note          TEXT NOT NULL DEFAULT '',
  submitter_hash      TEXT,
  created_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  handled_at          TEXT,
  handled_by          TEXT          REFERENCES users (id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX idx_submissions_pending_unique ON video_submissions (youtube_id)
  WHERE status IN ('new', 'reviewing');
CREATE INDEX idx_submissions_status ON video_submissions (status, created_at DESC);

-- ---------------------------------------------------------------------------
-- General contact. Modelled as threads so a reply is a message, not an email
-- that lives outside the system.
-- ---------------------------------------------------------------------------
CREATE TABLE contact_threads (
  id          TEXT PRIMARY KEY,
  user_id     TEXT          REFERENCES users (id) ON DELETE SET NULL,
  name        TEXT NOT NULL DEFAULT '',
  email       TEXT,
  subject     TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'new'
                   CHECK (status IN ('new', 'reviewing', 'waiting', 'resolved', 'closed')),
  admin_note  TEXT NOT NULL DEFAULT '',
  sender_hash TEXT,
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_contact_threads_status ON contact_threads (status, updated_at DESC);

CREATE TABLE contact_messages (
  id           TEXT PRIMARY KEY,
  thread_id    TEXT NOT NULL REFERENCES contact_threads (id) ON DELETE CASCADE,
  sender_type  TEXT NOT NULL CHECK (sender_type IN ('visitor', 'staff')),
  sender_id    TEXT          REFERENCES users (id) ON DELETE SET NULL,
  message      TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_contact_messages_thread ON contact_messages (thread_id, created_at);

-- ---------------------------------------------------------------------------
-- Rate limiting.
--
-- A fixed-window counter keyed by (fingerprint, action, window start). Cheap:
-- one upsert per write request, and no row is ever read for a GET. Expired
-- windows are removed by the scheduled maintenance job.
-- ---------------------------------------------------------------------------
CREATE TABLE rate_limits (
  key            TEXT    NOT NULL,
  action         TEXT    NOT NULL,
  -- Unix epoch seconds, floored to the start of the window.
  window_start   INTEGER NOT NULL,
  request_count  INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (key, action, window_start)
);

CREATE INDEX idx_rate_limits_window ON rate_limits (window_start);

-- ---------------------------------------------------------------------------
-- Search logs, anonymous. The point is the zero-result report: "27 people
-- searched for 'החלפת משאבת ABS' and found nothing" tells an editor exactly
-- what content is missing.
-- ---------------------------------------------------------------------------
CREATE TABLE search_logs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Normalised query text, so spelling variants aggregate together.
  query          TEXT    NOT NULL,
  -- The query exactly as typed, for the admin to read.
  raw_query      TEXT    NOT NULL DEFAULT '',
  result_count   INTEGER NOT NULL DEFAULT 0,
  category_id    TEXT,
  created_at     TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_search_logs_query ON search_logs (query, created_at DESC);
CREATE INDEX idx_search_logs_zero  ON search_logs (result_count, created_at DESC);
