#!/usr/bin/env node
/**
 * Sync workspace versions and internal @openpacker/* dependency pins.
 *
 * Usage:
 *   node scripts/sync-workspace-version.mjs 0.0.1-alpha.1
 *
 * Sets `version` on packages named @openpacker/* or openpacker, and sets
 * @openpacker/* dependency pins to that version. Does not add publishConfig,
 * delete private, or choose which packages are publishable.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(import.meta.url), '..', '..');
const version = process.argv[2];
if (!version) {
  console.error('Usage: node scripts/sync-workspace-version.mjs <version>');
  process.exit(1);
}

const depFields = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
];

/** @param {string} pkgPath */
function syncFile(pkgPath) {
  const json = JSON.parse(readFileSync(pkgPath, 'utf8'));
  if (typeof json.name !== 'string') return;
  const named =
    json.name.startsWith('@openpacker/') || json.name === 'openpacker';
  if (named) json.version = version;
  let pinned = false;
  for (const field of depFields) {
    const deps = json[field];
    if (!deps || typeof deps !== 'object') continue;
    for (const dep of Object.keys(deps)) {
      if (!dep.startsWith('@openpacker/') || typeof deps[dep] !== 'string')
        continue;
      if (deps[dep] !== version) pinned = true;
      deps[dep] = version;
    }
  }
  if (!named && !pinned) return;
  writeFileSync(pkgPath, `${JSON.stringify(json, null, 2)}\n`);
}

for (const workspaceRoot of ['apps', 'packages', 'examples']) {
  const absRoot = join(root, workspaceRoot);
  if (!existsSync(absRoot)) continue;
  for (const dir of readdirSync(absRoot, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const pkgPath = join(absRoot, dir.name, 'package.json');
    if (!existsSync(pkgPath)) continue;
    syncFile(pkgPath);
  }
}

syncFile(join(root, 'package.json'));
console.log(`Synced workspace versions to ${version}`);
