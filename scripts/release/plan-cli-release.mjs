#!/usr/bin/env node
/**
 * Plan a @openpacker/cli release.
 *
 * The npm version is semver without +build. npm strips build metadata, so the
 * short git SHA is recorded in the GitHub Release title instead.
 *
 * Prints KEY=value lines: version, tag, release_title, short_sha,
 * npm_dist_tag, also_github_packages.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '../..');
const semver =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;

function fail(message) {
  throw new Error(`plan-cli-release: ${message}`);
}

function utcStamp(now) {
  const year = String(now.getUTCFullYear());
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const day = String(now.getUTCDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

function normalizeSha(sha) {
  const text = sha ?? '';
  if (text === '') fail('pass --sha or set GITHUB_SHA');
  if (!/^[0-9a-fA-F]{7,}$/u.test(text)) {
    fail(`SHA must be at least 7 hex characters, got ${text}`);
  }
  return text.slice(0, 7).toLowerCase();
}

/**
 * @param {{
 *   mode: string,
 *   packageVersion: string,
 *   sha: string,
 *   stamp?: string,
 *   now?: Date,
 * }} input
 */
export function planCliRelease(input) {
  const mode = input.mode;
  if (mode !== 'alpha' && mode !== 'nightly') {
    fail('--mode must be alpha or nightly');
  }
  const packageVersion = input.packageVersion ?? '';
  const match = semver.exec(packageVersion);
  if (!match) fail(`invalid semver: ${packageVersion}`);
  if (match[5]) {
    fail(
      `npm version must not include +build metadata (${packageVersion}). Record the git SHA in the GitHub Release title`,
    );
  }
  const shortSha = normalizeSha(input.sha);
  let version = packageVersion;
  let npmDistTag = 'alpha';
  if (mode === 'alpha') {
    if (!match[4]) {
      fail(`alpha mode requires a prerelease version, got ${packageVersion}`);
    }
  } else {
    const stable = `${match[1]}.${match[2]}.${match[3]}`;
    const stamp =
      input.stamp !== undefined && input.stamp !== ''
        ? input.stamp
        : utcStamp(input.now ?? new Date());
    if (!/^[0-9]{8}$/u.test(stamp)) {
      fail(`RELEASE_STAMP must be UTC YYYYMMDD, got ${stamp}`);
    }
    version = `${stable}-nightly.${stamp}`;
    npmDistTag = 'nightly';
  }
  return {
    version,
    tag: `cli-v${version}`,
    releaseTitle: `cli ${version} (+${shortSha})`,
    shortSha,
    npmDistTag,
    alsoGithubPackages: true,
  };
}

export function formatPlan(plan) {
  return [
    `version=${plan.version}`,
    `tag=${plan.tag}`,
    `release_title=${plan.releaseTitle}`,
    `short_sha=${plan.shortSha}`,
    `npm_dist_tag=${plan.npmDistTag}`,
    `also_github_packages=${plan.alsoGithubPackages ? 'true' : 'false'}`,
  ].join('\n');
}

function parseArgs(argv) {
  let mode = '';
  let sha = '';
  let sawMode = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--mode' || arg === '--sha') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        fail(`${arg} requires a value`);
      }
      if (arg === '--mode') {
        mode = value;
        sawMode = true;
      } else sha = value;
      index += 1;
      continue;
    }
    fail(`unknown argument ${arg}`);
  }
  if (!sawMode) fail('--mode is required');
  return { mode, sha };
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  const sha = parsed.sha !== '' ? parsed.sha : (process.env.GITHUB_SHA ?? '');
  const manifest = JSON.parse(
    readFileSync(resolve(root, 'apps/openpacker-cli/package.json'), 'utf8'),
  );
  const stamp = process.env.RELEASE_STAMP;
  const plan = planCliRelease({
    mode: parsed.mode,
    packageVersion: manifest.version,
    sha,
    stamp,
  });
  process.stdout.write(`${formatPlan(plan)}\n`);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'plan failed';
    process.stderr.write(`${message}\n`);
    process.exit(1);
  }
}
