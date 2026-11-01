import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { resolve } from 'node:path';
import {
  formatPlan,
  planCliRelease,
} from '../../scripts/release/plan-cli-release.mjs';

const root = resolve(import.meta.dirname, '../..');
const script = resolve(root, 'scripts/release/plan-cli-release.mjs');

function parsePlan(stdout) {
  assert.equal(stdout.endsWith('\n'), true);
  const entries = new Map();
  for (const line of stdout.trimEnd().split('\n')) {
    const index = line.indexOf('=');
    assert.ok(index > 0, line);
    const key = line.slice(0, index);
    const value = line.slice(index + 1);
    assert.equal(entries.has(key), false, key);
    entries.set(key, value);
  }
  return entries;
}

function runCli(args, env) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

test('alpha mode keeps the package prerelease and records the short SHA in the title', () => {
  const plan = planCliRelease({
    mode: 'alpha',
    packageVersion: '0.0.1-alpha.1',
    sha: 'ABCDEF1234567890',
  });
  assert.equal(plan.version, '0.0.1-alpha.1');
  assert.equal(plan.tag, 'cli-v0.0.1-alpha.1');
  assert.equal(plan.releaseTitle, 'cli 0.0.1-alpha.1 (+abcdef1)');
  assert.equal(plan.shortSha, 'abcdef1');
  assert.equal(plan.npmDistTag, 'alpha');
  assert.equal(plan.alsoGithubPackages, true);
  assert.doesNotMatch(plan.version, /\+/u);
  assert.equal(
    formatPlan(plan),
    [
      'version=0.0.1-alpha.1',
      'tag=cli-v0.0.1-alpha.1',
      'release_title=cli 0.0.1-alpha.1 (+abcdef1)',
      'short_sha=abcdef1',
      'npm_dist_tag=alpha',
      'also_github_packages=true',
    ].join('\n'),
  );
});

test('alpha mode rejects a stable version and +build metadata', () => {
  assert.throws(
    () =>
      planCliRelease({
        mode: 'alpha',
        packageVersion: '0.1.0',
        sha: 'abcdef1',
      }),
    /alpha mode requires a prerelease version/u,
  );
  assert.throws(
    () =>
      planCliRelease({
        mode: 'alpha',
        packageVersion: '0.0.1-alpha.1+abcdef1',
        sha: 'abcdef1',
      }),
    /must not include \+build metadata/u,
  );
  assert.throws(
    () =>
      planCliRelease({
        mode: 'nightly',
        packageVersion: '0.0.1-alpha.1+abcdef1',
        sha: 'abcdef1',
        stamp: '20261101',
      }),
    /must not include \+build metadata/u,
  );
});

test('nightly mode stamps the stable triplet and ignores the prerelease', () => {
  const plan = planCliRelease({
    mode: 'nightly',
    packageVersion: '0.0.1-alpha.1',
    sha: '0123456789abcdef',
    stamp: '20261031',
  });
  assert.equal(plan.version, '0.0.1-nightly.20261031');
  assert.equal(plan.tag, 'cli-v0.0.1-nightly.20261031');
  assert.equal(plan.releaseTitle, 'cli 0.0.1-nightly.20261031 (+0123456)');
  assert.equal(plan.npmDistTag, 'nightly');
  assert.equal(plan.alsoGithubPackages, true);
  assert.doesNotMatch(plan.version, /\+/u);
});

test('nightly mode uses UTC when RELEASE_STAMP is absent', () => {
  const plan = planCliRelease({
    mode: 'nightly',
    packageVersion: '1.2.3',
    sha: 'deadbeef',
    now: new Date('2026-01-02T00:30:00Z'),
  });
  assert.equal(plan.version, '1.2.3-nightly.20260102');
  assert.equal(plan.shortSha, 'deadbee');
});

test('nightly mode rejects a stamp that is not YYYYMMDD', () => {
  assert.throws(
    () =>
      planCliRelease({
        mode: 'nightly',
        packageVersion: '0.0.1-alpha.1',
        sha: 'abcdef1',
        stamp: '2026-11-01',
      }),
    /RELEASE_STAMP must be UTC YYYYMMDD/u,
  );
});

test('planning rejects an unknown mode, a short SHA, and invalid semver', () => {
  assert.throws(
    () =>
      planCliRelease({
        mode: 'latest',
        packageVersion: '0.0.1-alpha.1',
        sha: 'abcdef1',
      }),
    /--mode must be alpha or nightly/u,
  );
  assert.throws(
    () =>
      planCliRelease({
        mode: 'alpha',
        packageVersion: '0.0.1-alpha.1',
        sha: 'abc',
      }),
    /at least 7 hex characters/u,
  );
  assert.throws(
    () =>
      planCliRelease({
        mode: 'alpha',
        packageVersion: '0.0.1-alpha.1',
        sha: '',
      }),
    /pass --sha or set GITHUB_SHA/u,
  );
  assert.throws(
    () =>
      planCliRelease({
        mode: 'nightly',
        packageVersion: 'not-semver',
        sha: 'abcdef1',
        stamp: '20261101',
      }),
    /invalid semver/u,
  );
});

test('CLI prints the alpha plan for the workspace package', () => {
  const manifest = JSON.parse(
    readFileSync(resolve(root, 'apps/openpacker-cli/package.json'), 'utf8'),
  );
  const result = runCli(['--mode', 'alpha', '--sha', 'abcdef1234567890'], {
    GITHUB_SHA: '',
    RELEASE_STAMP: '',
  });
  assert.equal(result.status, 0, result.stderr);
  const entries = parsePlan(result.stdout);
  assert.equal(entries.get('version'), manifest.version);
  assert.match(manifest.version, /-/u);
  assert.equal(entries.get('tag'), `cli-v${manifest.version}`);
  assert.equal(
    entries.get('release_title'),
    `cli ${manifest.version} (+abcdef1)`,
  );
  assert.equal(entries.get('short_sha'), 'abcdef1');
  assert.equal(entries.get('npm_dist_tag'), 'alpha');
  assert.equal(entries.get('also_github_packages'), 'true');
  assert.deepEqual(
    [...entries.keys()],
    [
      'version',
      'tag',
      'release_title',
      'short_sha',
      'npm_dist_tag',
      'also_github_packages',
    ],
  );
});

test('CLI nightly mode reads RELEASE_STAMP and GITHUB_SHA', () => {
  const manifest = JSON.parse(
    readFileSync(resolve(root, 'apps/openpacker-cli/package.json'), 'utf8'),
  );
  const stable = manifest.version.split('-')[0].split('+')[0];
  const result = runCli(['--mode', 'nightly'], {
    GITHUB_SHA: '0123456789abcdef',
    RELEASE_STAMP: '20261101',
  });
  assert.equal(result.status, 0, result.stderr);
  const entries = parsePlan(result.stdout);
  assert.equal(entries.get('version'), `${stable}-nightly.20261101`);
  assert.equal(entries.get('tag'), `cli-v${stable}-nightly.20261101`);
  assert.equal(entries.get('short_sha'), '0123456');
  assert.equal(entries.get('npm_dist_tag'), 'nightly');
  assert.equal(
    entries.get('release_title'),
    `cli ${stable}-nightly.20261101 (+0123456)`,
  );
});

test('CLI exits 1 for a missing mode, a missing SHA, and an unknown argument', () => {
  for (const args of [
    [],
    ['--mode', 'alpha'],
    ['--mode', 'alpha', '--sha'],
    ['--mode', 'alpha', '--sha', 'abcdef1', '--latest'],
  ]) {
    const result = runCli(args, { GITHUB_SHA: '', RELEASE_STAMP: '' });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^plan-cli-release: /u);
  }
});
