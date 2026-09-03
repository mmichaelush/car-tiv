-- ---------------------------------------------------------------------------
-- More reasons to report a video.
--
-- The reason list is a CHECK constraint, and SQLite cannot alter one — the
-- table has to be rebuilt. That is the whole reason this migration is longer
-- than the change it makes.
--
-- What is being added, and why each earns a place. A reason list that is too
-- short does not stop people reporting; it pushes everything into "משהו אחר"
-- with a free-text note, which is the same work for the reporter and much more
-- work for the editor, who then has to read every message to find the pattern.
--
--   netfree-blocked  The one the site exists for. Every video in the catalog is
--                    meant to be watchable behind NetFree's filter, so "this
--                    one is not" is the single most valuable report anyone can
--                    send — it means the video should not be here at all. It
--                    had no reason of its own and was arriving as "other".
--   wrong-vehicle    The detected manufacturer or model is wrong. Distinct from
--                    wrong-details because it is fixable in one place, and it
--                    is what makes "videos for my car" wrong for someone.
--   duplicate        The same video is in the catalog twice. An editor can act
--                    on this immediately; as free text it reads like a
--                    complaint about search.
--   private          YouTube still serves the page, so it is not "removed", but
--                    embedding is disabled or the video is private and it
--                    cannot be watched here. The link checker marks these
--                    broken from a 401/403; a visitor sees it first.
--   poor-quality     Audio or video quality that makes it not worth watching.
--                    Not a defect in our data, which is why it is not "broken".
--
-- Existing rows are carried over unchanged; every current value is still legal.
-- ---------------------------------------------------------------------------

CREATE TABLE video_reports_new (
  id             TEXT PRIMARY KEY,
  video_id       TEXT NOT NULL REFERENCES videos (id) ON DELETE CASCADE,
  user_id        TEXT          REFERENCES users (id)  ON DELETE SET NULL,
  reason         TEXT NOT NULL
                      CHECK (reason IN ('broken', 'removed', 'netfree-blocked',
                                        'private', 'duplicate', 'wrong-details',
                                        'wrong-vehicle', 'wrong-category',
                                        'inaccurate-title', 'poor-quality',
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

INSERT INTO video_reports_new
  (id, video_id, user_id, reason, message, contact_email, status, admin_note,
   reporter_hash, created_at, handled_at, handled_by)
SELECT
   id, video_id, user_id, reason, message, contact_email, status, admin_note,
   reporter_hash, created_at, handled_at, handled_by
FROM video_reports;

DROP TABLE video_reports;

ALTER TABLE video_reports_new RENAME TO video_reports;

-- Recreated because they belonged to the dropped table.
CREATE INDEX idx_reports_open  ON video_reports (status, created_at DESC);
CREATE INDEX idx_reports_video ON video_reports (video_id, created_at DESC);
