import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  addPackage,
  initProject,
  readManifestFile,
  updateProject,
  writeManifestFile,
} from '../src/index.js';
import { projectPaths } from '../src/paths.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const fixtureTgz = join(repoRoot, 'fixtures/opm/demo-tool-1.1.0.tgz');

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function writeCatalog(
  root: string,
  versions: readonly { name: string; version: string }[],
): Promise<void> {
  const bytes = await readFile(fixtureTgz);
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const packages: Record<string, unknown> = {};
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

describe('updateProject mutation coverage', () => {
  it('kills a mutant that lets range ^1 accept 2.0.0', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opm-update-mut-'));
    temps.push(root);
    await initProject({ root, name: 'mutant-range' });
    await writeCatalog(root, [
      { name: 'alpha', version: '1.0.0' },
      { name: 'alpha', version: '1.9.0' },
      { name: 'alpha', version: '2.0.0' },
    ]);
    await addPackage({
      root,
      spec: 'pkg:npm/alpha@1.0.0',
      offline: true,
    });
    const paths = projectPaths(root);
    const manifest = await readManifestFile(paths.manifest);
    manifest.packages.alpha!.version = '^1';
    await writeManifestFile(paths.manifest, manifest);

    const result = await updateProject({ root, offline: true });
    expect(result.lock.packages.alpha?.version).toBe('1.9.0');
    expect(result.lock.packages.alpha?.version).not.toBe('2.0.0');
  });

  it('kills a mutant that treats a lock deleted mid-update as sync', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opm-update-lock-'));
    temps.push(root);
    await initProject({ root, name: 'mutant-lock' });
    await writeCatalog(root, [
      { name: 'alpha', version: '1.0.0' },
      { name: 'alpha', version: '1.2.0' },
    ]);
    await addPackage({
      root,
      spec: 'pkg:npm/alpha@1.0.0',
      offline: true,
    });
    const paths = projectPaths(root);
    const manifest = await readManifestFile(paths.manifest);
    manifest.packages.alpha!.version = '^1.0.0';
    await writeManifestFile(paths.manifest, manifest);

    const fifo = join(root, 'slow-catalog.json');
    const made = spawnSync('mkfifo', [fifo], { encoding: 'utf8' });
    if (made.status !== 0) {
      throw new Error(`mkfifo failed: ${made.stderr}`);
    }

    const updating = updateProject({
      root,
      offline: true,
      catalogPaths: [fifo],
    });
    const feeding = (async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 200));
      await rm(paths.lock);
      const handle = await open(fifo, 'w');
      try {
        await handle.write(
          `${JSON.stringify({ schemaVersion: 1, packages: {} }, null, 2)}\n`,
        );
      } finally {
        await handle.close();
      }
    })();

    await expect(updating).rejects.toMatchObject({
      code: expect.stringMatching(/^(INPUT_CHANGED|INVALID_LOCK)$/u),
    });
    await feeding;
  }, 15_000);
});
