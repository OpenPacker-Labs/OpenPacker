/**
 * Behavior specifications for range-aware `opm update`. Given/When/Then over
 * the public `updateProject` API: a ranged lock pin moves to the newest
 * in-range catalog version, and is not a synonym for sync.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { configureDefaultAdapters } from '@openpacker/adapters-default';

configureDefaultAdapters();

const {
  addPackage,
  initProject,
  projectPaths,
  readManifestFile,
  updateProject,
  writeManifestFile,
} = await import('@openpacker/opm-project');

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
const fixtureTgz = join(repoRoot, 'fixtures/opm/demo-tool-1.1.0.tgz');

async function writeCatalog(root, versions) {
  const bytes = await readFile(fixtureTgz);
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const packages = {};
  for (const { name, version } of versions) {
    const purl = `pkg:npm/${name}@${version}`;
    packages[purl] = {
      purl,
      version,
      digest,
      size: bytes.byteLength,
      format: 'tar+gzip',
      mediaType: 'application/vnd.npm.package+gzip',
      source: `file:${fixtureTgz}`,
      bins: [{ name, path: 'package/bin/demo-tool.js' }],
    };
  }
  await writeFile(
    join(root, '.opm/catalog.json'),
    `${JSON.stringify({ schemaVersion: 1, packages }, null, 2)}\n`,
  );
}

test('Given a manifest range and an older lock, When updateProject runs, Then the lock exact version is the newest in-range fixture version', async () => {
  // Given a project whose manifest allows ^1.0.0 but whose lock is still on 1.0.0
  const root = await mkdtemp(join(tmpdir(), 'opm-update-bdd-'));
  try {
    await initProject({ root, name: 'update-bdd' });
    await writeCatalog(root, [
      { name: 'alpha', version: '1.0.0' },
      { name: 'alpha', version: '1.2.0' },
      { name: 'alpha', version: '2.0.0' },
    ]);
    await addPackage({
      root,
      spec: 'pkg:npm/alpha@1.0.0',
      offline: true,
    });
    const paths = projectPaths(root);
    const manifest = await readManifestFile(paths.manifest);
    manifest.packages.alpha.version = '^1.0.0';
    await writeManifestFile(paths.manifest, manifest);

    // When the operator asks opm to update within the committed range
    const result = await updateProject({ root, offline: true });

    // Then the lock moves to the newest in-range fixture version, not 2.0.0
    assert.equal(result.lock.packages.alpha.version, '1.2.0');
    assert.equal(result.lock.packages.alpha.purl, 'pkg:npm/alpha@1.2.0');
    assert.deepEqual([...result.updated], ['alpha']);
    assert.equal(result.manifest.packages.alpha.version, '^1.0.0');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
