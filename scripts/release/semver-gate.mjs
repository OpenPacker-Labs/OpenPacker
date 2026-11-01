#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const semver =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;

function fail(message) {
  console.error(`semver-gate: ${message}`);
  process.exit(1);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function specifierIsPrerelease(specifier) {
  const text = String(specifier);
  const match = text.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/u);
  if (!match) return false;
  return match[0].includes('-');
}

const args = process.argv.slice(2);
let prod = false;
let depsPath = '';
const versions = [];
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === '--prod') {
    prod = true;
    continue;
  }
  if (arg === '--no-prerelease-deps') {
    const next = args[index + 1];
    if (!next || next.startsWith('--')) {
      fail('--no-prerelease-deps requires a package.json path');
    }
    depsPath = next;
    index += 1;
    continue;
  }
  versions.push(arg);
}

if (depsPath) {
  const manifest = readJson(resolve(depsPath));
  const groups = [
    'dependencies',
    'optionalDependencies',
    'peerDependencies',
    'devDependencies',
  ];
  for (const group of groups) {
    const deps = manifest[group];
    if (!deps) continue;
    for (const [name, specifier] of Object.entries(deps)) {
      if (specifierIsPrerelease(specifier)) {
        fail(`${group} ${name}@${String(specifier)} is a prerelease`);
      }
    }
  }
  console.log(`semver-gate: ${depsPath} has no prerelease dependencies`);
}

if (depsPath && !prod && versions.length === 0) process.exit(0);
if (versions.length > 1) fail('pass at most one version');

const version =
  versions[0] ??
  readJson(resolve(root, 'apps/openpacker-cli/package.json')).version;
const match = semver.exec(version);
if (!match) fail(`invalid semver: ${version}`);
if (prod && match[4]) {
  fail(`production publish rejects prerelease ${version}`);
}
console.log(`semver-gate: ${version} is valid${prod ? ' for production' : ''}`);
