import assert from 'node:assert/strict';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { copyWithoutScripts } from './pack-installed.mjs';

/**
 * package-install.test.mjs packs every installed dependency from a copy whose
 * manifest has no scripts. Where `node_modules/<name>` is a link to the real
 * install, the copy must be of the files it names: copying the link and then
 * rewriting "its" manifest would strip the scripts from the installed package.
 */

const manifest = `${JSON.stringify(
  {
    name: 'linked-dep',
    version: '1.0.0',
    scripts: { prepare: 'tshy' },
    main: 'index.js',
  },
  null,
  2,
)}\n`;

function installed(t) {
  const root = mkdtempSync(join(tmpdir(), 'openpacker-pack-installed-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const real = join(root, 'store', 'linked-dep');
  mkdirSync(join(real, 'node_modules', 'nested'), { recursive: true });
  writeFileSync(join(real, 'package.json'), manifest);
  writeFileSync(join(real, 'index.js'), 'module.exports = 1;\n');
  writeFileSync(join(real, 'node_modules', 'nested', 'index.js'), '');
  mkdirSync(join(root, 'node_modules'));
  return { root, real };
}

function assertCopied(copy) {
  assert.equal(lstatSync(copy).isSymbolicLink(), false);
  assert.equal(lstatSync(join(copy, 'package.json')).isSymbolicLink(), false);
  const copied = JSON.parse(readFileSync(join(copy, 'package.json'), 'utf8'));
  assert.equal(copied.scripts, undefined);
  assert.equal(copied.name, 'linked-dep');
  assert.equal(
    readFileSync(join(copy, 'index.js'), 'utf8'),
    'module.exports = 1;\n',
  );
  assert.equal(existsSync(join(copy, 'node_modules')), false);
}

test('a dependency whose node_modules entry is a link is copied, and the installed manifest keeps its scripts', (t) => {
  const { root, real } = installed(t);
  const linked = join(root, 'node_modules', 'linked-dep');
  symlinkSync(real, linked, 'dir');
  const copy = join(root, 'copy');

  copyWithoutScripts(linked, copy);

  assert.equal(readFileSync(join(real, 'package.json'), 'utf8'), manifest);
  assertCopied(copy);
});

test('a manifest that is itself a link is copied as a file, and the one it names is left alone', (t) => {
  const { root, real } = installed(t);
  const elsewhere = join(root, 'manifest.json');
  writeFileSync(elsewhere, manifest);
  rmSync(join(real, 'package.json'));
  symlinkSync(elsewhere, join(real, 'package.json'), 'file');
  const copy = join(root, 'copy');

  copyWithoutScripts(real, copy);

  assert.equal(readFileSync(elsewhere, 'utf8'), manifest);
  assertCopied(copy);
});
