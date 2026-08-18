#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const testFile = /\.(?:test|spec)\.(?:[cm]?js|tsx?)$/u;

function filesIn(path) {
  if (!existsSync(path)) return [];
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
    filesIn(join(path, entry.name)),
  );
}

function hasOracle(path) {
  if (!existsSync(path)) return false;
  return statSync(path).isDirectory()
    ? filesIn(path).some((file) => testFile.test(file))
    : true;
}

const workspaces = ['apps', 'examples', 'packages'].flatMap((directory) =>
  readdirSync(join(root, directory), { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        existsSync(join(root, directory, entry.name, 'package.json')),
    )
    .map((entry) => join(directory, entry.name)),
);
const failures = [];
for (const workspace of workspaces) {
  const manifest = JSON.parse(
    readFileSync(join(root, workspace, 'package.json'), 'utf8'),
  );
  if (!manifest.scripts?.test)
    failures.push(`${workspace}: missing test script`);
  if (!filesIn(join(root, workspace)).some((file) => testFile.test(file)))
    failures.push(`${workspace}: missing test file`);
}

const authorities = {
  unit: ['tests/unit'],
  property: ['tests/property'],
  conformance: ['tests/conformance', 'packages/conformance/test'],
  security: ['tests/security', 'packages/sandbox/src/escape.test.ts'],
  integration: ['tests/integration', 'integrations/mise/test'],
  e2e: ['tests/e2e'],
  compatibility: ['tests/compat'],
  browser: [
    'tests/browser',
    'examples/epoch-consumer/test/sdk-browser.playwright.mjs',
  ],
  fuzz: ['scripts/fuzz-smoke.mjs'],
  pact: ['examples/epoch-consumer/test/pact.consumer.test.ts'],
  chaos: ['examples/epoch-consumer/test/pact.chaos.test.ts'],
  mutation: [
    'examples/epoch-consumer/test/pact.mutation.test.ts',
    'tests/property/prex.test.mjs',
  ],
  'pack-parity': [
    'packages/adapters-default/src/standard-pack.test.ts',
    'packages/adapters-default/src/standard-pack.native.test.ts',
    'scripts/pack-parity-container.mjs',
  ],
  live: [
    'packages/adapter-nix/test/provider.live.test.ts',
    'packages/oci/scripts/live-interop.mjs',
  ],
};
for (const [type, paths] of Object.entries(authorities))
  for (const path of paths)
    if (!hasOracle(join(root, path)))
      failures.push(`${type}: missing oracle ${path}`);

const scripts = JSON.parse(
  readFileSync(join(root, 'package.json'), 'utf8'),
).scripts;
for (const name of [
  'test',
  'coverage',
  'test:conformance',
  'test:security',
  'test:integration',
  'test:e2e',
  'test:compat',
  'test:browser',
  'test:fuzz',
  'test:pack-parity',
  'test:pack-parity:native',
  'test:live',
])
  if (!scripts[name]) failures.push(`root: missing ${name} script`);

if (failures.length) throw new Error(failures.join('\n'));
console.log(
  `test inventory: ${workspaces.length} workspaces, ${Object.keys(authorities).length} test types`,
);
