/**
 * Behavior: pack → PREX publish → yank. Given packed native bytes, when they
 * are published to a loopback daemon with OPENPACKER_PUBLISH_STORE, then yank
 * marks that exact version ineligible.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const { configureDefaultAdapters } = await import(
  '@openpacker/adapters-default'
);
const { packProject, publishPackedArtifact, yankRegistryVersion } =
  await import('@openpacker/opm-project');
const {
  createStandaloneReferenceOperations,
  createFilesystemPublishStore,
  startOpenPackerDaemon,
} = await import('@openpacker/openpackerd');

test('Given a packed fixture, when published to a loopback PREX daemon, then yank marks the version ineligible', async (t) => {
  configureDefaultAdapters();
  const root = await mkdtemp(join(tmpdir(), 'upm-publish-yank-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  // Given a packable npm project and an opt-in filesystem publish store
  await writeFile(
    join(root, 'package.json'),
    '{"name":"demo","version":"1.0.0"}\n',
  );
  await writeFile(join(root, 'index.js'), 'export const value = 1;\n');
  const outputDirectory = join(root, 'out');
  const packed = await packProject({
    root,
    ecosystem: 'npm',
    strategy: 'standard',
    name: 'demo',
    version: '1.0.0',
    outputDirectory,
  });
  assert.equal(packed.performed, true);

  const storeDir = join(root, 'publish-store');
  const operations = await createStandaloneReferenceOperations(undefined, {
    env: { OPENPACKER_PUBLISH_STORE: storeDir },
  });
  const daemon = await startOpenPackerDaemon({
    operations,
    databasePath: join(root, 'daemon.sqlite'),
    host: '127.0.0.1',
    port: 0,
    logger: false,
  });
  t.after(() => daemon.close());

  // When the packed artifact is published, then yanked
  await publishPackedArtifact({
    from: outputDirectory,
    registry: daemon.address,
  });
  await yankRegistryVersion({
    purl: 'pkg:npm/demo@1.0.0',
    registry: daemon.address,
    reason: 'security',
  });

  // Then the publish-store metadata is yanked and ineligible.
  const store = createFilesystemPublishStore({ root: storeDir });
  const record = await store.getRecord('demo', '1.0.0');
  assert.equal(record?.lifecycle.status, 'yanked');
  assert.equal(record?.lifecycle.eligible, false);
});
