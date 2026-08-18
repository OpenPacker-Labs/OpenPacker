import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Distribution, PackageManifest } from '@openpacker/contracts';
import { inspectArchive } from '@openpacker/materializer';
import { normalizeProjectPack } from '../src/pack-normalize.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('normalized pack input', () => {
  it('captures a stable, bounded OCI layer without stores, secrets, or symlinks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opm-normalize-'));
    roots.push(root);
    await mkdir(join(root, '.git'));
    await mkdir(join(root, '.opm'));
    await writeFile(join(root, 'b.txt'), 'b');
    await writeFile(join(root, 'a.txt'), 'a');
    await writeFile(join(root, '.env'), 'TOKEN=secret');
    await writeFile(join(root, '.git', 'config'), 'private');
    await writeFile(join(root, '.opm', 'lock.json'), 'state');
    await symlink('/etc/passwd', join(root, 'escape'));

    const first = await normalizeProjectPack({
      root,
      package: manifest,
      target,
    });
    const second = await normalizeProjectPack({
      root,
      package: manifest,
      target,
    });

    expect(first.bytes).toEqual(second.bytes);
    expect(first.layerBytes).toEqual(second.layerBytes);
    expect(first.manifest.tree.entries.map((entry) => entry.path)).toEqual([
      'a.txt',
      'b.txt',
    ]);
    expect(
      (await inspectArchive(first.layerBytes, 'tar')).map(
        (entry) => entry.path,
      ),
    ).toEqual(['a.txt', 'b.txt']);
    expect(first.manifest.oci.layers[0]?.treeDigest).toEqual(
      second.manifest.oci.layers[0]?.treeDigest,
    );
  });

  it('fails closed when the target is not declared', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opm-normalize-target-'));
    roots.push(root);
    await writeFile(join(root, 'file'), 'x');
    await expect(
      normalizeProjectPack({
        root,
        package: manifest,
        target: { ...target, identifier: 'different' },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_TARGET' });
  });
});

const target: Distribution = {
  purlType: 'npm',
  identifier: 'demo',
  version: '1.0.0',
  exactPurl: 'pkg:npm/demo@1.0.0',
  requirements: [],
};

const manifest: PackageManifest = {
  packageManifestVersion: '1',
  name: 'demo',
  version: '1.0.0',
  distributions: [target],
};
