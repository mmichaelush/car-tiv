# CAR־טיב

מאגר סרטוני הרכב הכשר בעברית — סקירות, טיפולים, תיקונים, איתור תקלות, בטיחות, שטח ושדרוגים.

הפרויקט נכתב מחדש מהיסוד: **Vite + TypeScript** בצד הלקוח, **Cloudflare Workers + D1** בצד השרת,
בלי framework בצד הלקוח ובלי תלות שאי אפשר להחליף.

---

## התחלה מהירה

```bash
npm install

# 1. יצירת בסיסי הנתונים ב-Cloudflare (פעם אחת) והדבקת ה-IDs ל-wrangler.jsonc
npx wrangler d1 create car-tiv-dev

# 2. הרצת המיגרציות והזרעים מקומית
npm run db:migrate:local
npm run db:seed:local

# 3. בניית קובצי הייבוא מה-JSON הישן וטעינתם
npm run catalog:build
npm run catalog:import:local

# 4. פיתוח
npm run dev          # Vite, על http://localhost:5173
npm run dev:worker   # ה-API, על http://localhost:8787
```

`npm run dev` מפנה כל בקשה ל-`/api` אל ה-Worker, כך שהדפדפן תמיד מדבר עם אותו origin.

## פקודות

| פקודה                          | מה היא עושה                                        |
| ------------------------------ | -------------------------------------------------- |
| `npm run dev`                  | שרת פיתוח לצד הלקוח                                |
| `npm run dev:worker`           | ה-Worker וה-API מקומית                             |
| `npm run build`                | בניית האתר ל-`dist/` (כולל בניית העמודים המשפטיים) |
| `npm run verify`               | פורמט + lint + טיפוסים + בדיקות — מה שרץ ב-CI      |
| `npm test`                     | בדיקות בלבד                                        |
| `npm run typecheck`            | בדיקת טיפוסים בחמשת הפרויקטים                      |
| `npm run check:contrast`       | כל 20 ערכות הנושא ביום ובלילה מול תקן WCAG         |
| `npm run catalog:build`        | יצירת קובצי SQL ודוח ייבוא מ-`data/videos`         |
| `npm run catalog:import:local` | החלת קובצי הייבוא על D1 המקומי                     |
| `npm run static:build`         | יצירת תמונת מצב סטטית של הקטלוג (מצב חירום)        |
| `npm run legal:build`          | בנייה מחדש של `/privacy/` ו-`/terms/` מהמקור       |
| `npm run deploy:staging`       | פריסה ל-staging                                    |

## מבנה

```
shared/          לוגיקה וטיפוסים משותפים לדפדפן, ל-Worker ולסקריפטים
  core/          פונקציות טהורות: נרמול עברית, תאריכים, משך, YouTube, דירוג
  types/         חוזי ה-API — VideoSummary, ApiEnvelope, UserPreferences…

worker/          Cloudflare Worker: ה-API ושרת הנכסים
  routes/        טבלת הנתיבים — כל endpoint במקום אחד
  repositories/  המקום היחיד בפרויקט שיש בו SQL
  services/      לוגיקה עסקית שמורכבת מכמה repositories
  middleware/    שגיאות, כותרות אבטחה, הרשאות
  schemas/       ולידציה (zod) עם הודעות בעברית לכל שדה

src/             הדפדפן
  app/           נקודת כניסה לכל עמוד
  data/          repositories — הדרך היחידה לרשת ולאחסון מקומי
  features/      פיצ'רים: קטלוג, ספרייה אישית, העדפות, דיווחים, ניהול
  ui/            רכיבים, פריסה, עזרי DOM, אייקונים
  styles/        tokens → themes → base → components

migrations/      שינויי סכימה. אין שינוי schema בלי migration חדש.
seeds/           נתוני ייחוס: קטגוריות, roles, מקטעי דף הבית, מילים נרדפות
scripts/         כלי ייבוא ובנייה
tests/           בדיקות — כולל בדיקות אינטגרציה מול SQLite אמיתי
data/            מקור ה-migration: ה-JSON הישן והנתונים המשפטיים המקוריים
```

עמודי ה-HTML יושבים בשורש לפי מבנה הכתובות (`channels/index.html` → `/channels/`).

## ארכיטקטורה בשורה אחת

```
Browser → src/data (repository) → /api → worker/routes → worker/repositories → D1
```

הדפדפן לא יודע שקיים D1. אין fetch ברכיב UI, אין SQL מחוץ ל-`worker/repositories`,
ואין קריאה ישירה ל-localStorage מחוץ ל-`src/data`.
פירוט מלא: [`docs/architecture.md`](docs/architecture.md).

## תיעוד

- [`docs/architecture.md`](docs/architecture.md) — השכבות, הכללים והסיבות
- [`docs/api.md`](docs/api.md) — כל ה-endpoints
- [`docs/database.md`](docs/database.md) — הסכימה וההחלטות שמאחוריה
- [`docs/performance.md`](docs/performance.md) — תקציב המשאבים, מה נמדד ומה זה עלה
- [`docs/design-system.md`](docs/design-system.md) — tokens, ערכות נושא, רכיבים
- [`docs/deployment.md`](docs/deployment.md) — staging, production ותהליך המעבר מ-Netlify
- [`docs/migration.md`](docs/migration.md) — ייבוא הקטלוג ומה נשמר מהאתר הישן
- [`docs/regression-contract.md`](docs/regression-contract.md) — כל יכולת שהייתה באתר, ואיפה היא נמצאת היום
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — כללי הכתיבה בקוד
- [`AGENTS.md`](AGENTS.md) — מדריך לסוכני AI שעובדים על הפרויקט

## מצב הנתונים

`data/videos/*.json` הם **מקור ה-migration בלבד** — לא מסד הנתונים הפעיל.
הם נשמרים כגיבוי, כ-fixtures לבדיקות וכמקור לתמונת המצב הסטטית.
אין למחוק אותם עד שהייבוא אומת ב-production.
