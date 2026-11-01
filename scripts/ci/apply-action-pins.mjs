#!/usr/bin/env node
/**
 * Replace version-tag action refs with full commit SHAs from .github/action-pins.json.
 * Usage: node scripts/ci/apply-action-pins.mjs [--check]
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = join(import.meta.dirname, '../..');
const pins = JSON.parse(
  readFileSync(join(root, '.github/action-pins.json'), 'utf8'),
);
const check = process.argv.includes('--check');

function files(directory) {
  const absolute = join(root, directory);
  const paths = [];
  for (const entry of readdirSync(absolute)) {
    const path = join(absolute, entry);
    if (statSync(path).isDirectory())
      paths.push(...files(relative(root, path)));
    else if (entry.endsWith('.yml') || entry.endsWith('.yaml'))
      paths.push(path);
  }
  return paths;
}

const targets = [...files('.github/workflows'), ...files('.github/actions')];

const versionTagPattern =
  /uses:\s+([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)@v[0-9][^\s#]*/gu;

function applyPins(text) {
  let updated = text;
  for (const [tagRef, { sha, comment }] of Object.entries(pins)) {
    const repo = tagRef.slice(0, tagRef.lastIndexOf('@'));
    const pinned = `${repo}@${sha} # ${comment}`;
    updated = updated.replaceAll(`uses: ${tagRef}`, `uses: ${pinned}`);
  }
  return updated;
}

if (check) {
  let failed = false;
  for (const file of targets) {
    const text = readFileSync(file, 'utf8');
    if (versionTagPattern.test(text)) {
      failed = true;
      console.error(`version-tagged action ref: ${relative(root, file)}`);
      versionTagPattern.lastIndex = 0;
    }
    if (applyPins(text) !== text) {
      failed = true;
      console.error(`stale action pin: ${relative(root, file)}`);
    }
  }
  process.exit(failed ? 1 : 0);
}

let changed = 0;
for (const file of targets) {
  const text = readFileSync(file, 'utf8');
  const updated = applyPins(text);
  if (updated !== text) {
    writeFileSync(file, updated);
    changed += 1;
    console.log(relative(root, file));
  }
}
console.log(`updated ${changed} file(s)`);
