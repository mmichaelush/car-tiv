/**
 * Apply the generated catalog SQL to a D1 database, in order.
 *
 *     npm run catalog:import:local          # local .wrangler D1
 *     npx tsx scripts/import-catalog.ts --target=staging
 *     npx tsx scripts/import-catalog.ts --target=production --yes
 *
 * Written as a Node script rather than a shell loop so it behaves the same on
 * Windows, macOS and Linux, and so it can stop at the first failing file
 * instead of ploughing on and leaving the database half-migrated.
 *
 * It never runs migrations — do that first with `npm run db:migrate:<env>` —
 * and it refuses to touch production without an explicit `--yes`.
 */

import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline/promises';

const ROOT = path.resolve(import.meta.dirname, '..');
const CATALOG_DIR = path.join(ROOT, 'build', 'catalog');

/** Wrangler invocation per environment. */
const TARGETS = {
  local: { database: 'car-tiv-dev', args: ['--local'] },
  dev: { database: 'car-tiv-dev', args: ['--remote'] },
  staging: { database: 'car-tiv-staging', args: ['--env', 'staging', '--remote'] },
  production: { database: 'car-tiv', args: ['--env', 'production', '--remote'] },
} as const;

type TargetName = keyof typeof TARGETS;

async function main(): Promise<void> {
  const target = readTarget();
  const confirmed = process.argv.includes('--yes');

  if (target === 'production' && !confirmed) {
    const answer = await ask(
      'This will import the catalog into PRODUCTION. Type "import" to continue: ',
    );
    if (answer.trim() !== 'import') {
      console.log('Cancelled.');
      return;
    }
  }

  const files = (await readdir(CATALOG_DIR).catch(() => [] as string[]))
    .filter((name) => name.endsWith('.sql'))
    .sort();

  if (files.length === 0) {
    console.error('No SQL files in build/catalog. Run `npm run catalog:build` first.');
    process.exitCode = 1;
    return;
  }

  const { database, args } = TARGETS[target];
  console.log(`Importing ${String(files.length)} files into ${database} (${target})`);

  for (const [index, file] of files.entries()) {
    const label = `${String(index + 1).padStart(3, ' ')}/${String(files.length)} ${file}`;
    process.stdout.write(`${label} … `);

    const code = await run('npx', [
      'wrangler',
      'd1',
      'execute',
      database,
      ...args,
      '--file',
      path.join('build', 'catalog', file),
    ]);

    if (code !== 0) {
      console.error(`\nFailed on ${file} (exit ${String(code)}). Nothing after it was applied.`);
      process.exitCode = 1;
      return;
    }
    console.log('ok');
  }

  console.log('Done. Refresh the counters next — see docs/deployment.md step 5 —');
  console.log('then check the admin dashboard.');
}

function readTarget(): TargetName {
  const raw = process.argv.find((arg) => arg.startsWith('--target='))?.split('=')[1] ?? 'local';
  if (!(raw in TARGETS)) {
    throw new Error(`Unknown target "${raw}". Expected one of: ${Object.keys(TARGETS).join(', ')}`);
  }
  return raw as TargetName;
}

/** Run a command, streaming its output, and resolve with the exit code. */
function run(command: string, args: readonly string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], {
      stdio: ['ignore', 'pipe', 'inherit'],
      shell: process.platform === 'win32',
    });
    child.stdout.resume();
    child.on('close', (code) => {
      resolve(code ?? 1);
    });
  });
}

async function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

await main();
