import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const require = createRequire(import.meta.url);
const dual = readdirSync(join(root, 'packages'))
  .filter((name) => {
    const manifest = JSON.parse(
      readFileSync(join(root, 'packages', name, 'package.json'), 'utf8'),
    );
    return manifest.private !== true;
  })
  .sort();

test('public Node packages declare real dual ESM/CommonJS exports', async () => {
  for (const name of dual) {
    const manifest = JSON.parse(
      readFileSync(join(root, 'packages', name, 'package.json'), 'utf8'),
    );
    assert.equal(manifest.type, 'module', `${name}: expected type=module`);
    assert.equal(
      typeof manifest.exports?.['.']?.import,
      'string',
      `${name}: missing import export`,
    );
    assert.equal(
      typeof manifest.exports?.['.']?.require,
      'string',
      `${name}: missing require export`,
    );
    const specifier = `@openpacker/${name}`;
    assert.equal(
      typeof (await import(specifier)),
      'object',
      `${name}: ESM import failed`,
    );
    assert.equal(
      typeof require(specifier),
      'object',
      `${name}: CommonJS require failed`,
    );
  }
});

test('browser entry points do not import Node built-ins', () => {
  for (const [name, file] of [
    ['sdk', 'src/browser.ts'],
    ['embedded', 'src/index.ts'],
  ]) {
    const source = readFileSync(join(root, 'packages', name, file), 'utf8');
    assert.doesNotMatch(
      source,
      /(?:node:|from\s+["'](?:fs|path|crypto|stream|buffer|util)["'])/u,
      `${name} browser surface imports a Node built-in`,
    );
  }
});
