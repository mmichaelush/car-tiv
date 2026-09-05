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

# 5. מונים — כבר לא צריך צעד ידני.
#
# מספרי הסרטונים בכל קטגוריה, תגית וערוץ הם עמודות מתוחזקות. בעבר היה
# כאן curl ידני, כי בלי ריענון כל המספרים באתר מופיעים כאפס עד ריצת
# ה-cron הראשונה. `catalog:build` מייצר היום את הריענון כקובץ ה-SQL
# האחרון של הייבוא (`0052_counters.sql`), והוא idempotent — ריצה שנייה
# לא כותבת כלום. הצעד הידני נשאר כאן כאילו הוא חובה זמן רב אחרי שכבר
# לא היה, וזה בדיוק סוג ההוראה שגורם לאדם הבא לחפש באג שלא קיים.
#
# אם בכל זאת המספרים אפס אחרי ייבוא — זה הריענון שלא רץ, ואפשר להריץ
# אותו ידנית:
#   curl -X POST https://<host>/api/admin/counters/refresh \
#     -H "authorization: Bearer <ADMIN_TOKEN>"
```

### הגדרת ההתחברות ב-Google Cloud

1. ב-Google Cloud Console → **APIs & Services → Credentials** → _Create
   credentials_ → **OAuth client ID** → _Web application_.
2. תחת **Authorized redirect URIs** מוסיפים בדיוק את הכתובות האלה — Google
   דורש התאמה מדויקת, כולל הסלאש:
   - `https://car-tiv-staging.<ACCOUNT_SUBDOMAIN>.workers.dev/api/auth/google/callback`
   - `https://car-tiv.<ACCOUNT_SUBDOMAIN>.workers.dev/api/auth/google/callback`

   `<ACCOUNT_SUBDOMAIN>` הוא תת-הדומיין של החשבון ב-Cloudflare — הוא **אינו
   אופציונלי**, וכתובת בלעדיו לעולם לא תתאים. הכתובת המדויקת היא זו
   ש-`wrangler deploy` מדפיס, והיא חייבת להיות זהה ל-`APP_URL`.
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

## פריסה מלוח הבקרה של Cloudflare (Workers Builds)

כשהפריסה רצה מ-Cloudflare ולא מהמחשב, **פקודת הפריסה חייבת לכלול `--env`**.

| הגדרה בלוח הבקרה | הערך                |
| ---------------- | ------------------- |
| Build command    | `npm run build`     |
| Deploy command   | `npm run deploy:ci` |
| Root directory   | `/`                 |

`deploy:ci` הוא שלושה צעדים בשרשרת: `db:ci` → `check:deploy production` →
`wrangler deploy --env production`.

**`db:ci` הוא מה שהופך את ההקמה לאוטומטית.** הוא רץ בתוך Workers Builds, שם
wrangler כבר מאומת עם טוקן ש-Cloudflare מנפיקה בעצמה — אז אין צורך ב-`wrangler
login` ולא בטוקן ידני. הוא:

1. **מוצא או יוצר את בסיס הנתונים** ורושם את ה-`database_id` לעותק של
   `wrangler.jsonc` של אותה בנייה בלבד. הריפו נשאר עם ה-placeholder, וכל בנייה
   פותרת את ה-id מחדש לפי השם. ברגע שתדביקו id אמיתי בקובץ, הצעד הזה הופך
   לבדיקה שהשניים מסכימים.
2. **מריץ מיגרציות** — לפני הפריסה, כדי שקוד לא יעלה לאוויר ויצפה לעמודה שאין.
3. **טוען נתוני יסוד** — `INSERT OR IGNORE`, אז אחרי הפעם הראשונה זה לא כותב
   כלום.
4. **מייבא את הקטלוג אם טבלת `videos` ריקה.** 7,876 סרטונים ב-52 קבצים הם דקות
   של בנייה ונתח מתקציב הכתיבה, אז אחרי הייבוא הראשון הצעד הזה לא עושה כלום.

   ההחלטה נשענת על שאילתת ספירה ולא על משתנה סביבה, מסיבה אחת: הפריסה הראשונה
   היא בדיוק הרגע שבו אף אחד לא יודע שהוא אמור להצטרף מראש למשהו. הסכימה
   מוחלת, נתוני היסוד נטענים, האתר עולה — ולא מציג כלום, כי הצעד היחיד שדולג
   הוא זה שמכניס אליו סרטונים. טבלת `videos` ריקה בפריסה שנושאת קטלוג של 7,876
   סרטונים היא לא מצב שמישהו רצה; לשאול את בסיס הנתונים זול יותר וישר יותר
   מלהניח שמי שפרס קרא פסקה.

   `SEED_CATALOG=1` כופה ייבוא גם לטבלה מלאה — לייבוא מחדש אחרי עריכה של
   `data/videos/*.json`, וגם כדי להשלים ייבוא שנעצר באמצע (כל קובץ idempotent,
   וטבלה חצי-מלאה כבר לא ריקה אז השער האוטומטי לא יתפוס). `SEED_CATALOG=0`
   מונע ייבוא גם מטבלה ריקה.

אם הטוקן של הבנייה יתברר כחסר הרשאת D1, `db:ci` יאמר את זה במילים ויפסיק —
ואז צריך ליצור את בסיס הנתונים בלוח הבקרה (Storage & Databases → D1) ולהדביק
את ה-id ל-`wrangler.jsonc` ידנית.

ברירת המחדל של Cloudflare היא `npx wrangler deploy` — **בלי** `--env`. הפקודה
הזאת בוחרת את הקונפיגורציה ברמה העליונה של `wrangler.jsonc`, שהיא סביבת
**הפיתוח**: `ENVIRONMENT: "development"` ו-`APP_URL: "http://localhost:8787"`.
הפריסה הראשונה מלוח הבקרה עשתה בדיוק את זה, ונכשלה רק כי ה-`database_id` של
סביבת הפיתוח עדיין היה placeholder:

```
✘ [ERROR] binding DB of type d1 must have a valid `database_id` specified [code: 10021]
```

לו השדה הזה היה מלא, הפריסה הייתה **מצליחה** ומעלה `http://localhost:8787`
ל-production. הסימפטום אז הוא אתר שנראה תקין לגמרי, עם sitemap והתחברות Google
שמצביעים על המחשב של מי שפרס.

`npm run build:production` מריץ `npm run check:deploy production` לפני הבנייה,
שנופל עם הודעה מפורשת אם `wrangler.jsonc` לא מוכן — במקום שגיאת API אטומה אחרי
34 שניות והעלאה של 70 קבצים.

## סדר הפעולות ל-production, פעם אחת

```bash
# 1. בסיס הנתונים. הפקודה מדפיסה database_id — מדביקים אותו ב-wrangler.jsonc
#    תחת env.production.d1_databases[0].database_id
npx wrangler d1 create car-tiv

# 2. ה-origin האמיתי. אחרי הפריסה הראשונה wrangler מדפיס את הכתובת המלאה
#    (car-tiv.<ACCOUNT_SUBDOMAIN>.workers.dev). מעדכנים
#    env.production.vars.APP_URL — בלי / בסוף.

# 3. בודקים שהקובץ מוכן, לפני שמנסים לפרוס
npm run check:deploy production

# 4. סודות. לא נכנסים ל-git.
npx wrangler secret put ADMIN_TOKEN    --env production
npx wrangler secret put SESSION_SECRET --env production

# 5. סכימה ונתוני יסוד
npm run db:migrate:production
npx wrangler d1 execute car-tiv --env production --remote \
  --file=./seeds/0001_reference_data.sql

# 6. קטלוג
npm run catalog:build
npx tsx scripts/import-catalog.ts --target=production

# 7. פריסה
npm run deploy:production

# 8. המונים כבר רועננו — `catalog:build` מייצר את הריענון כקובץ ה-SQL
#    האחרון של הייבוא. הפקודה הבאה נחוצה רק אם המספרים באתר אפס:
#   curl -X POST https://car-tiv.kosher-tiv.workers.dev/api/admin/counters/refresh \
#     -H "authorization: Bearer <ADMIN_TOKEN>"
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

3. **לוודא שהמספרים לא אפס.** המונים מתרעננים לבד — `catalog:build` מייצר את
   הריענון כקובץ ה-SQL האחרון של הייבוא, וייבוא דרך ממשק הניהול מרענן בסיום.
   אם בכל זאת כל המספרים אפס, הריענון לא רץ:
   `POST /api/admin/counters/refresh`.

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

**`STATIC_CATALOG_MODE` אינו מחובר** — הדגל קיים ואף קוד לא קורא אותו.
אם מתקרבים למכסה, מה שכן עובד: להעלות את ה-TTL ב-`CACHE_SECONDS`, ולעבור
לדומיין מותאם אם עוד לא (ראו הערת ה-workers.dev ב-`docs/performance.md`).

## החזרה לאחור

```bash
npx wrangler rollback --env production
```

מחזיר את קוד ה-Worker. **שינוי סכימה לא חוזר לאחור מעצמו** — לכן כל מחיקה
במערכת היא רכה (`deleted_at`), וכל שינוי בניהול נשמר עם snapshot ב-audit log.
