import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import test from 'node:test';
import { join, relative, resolve } from 'node:path';
import { validateArchivePath } from '@openpacker/materializer';

const root = resolve(import.meta.dirname, '../..');

function walk(directory) {
  const files = [];
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name);
    if (['dist', 'node_modules', '.turbo'].includes(name)) continue;
    if (statSync(path).isDirectory()) files.push(...walk(path));
    else files.push(path);
  }
  return files;
}

test('production OpenPacker code has no Epoch or ATProto imports', () => {
  const roots = ['apps', 'crates', 'packages', 'integrations']
    .map((directory) => join(root, directory))
    .filter((directory) => {
      try {
        return statSync(directory).isDirectory();
      } catch {
        return false;
      }
    });
  const forbidden =
    /(?:from\s+|import\s*\(|require\s*\()\s*["'](?:@epoch\/|epoch(?:[\/@"'])|@atproto\/|atproto(?:[\/@"']))/u;
  const violations = roots
    .flatMap(walk)
    .filter((path) => /\.(?:[cm]?[jt]s|rs|lua)$/u.test(path))
    .filter((path) => forbidden.test(readFileSync(path, 'utf8')));
  assert.deepEqual(
    violations.map((path) => relative(root, path)),
    [],
  );
});

test('artifact exploit corpus executes every path escape vector', () => {
  const vectors = JSON.parse(
    readFileSync(
      join(root, 'fixtures/artifacts/security/archive-cases.json'),
      'utf8',
    ),
  );
  const pathEscapes = new Set([
    'parent-traversal',
    'posix-absolute',
    'windows-drive',
    'windows-unc',
  ]);
  const executed = vectors.mustReject.filter(({ id }) => pathEscapes.has(id));
  assert.equal(executed.length, pathEscapes.size);
  for (const vector of executed)
    assert.throws(
      () => validateArchivePath(vector.path),
      undefined,
      `${vector.id} was accepted`,
    );

  assert.deepEqual(
    new Set(vectors.mustReject.map(({ id }) => id)),
    new Set([
      ...pathEscapes,
      'symlink',
      'hardlink',
      'special-device',
      'fifo',
      'unsafe-permission',
      'case-collision',
      'duplicate',
    ]),
  );
  assert.deepEqual(Object.keys(vectors.bombPolicy).sort(), [
    'maximumCompressedBytes',
    'maximumCompressionRatio',
    'maximumDepth',
    'maximumExpandedBytes',
    'maximumFiles',
    'maximumPathBytes',
  ]);
});

test('mandatory scripts cannot execute package lifecycle hooks', () => {
  const packageJson = JSON.parse(
    readFileSync(join(root, 'package.json'), 'utf8'),
  );
  const commands = [
    'demo',
    'verify',
    'test',
    'test:conformance',
    'test:security',
    'test:integration',
    'test:e2e',
  ];
  for (const command of commands) {
    assert.equal(
      typeof packageJson.scripts?.[command],
      'string',
      `missing root ${command} script`,
    );
    assert.doesNotMatch(
      packageJson.scripts[command],
      /(?:npm|pnpm|yarn)\s+(?:install|rebuild)(?:\s|$)/u,
      `${command} may execute dependency lifecycle scripts`,
    );
  }
});
