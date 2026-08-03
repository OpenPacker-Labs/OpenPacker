import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const json = (path) => JSON.parse(readFileSync(join(root, path), 'utf8'));

test('offline npm, Cargo, and NuGet catalogs are substantive and immutable-input shaped', () => {
  const npm = json('fixtures/catalogs/npm/packument.json');
  const cargo = readFileSync(
    join(root, 'fixtures/catalogs/cargo/index/demo-zstd'),
    'utf8',
  )
    .trim()
    .split('\n')
    .map(JSON.parse);
  const nuget = json('fixtures/catalogs/nuget/registration-demo.tool.json');
  const nugetPage = json(
    'fixtures/catalogs/nuget/registration-demo.tool-page-1.json',
  );
  assert.ok(
    Object.keys(npm.versions ?? {}).length >= 2,
    'npm fixture needs competing versions',
  );
  assert.ok(cargo.length >= 2, 'Cargo fixture needs competing versions');
  assert.ok(
    JSON.stringify(nugetPage).includes('catalogEntry'),
    'NuGet fixture needs registration entries',
  );
  assert.doesNotMatch(
    JSON.stringify({ npm, cargo, nuget, nugetPage }),
    /localhost|127\.0\.0\.1/u,
    'catalog identity must not depend on an ephemeral demo port',
  );
});

test('native lock capture fixtures exist for all required ecosystems', () => {
  const npm = json('fixtures/catalogs/npm/package-lock.json');
  const cargo = readFileSync(
    join(root, 'fixtures/catalogs/cargo/Cargo.lock'),
    'utf8',
  );
  const nuget = json('fixtures/catalogs/nuget/project.assets.json');
  assert.equal(npm.lockfileVersion, 3);
  assert.match(cargo, /^version\s*=\s*\d+/mu);
  assert.ok(
    nuget.version === 3 || nuget.targets,
    'NuGet assets fixture must be a v3 lock graph',
  );
});
