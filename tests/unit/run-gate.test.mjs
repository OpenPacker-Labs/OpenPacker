import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  packageOfSpecifier,
  packagesToBuild,
  publishedFileIsPresent,
  unbuiltPackages,
  workspaceSpecifiers,
} from '../../scripts/run-gate.mjs';

const root = resolve(import.meta.dirname, '../..');

test('a multiline import is a workspace package the gate builds', () => {
  const source = readFileSync(
    join(root, 'tests/property/canonical.test.mjs'),
    'utf8',
  );
  assert.deepEqual(workspaceSpecifiers(source), ['@openpacker/canonical']);
});

test('the prex property test imports chunking and the other built packages', () => {
  const source = readFileSync(
    join(root, 'tests/property/prex.test.mjs'),
    'utf8',
  );
  assert.deepEqual(workspaceSpecifiers(source), [
    '@openpacker/adapter-core',
    '@openpacker/adapter-npm',
    '@openpacker/adapter-cargo',
    '@openpacker/adapter-nuget',
    '@openpacker/canonical',
    '@openpacker/chunking',
    '@openpacker/embedded',
    '@openpacker/embedded/wasm-node',
    '@openpacker/lifecycle',
  ]);
});

test('a package named in a string is not an import', () => {
  const source = readFileSync(
    join(root, 'tests/unit/repository.test.mjs'),
    'utf8',
  );
  assert.deepEqual(workspaceSpecifiers(source), []);
});

test('a subpath is its package, and an absent export file is built once', () => {
  assert.equal(
    packageOfSpecifier('@openpacker/embedded/wasm-node'),
    '@openpacker/embedded',
  );
  assert.equal(
    packageOfSpecifier('@openpacker/chunking'),
    '@openpacker/chunking',
  );
  assert.equal(packageOfSpecifier('not-a-package'), null);
  const present = new Set(['@openpacker/canonical', '@openpacker/embedded']);
  assert.deepEqual(
    unbuiltPackages(
      [
        '@openpacker/canonical',
        '@openpacker/chunking',
        '@openpacker/embedded',
        '@openpacker/embedded/wasm-node',
      ],
      (specifier) => present.has(specifier),
    ),
    ['@openpacker/chunking', '@openpacker/embedded'],
  );
});

test('chunking is built when its export file is the one that is absent', () => {
  const source = readFileSync(
    join(root, 'tests/property/prex.test.mjs'),
    'utf8',
  );
  assert.deepEqual(
    packagesToBuild(
      [source],
      (specifier) => specifier !== '@openpacker/chunking',
    ),
    ['@openpacker/chunking'],
  );
});

test('node resolves an export that is not on disk, and that import is unbuilt', () => {
  assert.equal(
    publishedFileIsPresent('@openpacker/chunking', () => false),
    false,
  );
  assert.equal(publishedFileIsPresent('@openpacker/not-a-package'), false);
  assert.equal(publishedFileIsPresent('@openpacker/chunking/missing'), false);
});

test('the gate builds those packages before node --test loads them', () => {
  const source = readFileSync(join(root, 'scripts/run-gate.mjs'), 'utf8');
  const buildAt = source.indexOf('buildPackages(missing)');
  const testAt = source.indexOf("['--test', ...files]");
  assert.ok(buildAt !== -1 && testAt !== -1 && buildAt < testAt);
});
