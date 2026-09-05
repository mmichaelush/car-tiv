# =============================================================================
# CAR-טיב — הקמת production, מההתחלה ועד אתר חי.
#
#     cd C:\Users\cohen\Documents\DEV\car-tiv
#     .\scripts\setup-production.ps1 -Token "<CLOUDFLARE_API_TOKEN>"
#
# מאיפה הטוקן:
#   https://dash.cloudflare.com/profile/api-tokens
#   → Create Token → תבנית "Edit Cloudflare Workers" → Continue → Create
#
# למה טוקן ולא התחברות רגילה: `wrangler login` פותח דפדפן ומחכה ל-callback
# ל-localhost:8976. אצלך זה נכשל ב-"Timed out waiting for authorization code",
# וזו תקלה נפוצה (חומת אש, דפדפן ברירת מחדל, פורט תפוס). טוקן עוקף את כל זה.
#
# הסקריפט עוצר בכל שגיאה ולא ממשיך לצעד הבא. אפשר להריץ אותו שוב אחרי תיקון —
# כל צעד בו בטוח לחזרה: יצירת בסיס הנתונים מדלגת אם הוא כבר קיים, המיגרציות
# מדלגות על מה שכבר רץ, וקובצי הקטלוג כתובים כ-idempotent.
# =============================================================================

param(
  [Parameter(Mandatory = $true)]
  [string]$Token,

  # לדלג על ייבוא הקטלוג (7,876 סרטונים, 52 קבצים — לוקח כמה דקות).
  [switch]$SkipCatalog
)

$ErrorActionPreference = 'Stop'
$env:CLOUDFLARE_API_TOKEN = $Token

function Step($number, $text) {
  Write-Host ""
  Write-Host "── $number. $text " -ForegroundColor Cyan -NoNewline
  Write-Host ("─" * [Math]::Max(0, 60 - $text.Length)) -ForegroundColor DarkGray
}

function Fail($text) {
  Write-Host ""
  Write-Host "✗ $text" -ForegroundColor Red
  exit 1
}

# -----------------------------------------------------------------------------
Step 0 "בדיקת סביבה"

if (-not (Test-Path 'wrangler.jsonc')) {
  Fail "צריך להריץ מתוך תיקיית הפרויקט (C:\Users\cohen\Documents\DEV\car-tiv)"
}

if (-not (Test-Path 'node_modules\tsx')) {
  Write-Host "  node_modules חסר או לא מעודכן — מריץ npm install" -ForegroundColor Yellow
  npm install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { Fail "npm install נכשל" }
}
Write-Host "  ✓ תלויות מותקנות"

# -----------------------------------------------------------------------------
Step 1 "בסיס הנתונים ב-D1"

# `d1 create` נכשל אם השם כבר תפוס, אז בודקים קודם ברשימה. `d1 list --json`
# מחזיר את כל בסיסי הנתונים בחשבון עם ה-uuid שלהם.
$listed = (npx wrangler d1 list --json 2>$null | Out-String).Trim()
if ($LASTEXITCODE -ne 0) {
  Fail "wrangler לא הצליח לדבר עם Cloudflare. הטוקן שגוי, פג, או שאין לו הרשאת D1."
}
# חשבון בלי בסיסי נתונים מדפיס כלום, ו-ConvertFrom-Json על מחרוזת ריקה זורק
# כשה-ErrorActionPreference הוא Stop.
$existing = $null
if ($listed) {
  $existing = @($listed | ConvertFrom-Json) | Where-Object { $_.name -eq 'car-tiv' } | Select-Object -First 1
}

if ($existing) {
  $databaseId = $existing.uuid
  Write-Host "  ✓ car-tiv כבר קיים — $databaseId"
} else {
  Write-Host "  יוצר car-tiv…"
  $created = npx wrangler d1 create car-tiv 2>&1 | Out-String
  Write-Host $created -ForegroundColor DarkGray
  # wrangler מדפיס את ה-id בתוך בלוק ה-TOML/JSON שהוא מציע להעתיק.
  $match = [regex]::Match($created, '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})')
  if (-not $match.Success) { Fail "לא הצלחתי לקרוא את ה-database_id מהפלט של wrangler" }
  $databaseId = $match.Groups[1].Value
  Write-Host "  ✓ נוצר — $databaseId"
}

# -----------------------------------------------------------------------------
Step 2 "כתיבת ה-database_id ל-wrangler.jsonc"

$config = Get-Content 'wrangler.jsonc' -Raw -Encoding UTF8
if ($config -match 'REPLACE_WITH_PRODUCTION_D1_ID') {
  # מחליפים רק את ה-placeholder של production. הקובץ נשמר בלי BOM כי
  # wrangler קורא אותו כ-JSONC ו-BOM שובר את הפענוח.
  $config = $config -replace 'REPLACE_WITH_PRODUCTION_D1_ID', $databaseId
  $target = (Resolve-Path 'wrangler.jsonc').Path
  [System.IO.File]::WriteAllText($target, $config, (New-Object System.Text.UTF8Encoding($false)))
  Write-Host "  ✓ עודכן"
} else {
  Write-Host "  ✓ כבר מעודכן"
}

npm run check:deploy production
if ($LASTEXITCODE -ne 0) { Fail "wrangler.jsonc עדיין לא מוכן — ראו את ההודעה למעלה" }

# -----------------------------------------------------------------------------
Step 3 "סודות"

# ADMIN_TOKEN הוא מה שפותח את /admin. SESSION_SECRET חותם את העוגיות.
# שניהם נוצרים כאן ולא נכנסים לגיט אף פעם — wrangler שומר אותם אצל Cloudflare.
$secrets = (npx wrangler secret list --env production 2>$null | Out-String)

foreach ($name in @('ADMIN_TOKEN', 'SESSION_SECRET')) {
  if ($secrets -match $name) {
    Write-Host "  ✓ $name כבר קיים"
    continue
  }
  # 32 בייטים אקראיים מ-RNG קריפטוגרפי, לא מ-Get-Random.
  $bytes = New-Object byte[] 32
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $value = [Convert]::ToBase64String($bytes)

  $value | npx wrangler secret put $name --env production
  if ($LASTEXITCODE -ne 0) { Fail "כתיבת הסוד $name נכשלה" }

  Write-Host "  ✓ $name נוצר" -ForegroundColor Green
  if ($name -eq 'ADMIN_TOKEN') {
    Write-Host ""
    Write-Host "  ┌─────────────────────────────────────────────────────────────┐" -ForegroundColor Yellow
    Write-Host "  │ זה המפתח לאזור הניהול. שמרו אותו — הוא לא יוצג שוב.        │" -ForegroundColor Yellow
    Write-Host "  └─────────────────────────────────────────────────────────────┘" -ForegroundColor Yellow
    Write-Host "  $value" -ForegroundColor White
    Write-Host ""
  }
}

# -----------------------------------------------------------------------------
Step 4 "סכימה ונתוני יסוד"

npm run db:migrate:production
if ($LASTEXITCODE -ne 0) { Fail "המיגרציות נכשלו" }
Write-Host "  ✓ מיגרציות הוחלו"

npx wrangler d1 execute car-tiv --env production --remote --yes --file=./seeds/0001_reference_data.sql
if ($LASTEXITCODE -ne 0) { Fail "טעינת נתוני היסוד נכשלה" }
Write-Host "  ✓ קטגוריות, ערכות ודגלי פיצ'רים נטענו"

# -----------------------------------------------------------------------------
if ($SkipCatalog) {
  Step 5 "קטלוג — דילוג (-SkipCatalog)"
} else {
  Step 5 "קטלוג — 7,876 סרטונים"

  npm run catalog:build
  if ($LASTEXITCODE -ne 0) { Fail "בניית הקטלוג נכשלה" }

  # `--yes` מדלג על אישור ידני; הסקריפט עוצר בשגיאה הראשונה במקום להשאיר
  # בסיס נתונים חצי-מיובא.
  npx tsx scripts/import-catalog.ts --target=production --yes
  if ($LASTEXITCODE -ne 0) { Fail "ייבוא הקטלוג נכשל" }
  Write-Host "  ✓ הקטלוג יובא (כולל ריענון המונים — הקובץ האחרון בייבוא)"
}

# -----------------------------------------------------------------------------
Step 6 "פריסה"

# הפריסה עצמה רצה אצל Cloudflare: Workers Builds מחובר ל-GitHub ובונה בכל
# דחיפה ל-main. מה שנשאר כאן הוא לדחוף את ה-database_id שנכתב בצעד 2.
$changed = git status --porcelain wrangler.jsonc
if ($changed) {
  git add wrangler.jsonc
  git commit -m "chore: the production D1 id"
  git push origin main
  if ($LASTEXITCODE -ne 0) { Fail "git push נכשל" }
  Write-Host "  ✓ נדחף — Cloudflare בונה ופורס עכשיו"
} else {
  Write-Host "  אין שינוי לדחוף. אם צריך לפרוס עכשיו בלי שינוי בקוד:"
  Write-Host "    npm run deploy:production"
}

# -----------------------------------------------------------------------------
Write-Host ""
Write-Host "───────────────────────────────────────────────────────────────" -ForegroundColor DarkGray
Write-Host "הכל מוכן." -ForegroundColor Green
Write-Host ""
Write-Host "  האתר      https://car-tiv.kosher-tiv.workers.dev"
Write-Host "  ניהול     https://car-tiv.kosher-tiv.workers.dev/admin/"
Write-Host ""
Write-Host "בדיקה שהמטמון באמת עובד — שתי הפקודות האלה, השנייה צריכה לומר HIT:"
Write-Host '  curl.exe -sD - -o NUL https://car-tiv.kosher-tiv.workers.dev/api/tags | Select-String x-cache'
Write-Host '  curl.exe -sD - -o NUL https://car-tiv.kosher-tiv.workers.dev/api/tags | Select-String x-cache'
Write-Host ""
Write-Host "אם השנייה אומרת MISS — המטמון לא פועל בכתובת workers.dev, וכל מבקר"
Write-Host "מגיע ל-D1. הפתרון הוא דומיין משלכם. ההסבר המלא ב-docs/performance.md."
Write-Host ""
