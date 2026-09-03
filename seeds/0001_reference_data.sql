-- ============================================================================
-- Reference data.
--
-- Idempotent: safe to run against an existing database. Rows an editor may have
-- customised are not overwritten — only missing rows are inserted.
--
--   wrangler d1 execute car-tiv-dev --local --file=./seeds/0001_reference_data.sql
-- ============================================================================

-- --------------------------------------------------------------------------
-- Categories. Names, descriptions and icons carried over from the legacy
-- `PREDEFINED_CATEGORIES` list so no category disappears in the migration.
-- --------------------------------------------------------------------------
INSERT OR IGNORE INTO categories (id, name, description, icon, color_from, color_to, sort_order) VALUES
  ('review',          'סקירות רכב',          'מבחנים והשוואות',                  'magnifying-glass-chart', '#7c3aed', '#5b21b6', 10),
  ('maintenance',     'טיפולים',             'תחזוקה שוטפת ומניעתית',            'oil-can',                '#2563eb', '#4338ca', 20),
  ('diy',             'עשה זאת בעצמך',       'מדריכי תיקונים ותחזוקה',           'screwdriver-wrench',     '#10b981', '#059669', 30),
  ('troubleshooting', 'איתור ותיקון תקלות',  'אבחון ופתרון בעיות',               'microscope',             '#f97316', '#d97706', 40),
  ('systems',         'מערכות הרכב',         'הסברים על מכלולים וטכנולוגיות',    'gears',                  '#0891b2', '#0369a1', 50),
  ('safety',          'מבחני בטיחות',        'מבחני ריסוק וציוני בטיחות',        'shield-halved',          '#dc2626', '#be123c', 60),
  ('driving',         'נהיגה נכונה',         'טיפים לנהיגה בכביש ובשטח',         'road',                   '#14b8a6', '#059669', 70),
  ('offroad',         'שטח ו־4X4',           'טיולים, עבירות וחילוצים',          'mountain',               '#ca8a04', '#9a3412', 80),
  ('upgrades',        'שיפורים ושדרוגים',    'שדרוג הרכב והוספת אביזרים',        'rocket',                 '#c026d3', '#be185d', 90),
  ('collectors',      'רכבי אספנות',         'רכבים נוסטלגיים שחזרו לכביש',      'car-side',               '#fbbf24', '#ca8a04', 100);

-- --------------------------------------------------------------------------
-- Roles.
-- --------------------------------------------------------------------------
INSERT OR IGNORE INTO roles (id, name, description) VALUES
  ('admin',     'מנהל ראשי', 'גישה מלאה, כולל משתמשים והרשאות'),
  ('editor',    'עורך',      'עריכת סרטונים, קטגוריות, ערוצים ותגיות'),
  ('moderator', 'מנחה',      'טיפול בדיווחים, פניות והצעות סרטונים'),
  ('user',      'משתמש',     'חשבון רגיל: מועדפים, פלייליסטים והיסטוריה');

-- --------------------------------------------------------------------------
-- Home page composition. Order and visibility are editable from the admin.
-- --------------------------------------------------------------------------
INSERT OR IGNORE INTO home_sections (id, title, subtitle, type, filter_json, item_limit, link_href, sort_order, requires_account) VALUES
  ('continue-watching', 'המשך צפייה',        'חזרו לאן שהפסקתם',                'continue-watching', '{}',                        8,  '/library/',            10, 1),
  ('for-your-car',      'לרכב שלך',          'תוכן שמתאים לרכב ששמרתם',         'for-your-car',      '{}',                        12, '/search',              20, 1),
  ('recent',            'נוספו לאחרונה',     'הסרטונים החדשים במאגר',           'recent',            '{}',                        12, '/search?sort=date-desc', 30, 0),
  ('featured',          'מומלצי המערכת',     'סרטונים שבחרנו עבורכם',           'featured',          '{}',                        8,  NULL,                   40, 0),
  ('maintenance',       'טיפולים',           'תחזוקה שוטפת ומניעתית',           'category',          '{"category":"maintenance"}', 8, '/category/maintenance', 50, 0),
  ('diy',               'עשה זאת בעצמך',     'מדריכי תיקונים צעד אחר צעד',      'category',          '{"category":"diy"}',         8, '/category/diy',         60, 0),
  ('review',            'סקירות חדשות',      'מבחני דרך והשוואות',              'category',          '{"category":"review"}',      8, '/category/review',      70, 0),
  ('popular',           'מהארכיון',          'סרטונים ותיקים שכדאי לגלות מחדש',  'recent',            '{"sort":"date-asc"}',      8,  '/search?sort=date-asc', 80, 0);

-- --------------------------------------------------------------------------
-- Feature flags. Environment variables in wrangler.jsonc take precedence;
-- these rows let an admin flip a feature without a deployment.
-- --------------------------------------------------------------------------
INSERT OR IGNORE INTO feature_flags (key, description, is_enabled) VALUES
  ('accounts',        'הרשמה והתחברות לחשבון',                 0),
  ('playlists',       'פלייליסטים אישיים',                     1),
  ('myCar',           'שמירת רכב אישי וסינון לפיו',            1),
  ('recommendations', 'המלצות מותאמות אישית',                  1),
  ('submissions',     'טופס הצעת סרטון פנימי (במקום Google)',  0),
  ('contactInbox',    'ניהול פניות בתוך המערכת',               0),
  ('following',       'מעקב אחרי ערוצים',                      0),
  ('staticCatalog',   'מצב חירום: קטלוג מקבצים סטטיים',        0);

-- --------------------------------------------------------------------------
-- Search synonyms. Hebrew car vocabulary where people use several words for
-- the same part. Both sides are stored normalised (see shared/core/text.ts).
-- --------------------------------------------------------------------------
INSERT OR IGNORE INTO search_synonyms (term, synonym) VALUES
  ('מזגנ',        'מיזוג'),
  ('מיזוג',       'מזגנ'),
  ('גיר',         'תיבת הילוכימ'),
  ('תיבת הילוכימ', 'גיר'),
  ('בלמימ',       'ברקסימ'),
  ('ברקסימ',      'בלמימ'),
  ('צמיגימ',      'גלגלימ'),
  ('מצתימ',       'פלגימ'),
  ('אלטרנטור',    'דינמו'),
  ('דינמו',       'אלטרנטור'),
  ('מצבר',        'בטריה'),
  ('בטריה',       'מצבר'),
  ('טורבו',       'מגדש'),
  ('שמנ מנוע',    'החלפת שמנ'),
  ('טסט',         'מבחנ רישוי'),
  ('טיפול',       'שירות');
