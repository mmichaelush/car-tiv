# API

כל תשובה — הצלחה או כישלון — נראית אותו דבר:

```json
{ "data": …, "meta": { … }, "error": null }
{ "data": null, "meta": {}, "error": { "code": "VALIDATION_ERROR", "message": "…", "fields": { "email": "…" } } }
```

לכן יש בצד הלקוח מסלול קריאה אחד. **מסתעפים לפי `error.code`, אף פעם לא לפי `message`** —
ההודעה היא טקסט למשתמש ויכולה להשתנות.

## קודי שגיאה

| קוד                   | HTTP | מתי                                         |
| --------------------- | ---- | ------------------------------------------- |
| `VALIDATION_ERROR`    | 422  | שדות לא תקינים. `fields` מכיל הודעה לכל שדה |
| `BAD_REQUEST`         | 400  | הבקשה עצמה שגויה                            |
| `INVALID_VIDEO_ID`    | 400  | מזהה YouTube לא תקין                        |
| `NOT_FOUND`           | 404  | נתיב או משאב לא קיים                        |
| `VIDEO_NOT_FOUND`     | 404  | הסרטון לא במאגר                             |
| `DUPLICATE`           | 409  | כבר קיים                                    |
| `UNAUTHORIZED`        | 401  | נדרשת התחברות                               |
| `FORBIDDEN`           | 403  | אין הרשאה, או origin לא מורשה               |
| `RATE_LIMITED`        | 429  | חריגה מהמכסה. יש כותרת `Retry-After`        |
| `PAYLOAD_TOO_LARGE`   | 413  | גוף הבקשה מעל 32KB                          |
| `SERVICE_UNAVAILABLE` | 503  | D1 לא זמין                                  |
| `INTERNAL_ERROR`      | 500  | שגיאה לא צפויה                              |

---

## קטלוג

### `GET /api/videos`

ה-endpoint שכל עמוד משתמש בו: דף הבית, קטגוריה, ערוץ, חיפוש ו"לרכב שלי".

| פרמטר                           | ערך                                                                                             | הערה                             |
| ------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------- |
| `q`                             | טקסט                                                                                            | פחות משני תווים — מתעלמים        |
| `category`                      | slug או `all`                                                                                   |                                  |
| `channel`                       | slug                                                                                            |                                  |
| `tags`                          | slugs מופרדים בפסיק                                                                             | **AND** — כל תגית מצמצמת         |
| `manufacturer`, `model`, `year` |                                                                                                 | סינון לפי רכב                    |
| `hebrew`                        | `1`                                                                                             | עברית בלבד                       |
| `featured`                      | `1`                                                                                             | מומלצים בלבד                     |
| `minDuration`, `maxDuration`    | שניות                                                                                           |                                  |
| `sort`                          | `date-desc` (ברירת מחדל), `date-asc`, `duration-asc`, `duration-desc`, `title-asc`, `relevance` | עם `q` ברירת המחדל היא רלוונטיות |
| `page`, `limit`                 |                                                                                                 | `limit` נחתך ל-60                |

ערך לא חוקי **נחתך לברירת מחדל ולא מוחזר כשגיאה** — כתובת שנערכה ביד לא אמורה
להחזיר 500.

`meta`: `{ page, limit, total, pages }`.

### `GET /api/videos/:id`

המסמך המלא: תיאור, תגיות, רכבים תואמים. 404 אם לא מפורסם.

**`?include=related,channel`** מוסיף לאותה תשובה את `related` (הסרטונים
הדומים) ואת `channelVideos` (עוד מהערוץ, בלי הסרטון הנוכחי). זה מה שהופך עמוד
סרטון משלוש קריאות API לאחת.

בלי הפרמטר שני השדות **אינם קיימים** בתשובה — לא `null`, אלא נעדרים — כך ששום
קורא קיים לא רואה שינוי. עם הפרמטר, `null` פירושו "לא התבקש" ומערך ריק פירושו
"התבקש ואין". עמוד הסרטון צריך את ההבחנה: אחד הוא מקטע שעוד ימולא, השני מקטע
שצריך להסתיר. שם לא מוכר ב-`include` נעלם בשקט ולא מפיל את העמוד.

### `GET /api/videos/:id/related`

6–12 סרטונים, מדורגים לפי: אותו דגם 5, אותו יצרן 4, אותה קטגוריה 3,
תגית משותפת 2 (עד שלוש), אותו ערוץ 1, בונוס טריות 1.

### `GET /api/videos/exists?value=`

בדיקת כפילות. מקבל כתובת YouTube בכל צורה או מזהה חשוף.
מחזיר `{ id, exists, published, pending }`.

### `GET /api/categories` · `GET /api/channels` · `GET /api/channels/:slug`

### `GET /api/tags?category=` · `GET /api/tags/search?q=`

### `GET /api/search/suggestions?q=`

עד 7 הצעות, מעורבות: יצרנים, תגיות, ערוצים, קטגוריות וסרטונים.

### `GET /api/home`

כל מה שדף הבית צריך בבקשה אחת: מונים, קטגוריות, המקטעים לפי `home_sections`,
וערוצים מומלצים.

### `GET /api/stats` · `GET /api/health`

---

## קלט מהמבקר

לכל אחד מאלה, בסדר הזה: בדיקת origin → rate limit → ולידציה → כתיבה.

| Endpoint                | מכסה   | הערות                                     |
| ----------------------- | ------ | ----------------------------------------- |
| `POST /api/reports`     | 10/שעה | דיווח על תקלה בסרטון קיים                 |
| `POST /api/feedback`    | 10/שעה | הערה או מידע נוסף                         |
| `POST /api/submissions` | 5/שעה  | הצעת סרטון; כפילות → 409                  |
| `POST /api/contact`     | 5/שעה  | פותח thread; דורש `acceptedPrivacy: true` |

הזיהוי למכסה הוא hash מלוח של כתובת ה-IP. הכתובת עצמה לא נשמרת ולא נרשמת בלוג.

---

## ניהול — `/api/admin/*`

כל בקשה דורשת `Authorization: Bearer <token>`. כל תשובה `no-store`.

| Endpoint                                         |                                                                   |
| ------------------------------------------------ | ----------------------------------------------------------------- |
| `GET /admin/session`                             | אימות הטוקן                                                       |
| `GET /admin/overview`                            | מונים, תיבות פתוחות, פעילות, חיפושי אפס                           |
| `GET /admin/videos`                              | הטבלה: `q`, `status`, `category`, `hasReports`, `missingMetadata` |
| `PATCH /admin/videos/:id`                        | עריכת סרטון                                                       |
| `POST /admin/videos/bulk`                        | שינוי אחיד לרבים                                                  |
| `POST /admin/videos/tags?mode=add\|remove`       | תגית לרבים                                                        |
| `POST /admin/videos/delete?mode=delete\|restore` | מחיקה רכה והחזרה                                                  |
| `GET /admin/inbox/:name`                         | `reports` · `feedback` · `submissions` · `contact`                |
| `PATCH /admin/inbox/:name/:id`                   | שינוי סטטוס + הערה פנימית                                         |
| `GET /admin/search-insights?days=`               | חיפושי אפס־תוצאות ופופולריים                                      |
| `GET /admin/maintenance`                         | כיסוי בדיקת הקישורים והריצות האחרונות                             |
| `POST /admin/maintenance/run`                    | הרצת הבדיקה עכשיו (admin בלבד)                                    |
| `GET /admin/resources`                           | נפח מוערך מול מגבלת התוכנית, גדילה לחודש ותחזית                   |
| `POST /admin/counters/refresh`                   | ריענון המונים המתוחזקים עכשיו (~200ms)                            |

כל כתיבה נרשמת ב-`admin_audit_log` עם snapshot לפני ואחרי.

### ייבוא מקובץ

הקובץ עצמו **לא מגיע לשרת**. דפדפן הניהול קורא אותו, ממפה עמודות ומאמת כל שורה
עם `shared/core/import-mapping.ts`; ה-Worker מאמת שוב עם אותן פונקציות ורק אז
כותב. כך מה שהוצג בתצוגה המקדימה הוא בדיוק מה שנשמר, ובקשה מזויפת לא יכולה
לעקוף בדיקה.

| Endpoint                           |                                     |
| ---------------------------------- | ----------------------------------- |
| `GET /admin/imports`               | 20 הייבואים האחרונים                |
| `POST /admin/imports`              | פתיחת job; מחזיר `id` ו-`batchSize` |
| `GET /admin/imports/:id`           | ה-job + שגיאות שורה־שורה            |
| `POST /admin/imports/:id/rows`     | באץ' אחד (עד `batchSize` שורות)     |
| `POST /admin/imports/:id/complete` | סגירת ה-job                         |

`options` חייב לכלול `defaultCategoryId`: `videos.category_id` הוא `NOT NULL`,
וייבוא לא יוצר קטגוריות — שגיאת כתיב בקובץ לא תוסיף קטגוריה אחת־עשרה.

---

## חשבונות — `/api/auth/*`

התחברות עם Google, ב-authorization code flow שרץ כולו בשרת. ה-`client_secret`
לא עוזב את ה-Worker, ושום טוקן של Google לא נשמר — לוקחים את הזהות ומוחקים את
השאר.

| Endpoint                         |                                                      |
| -------------------------------- | ---------------------------------------------------- |
| `GET /auth/google/start?return=` | 302 ל-Google + עוגיית `state` קצרת־חיים              |
| `GET /auth/google/callback`      | מאמת `state`, מחליף קוד, פותח סשן ומחזיר לאן שהתחילו |
| `GET /auth/session`              | מי מחובר, ואם ההתחברות בכלל מוגדרת בשרת              |
| `POST /auth/logout`              | ביטול הסשן הנוכחי                                    |
| `POST /auth/logout-everywhere`   | ביטול כל הסשנים של החשבון                            |

הסשן הוא עוגייה `__Host-session`: `HttpOnly`, `Secure`, `SameSite=Lax`. בבסיס
הנתונים נשמר רק ה-SHA-256 של הטוקן, כך שדליפה של `sessions` לא ניתנת לשחזור
כהתחברות. `return` חייב להיות נתיב באותו origin — `//evil.example` נדחה.

## ספרייה אישית — `/api/me/*`

כל endpoint דורש חשבון ופועל רק על השורות שלו; מזהה המשתמש מגיע מהסשן ולעולם
לא מהבקשה.

| Endpoint                                                   |                                               |
| ---------------------------------------------------------- | --------------------------------------------- |
| `GET /me/library`                                          | הכל בבקשה אחת, כולל snapshot של כל סרטון      |
| `POST /me/favorites` · `DELETE /me/favorites/:videoId`     | מועדפים                                       |
| `POST /me/watch-later` · `DELETE /me/watch-later/:videoId` | צפייה מאוחר יותר                              |
| `POST /me/history` · `DELETE /me/history[/:videoId]`       | היסטוריה והתקדמות צפייה                       |
| `POST /me/playlists` · `PATCH`/`DELETE /me/playlists/:id`  | פלייליסטים                                    |
| `POST /me/playlists/:id/items`                             | הוספה, או סדר חדש עם `videoIds`               |
| `DELETE /me/playlists/:id/items/:videoId`                  | הסרה מפלייליסט                                |
| `POST /me/follows` · `DELETE /me/follows/:slug`            | מעקב אחרי ערוץ                                |
| `POST /me/merge`                                           | העברת הספרייה המקומית לחשבון — פעם אחת למכשיר |

---

## Sitemap

`/sitemap.xml` הוא אינדקס. תחתיו `/sitemap-pages.xml` וקבצי
`/sitemap-videos-N.xml` בני 5,000 כתובות. נבנים מ-D1 ונשמרים ב-edge ליממה.
