#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const releaseDir = join(root, 'apps/openpacker-cli/release');

function fail(message) {
  console.error(`npm-pack-gate: ${message}`);
  process.exit(1);
}

function run(args, cwd) {
  const result = spawnSync('npm', args, { cwd, stdio: 'inherit' });
  if (result.error) fail(result.error.message);
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function capture(args, cwd) {
  const result = spawnSync('npm', args, { cwd, encoding: 'utf8' });
  if (result.error) fail(result.error.message);
  if (result.status !== 0) {
    process.stderr.write(result.stderr ?? '');
    process.exit(result.status ?? 1);
  }
  return result.stdout ?? '';
}

run(['run', 'bundle', '--workspace', '@openpacker/cli'], root);

const manifest = JSON.parse(
  readFileSync(join(releaseDir, 'package.json'), 'utf8'),
);
const groups = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
];
for (const group of groups) {
  const deps = manifest[group];
  if (!deps) continue;
  for (const name of Object.keys(deps)) {
    if (name === '@openpacker' || name.startsWith('@openpacker/')) {
      fail(`${group} contains workspace package ${name}`);
    }
  }
}
if (
  !Array.isArray(manifest.files) ||
  manifest.files.length !== 1 ||
  manifest.files[0] !== 'dist'
) {
  fail(`files must be ["dist"], received ${JSON.stringify(manifest.files)}`);
}

const packed = capture(['pack', '--json'], releaseDir);
const start = packed.indexOf('[');
if (start < 0) fail('npm pack did not return JSON');
const info = JSON.parse(packed.slice(start));
const entry = info[0];
if (!entry || entry.name !== '@openpacker/cli') {
  fail('npm pack did not describe @openpacker/cli');
}
const paths = (entry.files ?? []).map((file) =>
  file && file.path ? file.path : file,
);
if (paths.length === 0) fail('npm pack produced no files');
for (const path of paths) {
  if (path !== 'package.json' && !path.startsWith('dist/')) {
    fail(`packed file is outside dist: ${path}`);
  }
}
if (!paths.some((path) => path.startsWith('dist/'))) {
  fail('tarball does not contain dist');
}
console.log(
  `npm-pack-gate: ${entry.filename} files=${paths.length} deps=${Object.keys(manifest.dependencies ?? {}).length}`,
);
