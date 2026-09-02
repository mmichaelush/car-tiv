-- ============================================================================
-- 0008 — Maintained counters
--
-- Why this migration exists, in one measurement.
--
-- `/api/tags` answered "which tags are popular?" by joining 7,876 live videos
-- to 59,255 `video_tags` rows and grouping. That is ~127,000 rows read for one
-- request. D1's free plan allows 5,000,000 rows read per day, so **39 requests
-- to that one endpoint would exhaust a day's budget**. `/api/categories`,
-- `/api/stats` and `/api/channels` had the same shape on a smaller scale: a
-- correlated `COUNT(*)` per row, each one a full pass over the catalog.
--
-- The fix is the standard one: stop counting at read time. Every number that a
-- visitor sees but only an editor can change becomes a stored column, refreshed
-- by `worker/repositories/counters-repository.ts` — after an import, after an admin
-- write, and hourly from the cron as a safety net. Reads become a bounded index
-- scan of a few dozen rows.
--
-- The trade is staleness, and it is a trade worth making: a category chip
-- reading "820 videos" when the true number became 821 a minute ago is not a
-- defect anyone can perceive. Correctness that matters — which videos a listing
-- actually returns — still comes from the live tables on every request.
--
-- Nothing here is a cache that can silently rot: `counters_refreshed_at` is
-- shown in the admin dashboard, so a refresh job that stopped running is
-- visible rather than merely wrong.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Denormalised live-video counts.
--
-- "Live" means exactly what the public API means by it: published and not
-- soft-deleted. The refresh service owns these columns; nothing else writes
-- them, so there is one place to look when a number is wrong.
-- ---------------------------------------------------------------------------
ALTER TABLE categories ADD COLUMN video_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE channels   ADD COLUMN video_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tags       ADD COLUMN video_count INTEGER NOT NULL DEFAULT 0;

-- `/api/tags` in full: seek to the visible tags, walk them in popularity order,
-- stop at LIMIT. No join, no GROUP BY, no temp B-tree.
CREATE INDEX idx_tags_popular ON tags (is_visible, video_count DESC, name);

-- `/api/channels` orders by exactly this tuple, so the whole ORDER BY is
-- satisfied by the index and the query stops at LIMIT instead of sorting 416
-- rows it will not return.
CREATE INDEX idx_channels_ranked
  ON channels (is_visible, is_featured DESC, featured_order, video_count DESC, name);

-- ---------------------------------------------------------------------------
-- Popular tags *within* a category — the filter panel on `/category/:id`.
--
-- Materialised rather than computed, because the computation is the expensive
-- one above with an extra filter. Only tags that actually appear in a category
-- get a row, so this stays proportional to real usage: at the present catalog
-- it is roughly 13,000 rows, well under a megabyte.
-- ---------------------------------------------------------------------------
CREATE TABLE category_tag_counts (
  category_id  TEXT    NOT NULL REFERENCES categories (id) ON DELETE CASCADE,
  tag_id       INTEGER NOT NULL REFERENCES tags (id)       ON DELETE CASCADE,
  video_count  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (category_id, tag_id)
);

-- The only way this table is ever read: most-used tags in one category.
CREATE INDEX idx_category_tag_counts_popular
  ON category_tag_counts (category_id, video_count DESC, tag_id);

-- ---------------------------------------------------------------------------
-- Catalog-wide counters.
--
-- Keyed rather than a fixed-column singleton so a new counter is a new key
-- instead of a new migration. Keys in use are listed in
-- `worker/repositories/counters-repository.ts`; an unknown key reads as 0, which is
-- why every consumer treats a missing counter as "not computed yet" and not as
-- "the catalog is empty".
-- ---------------------------------------------------------------------------
CREATE TABLE catalog_counters (
  key         TEXT    PRIMARY KEY,
  value       INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Seeded so the first read after deploy returns a row rather than nothing.
--
-- `updated_at` is deliberately set to the epoch rather than to now. The admin
-- dashboard warns when the counters are more than a day stale, and a freshly
-- migrated database whose refresh has never run is *exactly* the case worth
-- warning about — seeding it with the deploy time would suppress that warning
-- for the first 24 hours, which is precisely when a missing cron trigger or a
-- forgotten post-import refresh needs to be noticed.
INSERT INTO catalog_counters (key, value, updated_at) VALUES
  ('videos.live',          0, '1970-01-01 00:00:00'),
  ('videos.addedThisWeek', 0, '1970-01-01 00:00:00'),
  ('channels.visible',     0, '1970-01-01 00:00:00'),
  ('categories.visible',   0, '1970-01-01 00:00:00'),
  ('tags.visible',         0, '1970-01-01 00:00:00');

-- ---------------------------------------------------------------------------
-- Table growth samples.
--
-- D1 reports database size through its HTTP API, not through SQL, so the
-- Worker cannot read its own size. What it *can* do is record how many rows
-- each unbounded table holds, once a day. Multiplied by the measured bytes per
-- row in `docs/performance.md`, that answers the only question that matters:
-- at this rate, when does the catalog reach 500 MB?
--
-- One row per table per day; a year of ten tables is 3,650 rows.
-- ---------------------------------------------------------------------------
CREATE TABLE table_growth_samples (
  day         TEXT    NOT NULL,
  table_name  TEXT    NOT NULL,
  row_count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, table_name)
);

CREATE INDEX idx_table_growth_recent ON table_growth_samples (table_name, day DESC);

-- ---------------------------------------------------------------------------
-- What the retention pass deleted, per run. Extends `maintenance_runs` rather
-- than adding a second table, so "what did the cron do last night?" is still
-- answered by reading one row.
-- ---------------------------------------------------------------------------
ALTER TABLE maintenance_runs ADD COLUMN rows_pruned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE maintenance_runs ADD COLUMN counters_refreshed INTEGER NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- Retention needs to find old rows cheaply. Without these, deleting last
-- month's search logs is itself a full table scan — which would make the
-- clean-up job more expensive than the thing it cleans up.
-- ---------------------------------------------------------------------------
CREATE INDEX idx_search_logs_created ON search_logs (created_at);
CREATE INDEX idx_audit_created       ON admin_audit_log (created_at);
CREATE INDEX idx_watch_history_aged  ON watch_history (last_watched_at);
