-- The home page had a section that claimed something the data cannot support.
--
-- "הנצפים ביותר / מה שאחרים צופים בו עכשיו" — most watched, what others are
-- watching now. `HomeService` resolves a `popular` section to `sort: date-desc`,
-- with a comment saying so, because nothing writes `video_stats.view_count`.
-- So the row directly under "נוספו לאחרונה" was the same eight videos in the
-- same order, presented as a popularity ranking. A visitor cannot tell that
-- from a bug in the ranking; they can only conclude the site is not very good
-- at knowing what is popular.
--
-- The obvious fix — start counting views — is the wrong one on this plan. A
-- view counter is a D1 **write** on the single most-visited route, and the free
-- plan allows 100,000 writes a day against 100,000 requests: the whole budget,
-- spent on a number that decorates one row. `migrations/0012` exists because a
-- much smaller version of that arithmetic was already costing too much.
--
-- So the section becomes something the catalog can actually answer, and that is
-- genuinely different from the row above it rather than a second copy of it:
-- the oldest videos in the catalog. Nothing else on the home page ever shows
-- them — every other row is newest-first — so this is the only way a visitor
-- meets the archive without searching for it.
--
-- The `popular` and `trending` section *types* stay in the schema and in
-- `HomeService`. They are not being removed; they are unused until there is a
-- view count worth ordering by, and the day there is, a section of that type is
-- one INSERT away.
--
-- The row keeps its `recent` type and states its order in `filter_json`, which
-- `HomeService` now honours instead of overriding — so this is a configuration
-- change, not a new section kind, and `home_sections`' CHECK constraint stays
-- exactly as it is.

UPDATE home_sections
   SET title       = 'מהארכיון',
       subtitle    = 'סרטונים ותיקים שכדאי לגלות מחדש',
       type        = 'recent',
       filter_json = '{"sort":"date-asc"}',
       link_href   = '/search?sort=date-asc'
 WHERE id = 'popular';
