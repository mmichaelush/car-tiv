-- Stop the search log paying for indexes it cannot use.
--
-- ## What this costs today
--
-- `logSearch` upserts one row per (day, normalised query) on every search that
-- reaches the Worker — which is every search that misses the response cache,
-- and a distinct query always does. That was already the fix for the previous
-- design (see 0009: one row per *search* was an unbounded write amplifier on a
-- public endpoint). What 0009 did not account for is that the upsert does not
-- write one row. It writes the table row and then rewrites every index entry
-- whose columns changed, and both indexes it created lead with a column that
-- changes on **every single upsert**:
--
--   idx_search_daily_recent (day DESC, hits DESC)      -- `hits` increments
--   idx_search_daily_zero   (zero_hits DESC, day DESC) -- `zero_hits` increments
--
-- So one search cost two row writes, or three when it found nothing. Against a
-- free-plan budget of 100,000 writes a day — shared with the catalog, the
-- counters and everything else — search alone could account for two thirds of
-- it while looking, in the code, like a single cheap statement.
--
-- ## Why the counter columns were never doing any work there
--
-- Neither reporting query can use them. Both group across days:
--
--   SELECT query, SUM(hits) … WHERE day >= ? GROUP BY query ORDER BY hits DESC
--
-- The ordering is on the *aggregate*, which no index over the individual rows
-- can satisfy — SQLite has to materialise the groups and sort them either way.
-- The only part of either index that was ever used is the leading `day` range,
-- and the zero-result report additionally uses the partial predicate to skip
-- the rows it does not care about.
--
-- Dropping the counters from the keys therefore costs nothing at read time and
-- halves the write cost of a search: `day` and `query` do not change when
-- `hits` increments, so the index entries stay put. A search that finds nothing
-- still writes the partial index once — on the day it first finds nothing —
-- rather than on every repeat.
--
-- Measured by `tests/worker/query-cost.test.ts`, which counts the writes rather
-- than trusting this comment.

DROP INDEX IF EXISTS idx_search_daily_recent;
DROP INDEX IF EXISTS idx_search_daily_zero;

-- The range both reports scan, and nothing else.
CREATE INDEX idx_search_daily_day ON search_query_daily (day DESC);

-- The zero-result report reads a small minority of rows; the partial predicate
-- is what keeps it from scanning the whole day.
CREATE INDEX idx_search_daily_zero ON search_query_daily (day DESC)
  WHERE zero_hits > 0;
