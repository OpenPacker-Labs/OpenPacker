#!/usr/bin/env node
/**
 * Sync @openpacker/* workspace package versions and internal dependency pins.
 *
 * Usage:
 *   node scripts/sync-workspace-version.mjs 0.0.1-alpha.0
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(import.meta.url), '..', '..');
const version = process.argv[2];
if (!version) {
  console.error('Usage: node scripts/sync-workspace-version.mjs <version>');
  process.exit(1);
}

const repoBase = {
  type: 'git',
  url: 'git+https://github.com/Tyler-R-Kendrick/OpenPacker.git',
};

/** @type {Map<string, { path: string, json: Record<string, unknown> }>} */
const byName = new Map();

for (const workspaceRoot of ['apps', 'packages', 'examples']) {
  const absRoot = join(root, workspaceRoot);
  if (!existsSync(absRoot)) continue;
  for (const dir of readdirSync(absRoot, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const pkgPath = join(absRoot, dir.name, 'package.json');
    if (!existsSync(pkgPath)) continue;
    const json = JSON.parse(readFileSync(pkgPath, 'utf8'));
    if (typeof json.name !== 'string') continue;
    byName.set(json.name, { path: pkgPath, json });
  }
}

const publishable = new Set([
  // User-facing + CI pack list
  'openpacker',
  '@openpacker/cli',
  '@openpacker/contracts',
  '@openpacker/sdk',
  '@openpacker/embedded',
]);

/** Transitive runtime deps required to install @openpacker/cli from npm. */
function cliClosure() {
  const seen = new Set();
  /** @param {string} name */
  function walk(name) {
    if (seen.has(name)) return;
    seen.add(name);
    const entry = byName.get(name);
    if (!entry) return;
    const deps = {
      .../** @type {Record<string, string>} */ (entry.json.dependencies),
      .../** @type {Record<string, string>} */ (
        entry.json.optionalDependencies ?? {}
      ),
    };
    for (const dep of Object.keys(deps)) {
      if (dep.startsWith('@openpacker/')) walk(dep);
    }
  }
  walk('@openpacker/cli');
  return seen;
}

for (const name of cliClosure()) publishable.add(name);

const depFields = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
];

for (const [name, entry] of byName) {
  const { json, path: pkgPath } = entry;
  if (name.startsWith('@openpacker/') || name === 'openpacker') {
    json.version = version;
  }
  for (const field of depFields) {
    const deps = /** @type {Record<string, string> | undefined} */ (
      json[field]
    );
    if (!deps) continue;
    for (const [dep, pin] of Object.entries(deps)) {
      if (dep.startsWith('@openpacker/') && pin === json.version) continue;
      if (dep.startsWith('@openpacker/')) deps[dep] = version;
    }
  }
}

for (const name of publishable) {
  const entry = byName.get(name);
  if (!entry) continue;
  const { json, path: pkgPath } = entry;
  delete json.private;
  json.publishConfig = { access: 'public', tag: 'alpha' };
  const directory = relative(root, join(pkgPath, '..')).replaceAll('\\', '/');
  json.repository = { ...repoBase, directory };
  writeFileSync(pkgPath, `${JSON.stringify(json, null, 2)}\n`);
  console.log('publishable', name, '→', directory);
}

// Bump remaining @openpacker workspaces (private apps/libs) without publish metadata.
for (const [name, entry] of byName) {
  if (publishable.has(name)) continue;
  if (!name.startsWith('@openpacker/')) continue;
  const { json, path: pkgPath } = entry;
  writeFileSync(pkgPath, `${JSON.stringify(json, null, 2)}\n`);
}

// Root private monorepo marker version (not published).
const rootPkgPath = join(root, 'package.json');
const rootPkg = JSON.parse(readFileSync(rootPkgPath, 'utf8'));
rootPkg.version = version;
writeFileSync(rootPkgPath, `${JSON.stringify(rootPkg, null, 2)}\n`);

console.log(`Synced ${byName.size} workspace packages to ${version}`);
