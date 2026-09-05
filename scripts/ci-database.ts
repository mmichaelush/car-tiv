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
 *  * **The catalog** runs only when `SEED_CATALOG=1`. It is 7,876 videos across
 *    52 files and takes minutes; doing that on every push would spend the build
 *    minutes and the D1 write budget to re-import rows that have not changed.
 *    Set the variable in the dashboard for the one build that needs it, then
 *    remove it.
 *
 * ## Failure is not fatal to the deploy
 *
 * If the build token turns out not to carry D1 permissions, this reports that
 * clearly and lets the deploy proceed. A Worker that is deployed and waiting
 * for its schema is a recoverable state; a deploy blocked by a permission
 * problem in a step that is meant to be a convenience is not an improvement on
 * doing it by hand.
 *
 * Run by the deploy command — see `docs/deployment.md`:
 *
 *     npx tsx scripts/ci-database.ts && npx wrangler deploy --env production
 */

import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENVIRONMENT = process.env.DEPLOY_ENV ?? 'production';
const DATABASE = ENVIRONMENT === 'staging' ? 'car-tiv-staging' : 'car-tiv';

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

function heading(text: string): void {
  console.log(`\n── ${text} ${'─'.repeat(Math.max(0, 56 - text.length))}`);
}

async function main(): Promise<void> {
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
  await wrangler([
    'd1',
    'execute',
    DATABASE,
    '--env',
    ENVIRONMENT,
    '--remote',
    '--yes',
    '--file=./seeds/0001_reference_data.sql',
  ]);

  if (process.env.SEED_CATALOG !== '1') {
    console.log('\nSkipping the catalog. Set SEED_CATALOG=1 on one build to import it.');
    return;
  }

  heading('catalog');

  // Generated rather than committed: `build/catalog/` is derived from
  // `data/videos/*.json`, and a build that imported a stale copy would put a
  // catalog into production that no longer matches its source.
  const built = await run('npm', ['run', 'catalog:build']);
  if (built !== 0) {
    console.error('⚠ Could not build the catalog SQL; skipping the import.');
    return;
  }

  const directory = path.join(ROOT, 'build', 'catalog');
  if (!existsSync(directory)) {
    console.error('⚠ build/catalog is missing after the build; skipping the import.');
    return;
  }

  const files = readdirSync(directory)
    .filter((name) => name.endsWith('.sql'))
    .sort();

  console.log(`${String(files.length)} files to import.`);

  for (const [index, file] of files.entries()) {
    console.log(`  ${String(index + 1)}/${String(files.length)}  ${file}`);
    const code = await wrangler([
      'd1',
      'execute',
      DATABASE,
      '--env',
      ENVIRONMENT,
      '--remote',
      '--yes',
      `--file=./build/catalog/${file}`,
    ]);

    // Stop at the first failure rather than ploughing on: a half-imported
    // catalog is harder to reason about than an obviously incomplete one, and
    // every file here is idempotent, so a re-run resumes safely.
    if (code !== 0) {
      console.error(`\n⚠ ${file} failed. Re-run the build with SEED_CATALOG=1 to resume.`);
      return;
    }
  }

  console.log('\n✓ Catalog imported, counters refreshed (the last file does that).');
}

await main();
