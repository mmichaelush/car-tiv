-- ---------------------------------------------------------------------------
-- Which catalog files have been imported, and what they cost.
--
-- ## Why a table and not a row count
--
-- The importer used to decide by asking `SELECT COUNT(*) FROM videos` and
-- importing the whole catalog when the answer was zero. That is a correct
-- decision exactly twice: on an empty database, and on a finished one. It has
-- nothing to say about the state in between — and the state in between is the
-- normal one, because the full catalog costs 338,860 rows written and D1's
-- free plan allows 100,000 a day.
--
-- Measured, not estimated: `npm run catalog:cost` walks the generated SQL
-- against the real schema and counts what each file writes, including the
-- index writes Cloudflare bills for and the FTS5 shadow rows. The headline
-- number is not 7,876 videos. A video is one row in `videos` and six index
-- writes; a `video_tags` row costs three; the whole import is three and a half
-- days of the daily budget.
--
-- So an import that runs to the end of the day stops in the middle, and the
-- next deploy has to know where. One row per applied file is the smallest
-- thing that can answer both questions this needs:
--
--   * what still has to be applied — the files not listed here;
--   * how much of today's budget is already spent — `SUM(rows_written)` for
--     today's UTC date, which is what D1's daily counter resets on.
--
-- ## Not a migrations table
--
-- `wrangler d1 migrations apply` keeps its own; this is deliberately separate.
-- A migration changes the schema and runs once for ever. A catalog file is
-- data, is regenerated from `data/videos/*.json` whenever that changes, and is
-- re-appliable by design — every one of them is idempotent, so a file
-- interrupted mid-way can simply be applied again.
--
-- `rows_written` is the estimate from the manifest, not a measurement of what
-- D1 actually charged. It is used to pace the import, and it is deliberately
-- on the pessimistic side of the truth: spending less of the budget than the
-- estimate says costs an extra day, spending more costs a day of failed
-- writes.
-- ---------------------------------------------------------------------------
CREATE TABLE catalog_import_log (
  -- The generated file name, e.g. `0020_video_tags.sql`.
  file          TEXT PRIMARY KEY,
  -- UTC date, `YYYY-MM-DD`. D1's daily budget resets at 00:00 UTC, so this is
  -- the key the pacing arithmetic groups by — a local date would reset the
  -- budget at the wrong moment for most of the world.
  applied_on    TEXT NOT NULL,
  rows_written  INTEGER NOT NULL DEFAULT 0,
  applied_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Today's spend is the only query that runs against this on every deploy.
CREATE INDEX idx_catalog_import_day ON catalog_import_log (applied_on);
