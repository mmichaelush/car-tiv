-- ============================================================================
-- 0007 — Scheduled maintenance
--
-- Two columns on `videos` and one table, all in service of one question:
-- "which of these 7,900 YouTube links still work?"
--
-- `check_failures` exists so a video is not marked broken the first time
-- YouTube answers oddly. A link has to fail twice, on two separate runs an
-- hour or more apart, before it is taken out of public listings — which makes
-- a YouTube incident a delay rather than a mass mis-flagging.
-- ============================================================================

ALTER TABLE videos ADD COLUMN last_checked_at TEXT;
ALTER TABLE videos ADD COLUMN check_failures INTEGER NOT NULL DEFAULT 0;

-- Drives "which videos are due": never-checked first (NULL sorts first in
-- SQLite), then oldest-checked.
CREATE INDEX idx_videos_check_due ON videos (last_checked_at)
  WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- One row per scheduled run, so the admin can answer "is the checker actually
-- running?" — a silent cron job is indistinguishable from a deleted one.
-- ---------------------------------------------------------------------------
CREATE TABLE maintenance_runs (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  ran_at             TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  checked            INTEGER NOT NULL DEFAULT 0,
  broken             INTEGER NOT NULL DEFAULT 0,
  recovered          INTEGER NOT NULL DEFAULT 0,
  sessions_pruned    INTEGER NOT NULL DEFAULT 0,
  rate_limits_pruned INTEGER NOT NULL DEFAULT 0,
  duration_ms        INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_maintenance_runs_recent ON maintenance_runs (ran_at DESC);
