-- ============================================================================
-- 0009 — Search log rollup, and two constraints that were only ever comments
--
-- ## Why the search log had to change
--
-- `search_logs` stored one row per search. `GET /api/videos?q=…` is a public,
-- unauthenticated endpoint with no rate limit, so anyone could walk
-- `?q=a00001`, `?q=a00002`, … and mint a new D1 **write** with every request:
-- each distinct query misses the edge cache, reaches the handler, and inserts.
--
-- The free plan allows 100,000 writes a day. A single script could spend all of
-- them in minutes and take the site's real writes down with it — and it would
-- look like ordinary search traffic the whole time.
--
-- The fix is to stop storing an event and start storing a count. One row per
-- (normalised query, day) with a counter turns unbounded growth into a bounded
-- table: at most one row per distinct search per day, and a repeat of a popular
-- search is an UPDATE of a row that already exists rather than another INSERT.
--
-- It also makes the report better. "27 people searched for X and found nothing"
-- was previously a `GROUP BY` over every row ever logged; now it is the counter.
--
-- The old table is kept and renamed rather than dropped: it holds real editorial
-- signal about what visitors could not find, and throwing that away to save a
-- few hundred kilobytes would be a poor trade. The retention pass ages it out.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- One row per normalised query per day.
--
-- `query` is the output of `indexText`, so spelling and niqqud variants
-- aggregate together; `raw_query` keeps one example of what was actually typed
-- so an editor reads Hebrew rather than a normalised form.
-- ---------------------------------------------------------------------------
CREATE TABLE search_query_daily (
  day           TEXT    NOT NULL,
  query         TEXT    NOT NULL,
  raw_query     TEXT    NOT NULL DEFAULT '',
  -- How many searches. The counter that replaces one row per search.
  hits          INTEGER NOT NULL DEFAULT 0,
  -- Results the most recent search returned. Zero is the interesting case.
  result_count  INTEGER NOT NULL DEFAULT 0,
  -- Searches on this day that returned nothing at all.
  zero_hits     INTEGER NOT NULL DEFAULT 0,
  category_id   TEXT,
  updated_at    TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (day, query)
);

-- "What did people search for recently", and the zero-result report.
CREATE INDEX idx_search_daily_recent ON search_query_daily (day DESC, hits DESC);
CREATE INDEX idx_search_daily_zero   ON search_query_daily (zero_hits DESC, day DESC)
  WHERE zero_hits > 0;

-- Carry the existing log across, so the reports keep their history.
INSERT INTO search_query_daily (day, query, raw_query, hits, result_count, zero_hits, category_id)
SELECT substr(created_at, 1, 10),
       query,
       MAX(raw_query),
       COUNT(*),
       CAST(AVG(result_count) AS INTEGER),
       SUM(CASE WHEN result_count = 0 THEN 1 ELSE 0 END),
       MAX(category_id)
FROM search_logs
GROUP BY substr(created_at, 1, 10), query;

-- ---------------------------------------------------------------------------
-- Exactly one primary vehicle per user.
--
-- `0002_users_and_access.sql` says "exactly one marked primary" and then does
-- not enforce it, so nothing stopped three rows all claiming to be primary and
-- the UI picking whichever the query returned first. A partial unique index is
-- the enforcement the comment was describing.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX idx_user_vehicles_primary
  ON user_vehicles (user_id) WHERE is_primary = 1;

-- ---------------------------------------------------------------------------
-- The link checker needs to record that it *tried*.
--
-- `last_checked_at` is only written on a definite answer, so a video that keeps
-- timing out keeps its old timestamp — and `videosDueForCheck` orders by that
-- column. A YouTube incident could therefore pin the same 200 videos at the
-- head of the queue on every run, forever, while the other 7,600 were never
-- checked at all. Recording the attempt separately lets the queue move on
-- without pretending the video was verified.
-- ---------------------------------------------------------------------------
ALTER TABLE videos ADD COLUMN last_attempted_at TEXT;

CREATE INDEX idx_videos_check_queue ON videos (last_attempted_at)
  WHERE deleted_at IS NULL;
