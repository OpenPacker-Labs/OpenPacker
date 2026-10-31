#!/usr/bin/env node
/**
 * Print npm publish commands for the alpha release (dependency order).
 * Does not publish — requires NPM_TOKEN and an explicit maintainer run.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(import.meta.url), '..', '..');

/** @type {Map<string, { dir: string, deps: Set<string> }>} */
const graph = new Map();

for (const workspaceRoot of ['apps', 'packages']) {
  const absRoot = join(root, workspaceRoot);
  if (!existsSync(absRoot)) continue;
  for (const dir of readdirSync(absRoot, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const pkgPath = join(absRoot, dir.name, 'package.json');
    if (!existsSync(pkgPath)) continue;
    const json = JSON.parse(readFileSync(pkgPath, 'utf8'));
    if (!json.publishConfig?.tag) continue;
    const name = json.name;
    const deps = new Set();
    for (const field of [
      'dependencies',
      'optionalDependencies',
      'peerDependencies',
    ]) {
      const block = json[field];
      if (!block) continue;
      for (const dep of Object.keys(block)) {
        if (dep.startsWith('@openpacker/') || dep === 'openpacker')
          deps.add(dep);
      }
    }
    graph.set(name, { dir: join(workspaceRoot, dir.name), deps });
  }
}

/** @type {string[]} */
const order = [];
/** @type {Set<string>} */
const done = new Set();

while (order.length < graph.size) {
  let progress = false;
  for (const [name, { deps }] of graph) {
    if (done.has(name)) continue;
    const pending = [...deps].filter((d) => graph.has(d) && !done.has(d));
    if (pending.length === 0) {
      order.push(name);
      done.add(name);
      progress = true;
    }
  }
  if (!progress) {
    console.error('Cycle or missing node in publish graph');
    process.exit(1);
  }
}

console.log('# From repo root after: npm ci && npm run build');
console.log('# Never use dist-tag latest for this prerelease.');
console.log('');
for (const name of order) {
  const ws = name.startsWith('@') ? `-w ${name}` : `-w ${name}`;
  console.log(`npm publish ${ws} --tag alpha --access public --provenance`);
}
