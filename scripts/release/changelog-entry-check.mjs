#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const manifest = JSON.parse(
  readFileSync(resolve(root, 'apps/openpacker-cli/package.json'), 'utf8'),
);
const version = manifest.version;
const changelog = readFileSync(resolve(root, 'CHANGELOG.md'), 'utf8');
const escaped = version.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const heading = new RegExp(`^##\\s+\\[?${escaped}\\]?(?:\\s|$)`, 'mu');
if (!heading.test(changelog)) {
  console.error(
    `changelog-entry-check: CHANGELOG.md has no ## entry for ${version}`,
  );
  process.exit(1);
}
console.log(`changelog-entry-check: found an entry for ${version}`);
