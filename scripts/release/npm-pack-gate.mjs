#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { closeSync, openSync, readFileSync, readSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const releaseDir = join(root, 'apps/openpacker-cli/release');
const requiredBins = ['opm', 'opmx', 'opkg', 'opkgm'];

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

function packedBinPath(value) {
  if (typeof value !== 'string' || value === '') return '';
  const path = value.replace(/^\.\//, '').replaceAll('\\', '/');
  if (
    path.startsWith('/') ||
    path.split('/').includes('..') ||
    !path.startsWith('dist/')
  ) {
    return '';
  }
  return path;
}

function startsWithNodeShebang(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
  } catch (error) {
    fail(
      `cannot read ${path}: ${error instanceof Error ? error.message : error}`,
    );
  }
  try {
    const buf = Buffer.alloc(64);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const text = buf.subarray(0, n).toString('utf8');
    const end = text.search(/\r?\n/u);
    return (end < 0 ? text : text.slice(0, end)) === '#!/usr/bin/env node';
  } finally {
    closeSync(fd);
  }
}

function checkReleaseBins(binField, packedPaths) {
  for (const name of requiredBins) {
    const declared =
      binField && typeof binField === 'object' && !Array.isArray(binField)
        ? binField[name]
        : undefined;
    const target = packedBinPath(declared);
    if (target === '') fail(`bin is missing ${name}`);
    if (!packedPaths.has(target))
      fail(`tarball lacks ${target} for bin ${name}`);
    if (!startsWithNodeShebang(join(releaseDir, target))) {
      fail(`${target} for bin ${name} does not start with a node shebang`);
    }
  }
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
const packedPaths = new Set(
  paths.map((path) => (path.startsWith('./') ? path.slice(2) : path)),
);
checkReleaseBins(manifest.bin, packedPaths);
console.log(
  `npm-pack-gate: ${entry.filename} files=${paths.length} deps=${Object.keys(manifest.dependencies ?? {}).length}`,
);
