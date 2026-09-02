# פריסה

## שלוש סביבות

| סביבה       | Worker            | D1                    | מתי                       |
| ----------- | ----------------- | --------------------- | ------------------------- |
| development | `wrangler dev`    | `car-tiv-dev` (מקומי) | פיתוח יומיומי             |
| staging     | `car-tiv-staging` | `car-tiv-staging`     | כל שינוי, לפני production |
| production  | `car-tiv`         | `car-tiv`             | רק אחרי אימות ב-staging   |

## הקמה ראשונית

```bash
# 1. בסיסי נתונים — פעם אחת. מדביקים כל database_id ל-wrangler.jsonc.
npx wrangler d1 create car-tiv-dev
npx wrangler d1 create car-tiv-staging
npx wrangler d1 create car-tiv

# 2. סודות. לא נכנסים ל-git ולא לקוד.
npx wrangler secret put ADMIN_TOKEN    --env staging
npx wrangler secret put SESSION_SECRET --env staging

# התחברות עם Google (אופציונלי — בלעדיהם ההתחברות פשוט לא מוצעת).
npx wrangler secret put GOOGLE_CLIENT_ID     --env staging
npx wrangler secret put GOOGLE_CLIENT_SECRET --env staging

# 3. סכימה
npm run db:migrate:staging
npx wrangler d1 execute car-tiv-staging --env staging --remote --file=./seeds/0001_reference_data.sql

# 4. קטלוג
npm run catalog:build
npx tsx scripts/import-catalog.ts --target=staging

# 5. מונים — חובה אחרי ייבוא ישיר של קטלוג.
#
# מספרי הסרטונים בכל קטגוריה, תגית וערוץ הם עמודות מתוחזקות שמתמלאות
# רק בריענון. בלי הצעד הזה כל המספרים יופיעו כאפס עד ריצת ה-cron
# הראשונה — האתר יעבוד, אבל ייראה ריק. ~200ms.
#
# ייבוא דרך ממשק הניהול מרענן אותם לבד; הסקריפט למעלה לא.
curl -X POST https://<host>/api/admin/counters/refresh \
  -H "authorization: Bearer <ADMIN_TOKEN>"
```

### הגדרת ההתחברות ב-Google Cloud

1. ב-Google Cloud Console → **APIs & Services → Credentials** → _Create
   credentials_ → **OAuth client ID** → _Web application_.
2. תחת **Authorized redirect URIs** מוסיפים בדיוק את הכתובות האלה — Google
   דורש התאמה מדויקת, כולל הסלאש:
   - `https://car-tiv-staging.workers.dev/api/auth/google/callback`
   - `https://car-tiv.workers.dev/api/auth/google/callback`
   - (ולכתובת הסופית של הדומיין, כשעוברים אליו)
3. מעתיקים את ה-Client ID וה-Client secret אל שני הסודות שלמעלה.
4. מפעילים את הדגל: `FEATURE_ACCOUNTS: "true"` ב-`wrangler.jsonc` לסביבה
   הרלוונטית. ב-production הוא כרגע `false` בכוונה — מפעילים אותו רק אחרי
   שההתחברות נבדקה ב-staging.

ה-`redirect_uri` נבנה מ-`APP_URL`, לא מכותרת ה-`Host` של הבקשה — כדי שלא ניתן
יהיה להשפיע עליו מבחוץ. אם `APP_URL` שגוי, Google יחזיר `redirect_uri_mismatch`.

## פריסה שוטפת

```bash
npm run verify            # לא פורסים בלי זה
npm run deploy:staging
```

## הרשימה לפני production

**חובה — שני דברים שנכשלים בשקט:**

1. **`APP_URL` חייב להיות ה-origin האמיתי**, בלי `/` בסוף. הוא בונה את
   ה-redirect URI של Google (חייב להתאים תו-בתו למה שרשום ב-Google Cloud) ואת
   כל הכתובות המוחלטות ב-sitemap. כתובת `workers.dev` אמיתית היא
   `<worker>.<ACCOUNT_SUBDOMAIN>.workers.dev` — תת-הדומיין של החשבון אינו
   אופציונלי. הקובץ נשלח עם placeholder בכוונה; אם הוא נשאר, הקוד נופל חזרה
   ל-origin שממנו הגיעה הבקשה במקום לפלוט כתובת שבורה — אבל **הכניסה עם Google
   עדיין לא תעבוד** עד שתגדירו אותו נכון.

2. **לבדוק שהמטמון באמת עובד.** לכל תשובת API יש כותרת `x-cache`:

   ```bash
   curl -sD - -o /dev/null https://<host>/api/tags | grep -i x-cache   # MISS
   curl -sD - -o /dev/null https://<host>/api/tags | grep -i x-cache   # צריך HIT
   ```

   אם השנייה לא אומרת `HIT`, המטמון לא פועל בפריסה הזאת — ואז כל מבקר מגיע
   ל-D1. הפתרון הוא **דומיין משלכם** ל-Worker. ראו את ההסבר המלא
   ב-[`performance.md`](performance.md#שאלת-ה-workersdev--לקרוא-לפני-production).

3. **לרענן את המונים** אחרי הייבוא הראשון (`POST /api/admin/counters/refresh`),
   אחרת כל המספרים באתר יופיעו כאפס עד ריצת ה-cron הראשונה.

- [ ] `npm run verify` ירוק
- [ ] המיגרציות רצו ב-staging **לפני** ב-production
- [ ] הדוח ב-`build/catalog/report.md` נבדק: מספר השורות במקור = מספר היובאו
- [ ] `/api/health` ב-staging מחזיר את מספר הסרטונים הצפוי
- [ ] חיפוש בעברית ובאנגלית מחזיר תוצאות
- [ ] דף סרטון: נגן, סרטונים דומים, שיתוף, דיווח
- [ ] טפסים: הצעת סרטון, צור קשר — כולל הודעות שגיאה
- [ ] `/privacy/` ו-`/terms/` מכילים את מלוא הטקסט
- [ ] כתובות ישנות מפנות: `?v=`, `?page=channels`, `privacy.html`
- [ ] נבדק ב-320px, 768px ו-1440px
- [ ] נבדק בערכה בהירה ובכהה
- [ ] אין שגיאות בקונסול
- [ ] `ADMIN_TOKEN` הוגדר ב-production — בלעדיו אזור הניהול **סגור**, לא פתוח
- [ ] אם `FEATURE_ACCOUNTS` דלוק: התחברות, יציאה, וסנכרון הספרייה נבדקו בשני
      מכשירים; ה-redirect URI רשום ב-Google
- [ ] ייבוא מקובץ נבדק על קובץ קטן ב-staging, כולל שורות פגומות
- [ ] ה-PWA: המניפסט נטען, אפשר להתקין, ומצב לא־מקוון מציג את `/offline.html`
- [ ] ה-Cron Trigger פעיל: אחרי שעה יש שורה ב-`maintenance_runs`, ולוח הבקרה
      מציג "ריצה אחרונה". `npx wrangler tail --env production` מראה את ה-log
- [ ] בדיקת הקישורים נבדקה ידנית מלוח הבקרה ולא סימנה סרטונים תקינים כשבורים

## מעבר מ-Netlify

האתר הקיים נשאר באוויר עד שהחדש מאומת. הסדר:

```
Netlify (production)  →  Cloudflare staging  →  בדיקות  →  Cloudflare production
       נשאר פעיל                                              →  העברת הדומיין
```

אין להעביר את הדומיין לפני שכל הסעיפים למעלה מסומנים.
אין למחוק את `data/videos/*.json` לפני שהייבוא הוכח ב-production.

## מכסות ה-free tier

100,000 בקשות Worker ביום; D1: 5 מיליון שורות נקראות ביום, 100 אלף נכתבות,
500 MB לכל מסד.

מה שמגן על המכסה:

- **מטמון ב-Worker** (`worker/middleware/edge-cache.ts`) — פגיעה במטמון עולה
  אפס שורות D1. זה המגן העיקרי. שימו לב: `s-maxage` **לבדו** לא עושה כלום,
  כי תשובה שנוצרת ב-Worker אינה נשמרת במטמון של Cloudflare מאליה;
- **מונים מתוחזקים** — `/api/tags` ירד מכ-127,000 שורות לבקשה ל-40;
- **`max-age` בדפדפן** — מעבר בין עמודים באותו ביקור לא שואל שוב;
- עוגיית hint שחוסכת קריאת session בכל טעינת עמוד;
- אין כתיבה על צפייה בכרטיס; התקדמות צפייה נשמרת בדפדפן;
- `limit` חסום ב-60, ו-rate limit על כל כתיבה;
- **מדיניות שמירה** (`RETENTION`) — הטבלאות שגדלות עם התנועה מגיעות לגודל
  יציב במקום לשיפוע.

המספרים המלאים, לפני ואחרי: [`performance.md`](performance.md).
המצב בזמן אמת: `GET /api/admin/resources`, ולוח הניהול מציג אותו.

**כשמשנים משהו בקצה:** `CACHE_VERSION` הוא משתנה סביבה שנכנס לכל מפתח מטמון.
שינוי שלו מבטל את כל המטמון מיידית — בלי purge ובלי deploy.

אם בכל זאת מתקרבים למכסה: `npm run static:build`, ואז `STATIC_CATALOG_MODE=true`.

## החזרה לאחור

```bash
npx wrangler rollback --env production
```

מחזיר את קוד ה-Worker. **שינוי סכימה לא חוזר לאחור מעצמו** — לכן כל מחיקה
במערכת היא רכה (`deleted_at`), וכל שינוי בניהול נשמר עם snapshot ב-audit log.
