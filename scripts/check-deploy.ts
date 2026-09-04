/**
 * Refuse to deploy a configuration that cannot work.
 *
 * ## Why this exists
 *
 * The first production deploy failed like this:
 *
 *     ✘ [ERROR] A request to the Cloudflare API (…/versions) failed.
 *       binding DB of type d1 must have a valid `database_id` specified
 *       [code: 10021]
 *
 * after building, uploading 70 assets and spending thirty-four seconds — and
 * the cause was a placeholder that had been sitting in `wrangler.jsonc` since
 * the repository was created, three lines under a comment saying it was a
 * placeholder. Nothing between "edit the file" and "the Cloudflare API says
 * no" ever looked at it.
 *
 * The same deploy also revealed the other half of the problem. Cloudflare's
 * Workers Builds runs whatever deploy command the dashboard is set to, and its
 * default is a bare `npx wrangler deploy` — which selects the **top-level**
 * configuration. In this project the top level is *development*: it deployed
 * `ENVIRONMENT: "development"` and `APP_URL: "http://localhost:8787"` to the
 * production service, and would have succeeded at it if the database id had
 * been filled in. A build that quietly ships localhost to production is worse
 * than one that fails.
 *
 * So this checks both: that the environment named on the command line is real
 * and complete, and that it is not the development one.
 *
 * ## Using it
 *
 *     npm run check:deploy production
 *     npm run build:production      # the check, then the build
 *
 * `npm run build` on its own does *not* run it — CI builds every commit and has
 * no production credentials to validate against, so gating the plain build
 * would break the pipeline to protect a step the pipeline never takes.
 */

import process from 'node:process';
import path from 'node:path';
import { readFileSync } from 'node:fs';

/** Anything still carrying the shape of the committed placeholders. */
const PLACEHOLDER = /REPLACE_WITH|YOUR_ACCOUNT|<[A-Z_]+>/;

interface D1Binding {
  readonly binding?: string;
  readonly database_name?: string;
  readonly database_id?: string;
}

interface WranglerEnvironment {
  readonly name?: string;
  readonly vars?: Record<string, string>;
  readonly d1_databases?: readonly D1Binding[];
}

interface WranglerConfig extends WranglerEnvironment {
  readonly env?: Record<string, WranglerEnvironment>;
}

/**
 * Parse JSONC — comments and trailing commas — without a dependency.
 *
 * Written as a character scan rather than a regular expression because a
 * regular expression cannot tell a `//` inside a string from a comment, and
 * `"APP_URL": "https://…"` is exactly that case. Getting it wrong here would
 * make this checker report nonsense about the very field it exists to check.
 */
function parseJsonc(source: string): WranglerConfig {
  let out = '';
  let inString = false;
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] ?? '';
    const next = source[index + 1] ?? '';

    if (inString) {
      out += character;
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }

    if (character === '"') {
      inString = true;
      out += character;
      continue;
    }

    if (character === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index += 1;
      out += '\n';
      continue;
    }

    if (character === '/' && next === '*') {
      index += 2;
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        index += 1;
      }
      index += 1;
      continue;
    }

    out += character;
  }

  // Trailing commas, once the strings and comments are gone.
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1')) as WranglerConfig;
}

function main(): void {
  const requested = process.argv[2];
  if (requested == null || requested.length === 0) {
    console.error('usage: tsx scripts/check-deploy.ts <environment>   e.g. production');
    process.exit(2);
  }

  const file = path.resolve(import.meta.dirname, '..', 'wrangler.jsonc');
  const config = parseJsonc(readFileSync(file, 'utf8'));
  const environment = config.env?.[requested];

  const problems: string[] = [];

  if (environment == null) {
    const available = Object.keys(config.env ?? {}).join(', ') || '(none)';
    console.error(
      `✗ wrangler.jsonc has no environment called "${requested}".\n` +
        `  Environments defined: ${available}\n\n` +
        `  A bare \`wrangler deploy\` uses the top-level configuration, which in\n` +
        `  this project is development — it would ship ENVIRONMENT=development\n` +
        `  and APP_URL=http://localhost:8787. Always pass --env.`,
    );
    process.exit(1);
  }

  // The two fields that fail the deploy outright, and the one that fails
  // silently afterwards.
  for (const database of environment.d1_databases ?? []) {
    const id = database.database_id ?? '';
    if (id.length === 0 || PLACEHOLDER.test(id)) {
      problems.push(
        `d1_databases[${database.binding ?? '?'}].database_id is "${id || '(empty)'}"\n` +
          `      Create the database and paste the id it prints:\n` +
          `          npx wrangler d1 create ${database.database_name ?? 'car-tiv'}\n` +
          `      This is the one that produces "must have a valid \`database_id\`\n` +
          `      specified [code: 10021]" — after the build and the asset upload.`,
      );
    }
  }

  const appUrl = environment.vars?.APP_URL ?? '';
  if (appUrl.length === 0 || PLACEHOLDER.test(appUrl)) {
    problems.push(
      `vars.APP_URL is "${appUrl || '(empty)'}"\n` +
        `      It must be the real origin this environment answers on, with no\n` +
        `      trailing slash — the address \`wrangler deploy\` prints, or the\n` +
        `      custom domain. It builds the OAuth redirect URI and every absolute\n` +
        `      URL in the sitemap, and unlike the database id it does NOT fail the\n` +
        `      deploy: the site loads and the sitemap points at a host that does\n` +
        `      not exist.`,
    );
  }

  if (appUrl.startsWith('http://') && !appUrl.startsWith('http://localhost')) {
    problems.push(`vars.APP_URL is plain http — "${appUrl}". Cookies are Secure-only.`);
  }

  if ((environment.vars?.ENVIRONMENT ?? '') !== requested) {
    problems.push(
      `vars.ENVIRONMENT is "${environment.vars?.ENVIRONMENT ?? '(unset)'}" in the\n` +
        `      "${requested}" environment. It decides log level, cookie flags and\n` +
        `      whether the admin is reachable, so a mismatch is not cosmetic.`,
    );
  }

  if (problems.length === 0) {
    console.log(
      `✓ ${requested}: ${environment.name ?? '(unnamed)'} — database id set, ` +
        `APP_URL ${appUrl}`,
    );
    return;
  }

  console.error(`✗ wrangler.jsonc is not ready to deploy "${requested}":\n`);
  for (const problem of problems) console.error(`  • ${problem}\n`);
  console.error('  docs/deployment.md has the full order of operations.');
  process.exit(1);
}

main();
