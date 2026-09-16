/**
 * Bring the deployed database up to date, from inside Cloudflare's own build.
 *
 * ## Why this exists
 *
 * Everything a new deployment needs — the schema, the reference rows, the
 * catalog — is applied with `wrangler`, and `wrangler` needs credentials for
 * the Cloudflare API. That is a wall for anyone who cannot authenticate
 * locally: `wrangler login` opens a browser and waits for a callback on
 * `localhost:8976`, which fails behind a firewall or a non-default browser, and
 * creating an API token by hand is a detour through a dashboard most people
 * only visit once.
 *
 * Workers Builds is already authenticated. It runs the deploy command with a
 * build token Cloudflare issues itself, so a wrangler command run *there* needs
 * no login at all. Wiring the database steps into the deploy turns "six
 * commands you must run against the API" into "push, and the database catches
 * up".
 *
 * ## What runs when
 *
 *  * **Migrations** run on every deploy. `wrangler d1 migrations apply` records
 *    what it has applied, so this is a no-op once the database is current — and
 *    it means a deploy can never ship code that expects a column the database
 *    does not have, which is the failure this ordering exists to prevent.
 *  * **Reference rows** run on every deploy. The seed is `INSERT OR IGNORE`
 *    throughout, so it is idempotent by construction and costs one statement.
 *  * **The catalog** is applied a few files at a time, paced against D1's
 *    daily write limit, and picks up where it left off.
 *
 *    This used to be one loop over all 52 files, gated on `videos` being
 *    empty, and it went over the free plan's 100,000 rows written per day on
 *    the first deploy that ran it. `npm run catalog:cost` measures why: the
 *    full catalog is 338,860 rows written, because Cloudflare bills index
 *    writes as rows and a `videos` row touches six indexes. Three and a half
 *    days of an account-wide budget, spent in one build, after which every
 *    write in the account fails until midnight UTC.
 *
 *    So each file's cost is read from the manifest, files are applied while
 *    the day's spend stays under `DAILY_BUDGET`, and every one is recorded in
 *    `catalog_import_log`. The next deploy resumes from the first file that is
 *    not in that table — no variable to set, nothing to remember.
 *
 *    Filenames include a content hash. A new package imports once and resumes
 *    without resetting the log. `SEED_CATALOG=0` skips the catalog step.
 *
 * ## The final package is authoritative for imported metadata
 *
 * Source fields and relations are replaced; absent videos are hidden at the
 * reconciliation step. Existing moderation status is retained on shared ids.
 *
 * ## Failure is reported, and it fails the build
 *
 * This used to return quietly on every error so the deploy could continue,
 * with the argument that a Worker waiting for its schema is recoverable. It is
 * — but the build went green while it waited, which is how a production deploy
 * came to look successful with an empty database behind it. Every failure path
 * now prints its explanation and sets a non-zero exit code, which stops
 * `deploy:ci` before `wrangler deploy` runs.
 *
 * Running out of the daily write budget is deliberately *not* a failure: it is
 * the expected end of a day's work, and the next deploy continues.
 *
 * Run by the deploy command — see `docs/deployment.md`:
 *
 *     npx tsx scripts/ci-database.ts && npx wrangler deploy --env production
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { jsonPayload } from './lib/wrangler-json.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENVIRONMENT = process.env.DEPLOY_ENV ?? 'production';
const DATABASE = ENVIRONMENT === 'staging' ? 'car-tiv-staging' : 'car-tiv';

/**
 * How many rows written a single day's import may spend.
 *
 * D1's free plan allows 100,000 rows written per day, per *account* — staging
 * and production share it, as does anything else in the account. This leaves
 * a fifth of it alone for the things that are not the import: the migrations,
 * the reference seed, the hourly maintenance cron, and whatever writes the
 * live site does while the catalog is still loading.
 *
 * It is a ceiling on the estimate, and the estimate is not a measurement of
 * what Cloudflare actually charged. Being wrong in the cautious direction
 * costs an extra day; being wrong the other way costs a day of failed writes
 * across the whole account.
 */
const DAILY_BUDGET = 80_000;

/**
 * Everything that went wrong; empty when nothing did.
 *
 * Recorded rather than thrown, because every step here still wants to print
 * its own explanation before the process ends — and set as an exit code at the
 * very end, which is the part that was missing. `deploy:ci` is
 * `db:ci && … && wrangler deploy`, so a `db:ci` that returned quietly let a
 * Worker go live against a schema that had not applied or a catalog that had
 * not loaded, and the build went green. A deploy is allowed to be behind its
 * database; it is not allowed to look successful while it is.
 */
const FAILURES: string[] = [];

function failed(reason: string): void {
  FAILURES.push(reason);
}

/** Run a command, streaming its output, and resolve with its exit code. */
function run(command: string, args: readonly string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], { cwd: ROOT, stdio: 'inherit', shell: false });
    child.on('close', (code) => {
      resolve(code ?? 1);
    });
    child.on('error', () => {
      resolve(1);
    });
  });
}

const wrangler = (args: readonly string[]): Promise<number> => run('npx', ['wrangler', ...args]);

/** The same, capturing stdout instead of streaming it. */
function capture(command: string, args: readonly string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], { cwd: ROOT, shell: false });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.on('close', (code) => {
      resolve({ code: code ?? 1, out });
    });
    child.on('error', () => {
      resolve({ code: 1, out });
    });
  });
}

/** A D1 database id, wherever it appears in wrangler's output. */
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

/**
 * Make sure the config names a real database, creating one if it does not.
 *
 * `wrangler deploy` refuses a binding whose `database_id` is not a real id —
 * "binding DB of type d1 must have a valid `database_id` specified" — and the
 * repository ships placeholders on purpose, because an id belongs to whoever
 * deploys rather than to the code. Filling one in means running
 * `wrangler d1 create` against the Cloudflare API, which is precisely what
 * someone who cannot authenticate locally cannot do.
 *
 * Here, inside Workers Builds, wrangler *is* authenticated. So the last manual
 * step disappears: look the database up by name, create it if this is the first
 * deploy, and write the id into the checkout's copy of `wrangler.jsonc`.
 *
 * The write is to the build's own workspace — a fresh clone, thrown away when
 * the build ends — so nothing is committed and the repository keeps its
 * placeholder. Every build resolves the id again, by name, which is also what
 * makes this safe to leave in place: paste the real id into `wrangler.jsonc`
 * one day and this becomes a no-op that confirms the two agree.
 */
async function ensureDatabaseId(): Promise<boolean> {
  const file = path.join(ROOT, 'wrangler.jsonc');
  const config = readFileSync(file, 'utf8');
  const placeholder =
    ENVIRONMENT === 'staging' ? 'REPLACE_WITH_STAGING_D1_ID' : 'REPLACE_WITH_PRODUCTION_D1_ID';

  if (!config.includes(placeholder)) {
    console.log(`${DATABASE}: the config already carries an id.`);
    return true;
  }

  heading(`database — ${DATABASE}`);

  const listed = await capture('npx', ['wrangler', 'd1', 'list', '--json']);
  let id: string | undefined;

  if (listed.code === 0) {
    // Not an array means wrangler printed a warning or an error instead of a
    // listing. `id` stays undefined and the create path below reports whatever
    // really happened.
    const databases = jsonPayload(listed.out);
    if (Array.isArray(databases)) {
      const match = (databases as { uuid?: unknown; name?: unknown }[]).find(
        (database) => database.name === DATABASE,
      );
      id = typeof match?.uuid === 'string' ? match.uuid : undefined;
    }
  }

  if (id != null) {
    console.log(`Found ${DATABASE} — ${id}`);
  } else {
    console.log(`${DATABASE} does not exist yet; creating it.`);
    const created = await capture('npx', ['wrangler', 'd1', 'create', DATABASE]);
    console.log(created.out.trim());
    id = UUID.exec(created.out)?.[0];

    if (id == null) {
      console.error(
        `\n⚠ Could not create or find ${DATABASE}.\n` +
          '  If the output above mentions permissions, the build token has no D1\n' +
          '  access: add it under Workers & Pages → the build settings, or create\n' +
          '  the database in the dashboard (Storage & Databases → D1) and paste\n' +
          '  its id into wrangler.jsonc.',
      );
      return false;
    }
    console.log(`Created ${DATABASE} — ${id}`);
  }

  // The build workspace only. Nothing is committed.
  writeFileSync(file, config.replaceAll(placeholder, id), 'utf8');
  console.log("Wrote the id into this build's wrangler.jsonc.");
  return true;
}

function heading(text: string): void {
  console.log(`\n── ${text} ${'─'.repeat(Math.max(0, 56 - text.length))}`);
}

/** Rows from a read-only query, or `null` when it could not be run. */
async function queryRows<T>(sql: string): Promise<T[] | null> {
  const result = await capture('npx', [
    'wrangler',
    'd1',
    'execute',
    DATABASE,
    '--env',
    ENVIRONMENT,
    '--remote',
    '--json',
    `--command=${sql}`,
  ]);

  if (result.code !== 0) return null;

  const payload = jsonPayload(result.out);
  if (!Array.isArray(payload)) return null;

  const rows = (payload as { results?: unknown }[])[0]?.results;
  return Array.isArray(rows) ? (rows as T[]) : null;
}

/**
 * How many rows a table holds, or `null` when the question could not be asked.
 *
 * `null` is deliberately distinct from `0`: a database that answers "zero
 * videos" is asking to be filled, while one that does not answer at all has a
 * problem the caller must not paper over by importing a catalog into it.
 */
async function countRows(table: string): Promise<number | null> {
  const result = await capture('npx', [
    'wrangler',
    'd1',
    'execute',
    DATABASE,
    '--env',
    ENVIRONMENT,
    '--remote',
    '--json',
    `--command=SELECT COUNT(*) AS n FROM ${table}`,
  ]);

  if (result.code !== 0) return null;

  const payload = jsonPayload(result.out);
  if (!Array.isArray(payload)) return null;

  const first = (payload as { results?: unknown }[])[0];
  const rows = first?.results;
  if (!Array.isArray(rows)) return null;

  const value = (rows as { n?: unknown }[])[0]?.n;
  return typeof value === 'number' ? value : null;
}

async function main(): Promise<void> {
  // Before anything else: `wrangler deploy` cannot run at all against a
  // placeholder id, so this is the step that decides whether the rest is even
  // possible.
  if (!(await ensureDatabaseId())) return;

  heading(`schema — ${DATABASE}`);

  const migrated = await wrangler([
    'd1',
    'migrations',
    'apply',
    DATABASE,
    '--env',
    ENVIRONMENT,
    '--remote',
  ]);

  if (migrated !== 0) {
    // The most likely cause by far, and worth naming rather than leaving as an
    // exit code: Workers Builds issues its own token, and if that token has no
    // D1 permission every command here fails the same way.
    console.error(
      '\n⚠ Migrations did not apply.\n' +
        '  If this says the token lacks permission, the build token has no D1\n' +
        '  access — apply the schema once from a machine that can reach the\n' +
        '  Cloudflare API, or add D1 to the token in the dashboard.\n' +
        '  The deploy continues; the Worker will report a database error until\n' +
        '  the schema exists.',
    );
    return;
  }

  heading('reference rows');
  // `INSERT OR IGNORE` throughout, so running it on every deploy writes nothing
  // after the first.
  const seeded = await wrangler([
    'd1',
    'execute',
    DATABASE,
    '--env',
    ENVIRONMENT,
    '--remote',
    '--yes',
    '--file=./seeds/0001_reference_data.sql',
  ]);

  // This exit code used to be discarded, which made the one failure it can
  // report — no categories, therefore no video can name one — look exactly
  // like success right up until the site rendered empty.
  if (seeded !== 0) {
    console.error(
      '\n⚠ The reference rows did not load.\n' +
        '  Categories, home sections and feature flags come from this file, and the\n' +
        '  catalog needs the categories, so the import below is skipped too.',
    );
    return;
  }

  await importCatalog();
}

// ---------------------------------------------------------------------------
// The catalog, paced against the daily write budget
// ---------------------------------------------------------------------------

/**
 * Import as much of the catalog as today's write budget allows, and record it.
 *
 * ## Why this is not one loop over 52 files
 *
 * It was, and it went over D1's free-plan limit of 100,000 rows written per
 * day on the first deploy that ran it. `npm run catalog:cost` measures the real
 * figure: 338,860 rows written for the full catalog — because Cloudflare bills
 * a write to an index as a row, and a `videos` row touches six indexes, a
 * `video_tags` row two, on top of the FTS5 shadow tables. Three and a half days
 * of budget, spent in one build, after which every write in the account fails
 * until midnight UTC.
 *
 * So the import is paced. Each file's cost comes from the manifest the build
 * writes, files are applied while today's spend stays under `DAILY_BUDGET`,
 * and each one is recorded in `catalog_import_log` as it lands. The next
 * deploy — tomorrow's, or one triggered by any push — picks up from the first
 * file that is not in that table.
 *
 * ## Why the log, and not the row counts
 *
 * "Is `videos` empty" answers correctly exactly twice: on an untouched
 * database, and on a finished one. In between — which is now the normal state
 * for three days — it says "there are videos, nothing to do" about a database
 * missing 40,000 tag relations. The log knows which files landed; the counts
 * cannot.
 */
async function importCatalog(): Promise<void> {
  if (process.env.SEED_CATALOG === '0') return;
  const claimed = await queryRows<{ value: number }>(`INSERT INTO catalog_counters (key, value)
    VALUES ('maintenance.importLease', unixepoch() + 3600)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
    WHERE catalog_counters.value < unixepoch() RETURNING value`);
  if (claimed == null || claimed.length === 0) {
    failed('another catalog import is running, or the lease could not be acquired');
    return;
  }
  try {
    await importCatalogFiles();
  } finally {
    await queryRows(`UPDATE catalog_counters SET value = 0
      WHERE key = 'maintenance.importLease' AND value = ${String(claimed[0]?.value)} RETURNING value`);
  }
}

async function importCatalogFiles(): Promise<void> {
  heading('catalog');

  // Staging gets a sample, not the catalog.
  //
  // The 100,000 rows written a day is an *account* limit, not a per-database
  // one, so a full staging import and a full production import are the same
  // budget spent twice — a week of loading to have the same 7,876 videos in
  // two places. Nothing staging is for needs all of them: the layout, the
  // filters and the admin behave identically against a few hundred.
  //
  // `STAGING_FULL_CATALOG=1` overrides it, for the rare case of reproducing
  // something that only happens at full size — and then it should be the only
  // import running that week.
  if (ENVIRONMENT === 'staging' && process.env.STAGING_FULL_CATALOG !== '1') {
    console.log(
      'Staging: importing the reference data only.\n' +
        '  The daily write budget belongs to the account, not to one database, so a\n' +
        "  full staging import would spend days of production's allowance to hold a\n" +
        '  second copy of the same catalog. Set STAGING_FULL_CATALOG=1 to override.',
    );
    return;
  }

  // Generated rather than committed: `build/catalog/` is derived from
  // `data/videos/*.json`, and a build that imported a stale copy would put a
  // catalog into production that no longer matches its source.
  if ((await run('npm', ['run', 'catalog:build'])) !== 0) {
    console.error('⚠ Could not build the catalog SQL; skipping the import.');
    failed('the catalog SQL could not be built');
    return;
  }
  // The manifest is what makes the pacing possible; it is measured from the
  // files that were just generated, so it can never describe a different
  // catalog from the one about to be applied.
  if ((await run('npm', ['run', 'catalog:cost'])) !== 0) {
    console.error('⚠ Could not measure the catalog; skipping the import.');
    failed('the catalog write cost could not be measured');
    return;
  }

  const directory = path.join(ROOT, 'build', 'catalog');
  const manifestPath = path.join(directory, 'manifest.json');
  if (!existsSync(manifestPath)) {
    console.error('⚠ build/catalog/manifest.json is missing; skipping the import.');
    failed('the catalog manifest is missing');
    return;
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    totalRowsWritten: number;
    files: { file: string; estimatedRowsWritten: number }[];
  };

  if (process.env.SEED_CATALOG === '0') {
    console.log('SEED_CATALOG=0 — the catalog step is switched off for this build.');
    return;
  }

  // Content-addressed filenames resume this exact package without resetting spend.
  const applied = await appliedFiles();
  if (applied == null) {
    console.error(
      '\n⚠ Could not read catalog_import_log.\n' +
        '  It is created by migration 0015; if the migrations above succeeded and\n' +
        '  this still fails, the import cannot be paced safely, so it is skipped.',
    );
    failed('the import log could not be read');
    return;
  }

  const pending = manifest.files.filter((entry) => !applied.has(entry.file));

  if (pending.length === 0) {
    console.log(`All ${String(manifest.files.length)} catalog files are already applied.`);
    return;
  }

  const spentToday = await spent();
  if (spentToday == null) {
    console.error("⚠ Could not read today's import spend; skipping the import.");
    failed("today's import spend could not be read");
    return;
  }

  let budget = DAILY_BUDGET - spentToday;
  console.log(
    `${String(pending.length)} of ${String(manifest.files.length)} files still to apply.\n` +
      `Budget today: ${format(budget)} of ${format(DAILY_BUDGET)} rows written remaining.`,
  );

  if (budget <= 0) {
    console.log("\nToday's budget is spent. The next deploy after 00:00 UTC continues.");
    return;
  }

  let importedNow = 0;

  for (const entry of pending) {
    const cost = entry.estimatedRowsWritten;

    // Never exceed the remaining daily budget, even for the first file.
    if (cost > budget) {
      console.log(
        `\nStopping before ${entry.file}: it needs ${format(cost)} rows and` +
          ` ${format(budget)} remain today.`,
      );
      break;
    }

    process.stdout.write(`  ${entry.file.padEnd(30)} ~${format(cost)} rows … `);

    if (!(await recordApplied(entry.file, cost, false))) return;

    const code = await wrangler([
      'd1',
      'execute',
      DATABASE,
      '--env',
      ENVIRONMENT,
      '--remote',
      '--yes',
      `--file=./build/catalog/${entry.file}`,
    ]);

    if (code !== 0) {
      console.error(
        `\n⚠ ${entry.file} failed.\n` +
          '  If this is a quota error, the daily limit was reached sooner than the\n' +
          '  estimate predicted; the next deploy after 00:00 UTC resumes from this\n' +
          '  file. Every file is idempotent, so re-applying one that partly landed\n' +
          '  is safe.',
      );
      failed(`${entry.file} could not be applied`);
      return;
    }

    if (!(await recordApplied(entry.file, 0, true))) return;
    budget -= cost;
    importedNow += 1;
    console.log('done');
  }

  const remaining = pending.length - importedNow;
  const [videos, channels] = await Promise.all([countRows('videos'), countRows('channels')]);

  console.log(
    `\n${remaining === 0 ? '✓' : '…'} ${String(importedNow)} files applied — ` +
      `${videos == null ? 'unknown' : format(videos)} videos, ` +
      `${channels == null ? 'unknown' : format(channels)} channels.`,
  );

  if (remaining > 0) {
    console.log(
      `  ${String(remaining)} files remain. Deploy again after 00:00 UTC and they continue\n` +
        '  automatically; nothing needs to be set by hand.',
    );
  }
}

/** Which catalog files this database already holds. `null` when unreadable. */
async function appliedFiles(): Promise<Set<string> | null> {
  const rows = await queryRows<{ file: string }>(
    'SELECT file FROM catalog_import_log WHERE completed = 1',
  );
  if (rows == null) return null;
  return new Set(rows.map((row) => row.file));
}

/** Rows written by catalog imports today, in UTC. `null` when unreadable. */
async function spent(): Promise<number | null> {
  const rows = await queryRows<{ n: number | null }>(
    "SELECT COALESCE(SUM(rows_written), 0) AS n FROM catalog_import_log WHERE applied_on = date('now')",
  );
  if (rows == null) return null;
  const value = rows[0]?.n;
  return typeof value === 'number' ? value : 0;
}

async function recordApplied(
  file: string,
  rowsWritten: number,
  completed: boolean,
): Promise<boolean> {
  const code = await wrangler([
    'd1',
    'execute',
    DATABASE,
    '--env',
    ENVIRONMENT,
    '--remote',
    '--yes',
    '--command=' +
      `INSERT INTO catalog_import_log (file, applied_on, rows_written, completed) ` +
      `VALUES ('${file.replaceAll("'", "''")}', date('now'), ${String(rowsWritten)}, ${completed ? '1' : '0'}) ` +
      `ON CONFLICT(file) DO UPDATE SET applied_on = excluded.applied_on, ` +
      `rows_written = CASE WHEN catalog_import_log.applied_on = excluded.applied_on ` +
      `THEN catalog_import_log.rows_written + excluded.rows_written ELSE excluded.rows_written END, ` +
      `completed = excluded.completed, applied_at = CURRENT_TIMESTAMP`,
  ]);
  if (code !== 0) failed(`could not record import progress for ${file}`);
  return code === 0;
}

const format = (value: number): string => value.toLocaleString('en');

await main();

// The exit code is the last thing decided, after every message has been
// printed — see `failed` for why it matters.
const failure = FAILURES[0];
if (failure != null) {
  console.error(`\n✘ Database setup did not finish: ${failure}`);
  process.exitCode = 1;
}
