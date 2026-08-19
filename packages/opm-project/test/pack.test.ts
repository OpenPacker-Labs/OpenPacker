import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { configureDefaultAdapters } from '@openpacker/adapters-default';
import { AdapterRegistry, setAdapterRegistry } from '@openpacker/adapter-host';
import type { PackagePacker } from '@openpacker/adapter-core';
import type { PackReceipt } from '@openpacker/contracts';
import { inspectArchive } from '@openpacker/materializer';
import { PACK_RECEIPT, packProject } from '../src/pack.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('pack project', () => {
  it('standardizes by default inputs and writes a canonical receipt', async () => {
    configureDefaultAdapters();
    const root = await mkdtemp(join(tmpdir(), 'opm-standard-pack-'));
    roots.push(root);
    await writeFile(
      join(root, 'package.json'),
      '{"name":"demo","version":"1.0.0"}\n',
    );
    await writeFile(join(root, 'index.js'), 'export const value = 1;\n');
    const outputDirectory = join(root, 'out');

    const first = await packProject({
      root,
      ecosystem: 'npm',
      strategy: 'standard',
      name: 'demo',
      version: '1.0.0',
      outputDirectory,
    });
    const firstBytes = await readFile(
      first.artifacts.find(
        (artifact) => artifact.nativeRole === 'distribution',
      )!.path,
    );
    const second = await packProject({
      root,
      ecosystem: 'npm',
      strategy: 'standard',
      name: 'demo',
      version: '1.0.0',
      outputDirectory,
    });
    const secondBytes = await readFile(
      second.artifacts.find(
        (artifact) => artifact.nativeRole === 'distribution',
      )!.path,
    );

    expect(firstBytes).toEqual(secondBytes);
    expect(first.artifacts.map((artifact) => artifact.nativeRole)).toEqual([
      'distribution',
      'receipt',
    ]);
    const receipt = JSON.parse(
      await readFile(join(outputDirectory, PACK_RECEIPT), 'utf8'),
    ) as PackReceipt;
    expect(receipt.strategy).toBe('standard');
    expect(receipt.target).toEqual(
      expect.objectContaining({ purlType: 'npm', identifier: 'demo' }),
    );
    expect(receipt.artifacts).toHaveLength(1);
    expect(receipt.artifacts[0]?.descriptorId).toBe(
      first.artifacts.find((artifact) => artifact.nativeRole === 'distribution')
        ?.digest,
    );
    expect(receipt.normalizedManifestDigest.value).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('plans standard packing without probing native tools', async () => {
    configureDefaultAdapters();
    const root = await mkdtemp(join(tmpdir(), 'opm-standard-plan-'));
    roots.push(root);
    await writeFile(
      join(root, 'Cargo.toml'),
      '[package]\nname="demo"\nversion="1.0.0"\n',
    );
    const result = await packProject({
      root,
      ecosystem: 'cargo',
      strategy: 'standard',
      name: 'demo',
      version: '1.0.0',
      dryRun: true,
    });
    expect(result).toEqual(
      expect.objectContaining({
        strategy: 'standard',
        performed: false,
        requiresBuild: false,
        requiresNetwork: false,
      }),
    );
  });

  it('uses npm publish selection before normalized capture', async () => {
    configureDefaultAdapters();
    const root = await mkdtemp(join(tmpdir(), 'opm-standard-npm-files-'));
    roots.push(root);
    await mkdir(join(root, 'dist'));
    await writeFile(
      join(root, 'package.json'),
      '{"name":"demo","version":"1.0.0","files":["dist"]}\n',
    );
    await writeFile(join(root, 'dist', 'index.js'), 'export default 1;\n');
    await writeFile(join(root, 'source.js'), 'excluded source\n');
    await writeFile(join(root, '.npmignore'), 'source.js\n');
    await writeFile(join(root, '.npmrc'), '//registry/:_authToken=secret\n');
    await writeFile(join(root, 'package-lock.json'), '{"lockfileVersion":3}\n');

    const result = await packProject({
      root,
      ecosystem: 'npm',
      strategy: 'standard',
      name: 'demo',
      version: '1.0.0',
    });
    const archive = result.artifacts.find(
      (artifact) => artifact.nativeRole === 'distribution',
    )!;
    expect(
      (await inspectArchive(await readFile(archive.path), 'tar+gzip')).map(
        (entry) => entry.path,
      ),
    ).toEqual(['package/dist/index.js', 'package/package.json']);
  });

  it('rejects duplicate artifact identities before writing a receipt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opm-duplicate-pack-'));
    roots.push(root);
    await writeFile(
      join(root, 'package.json'),
      '{"name":"demo","version":"1.0.0"}\n',
    );
    const digest = `sha256:${'a'.repeat(64)}`;
    const plan = {
      strategy: 'delegate' as const,
      purlType: 'fixture',
      command: ['fixture'],
      commands: [['fixture']],
      requiresBuild: false,
      requiresNetwork: false,
      expectedRoles: ['distribution'],
      semanticLoss: [],
    };
    const packer: PackagePacker = {
      providerId: 'fixture',
      providerManifestDigest: `sha256:${'b'.repeat(64)}`,
      purlType: 'fixture',
      async available() {
        return { available: true };
      },
      async detect(projectRoot) {
        return {
          root: projectRoot,
          manifestPath: join(projectRoot, 'package.json'),
        };
      },
      async plan() {
        return plan;
      },
      async pack() {
        return {
          ...plan,
          performed: true,
          exitCode: 0,
          stdout: '',
          stderr: '',
          artifacts: ['one', 'two'].map((name) => ({
            path: join(root, `${name}.fixture`),
            exactPurl: 'pkg:fixture/demo@1.0.0',
            mediaType: 'application/octet-stream',
            size: 1,
            digest,
            nativeRole: 'distribution',
          })),
        };
      },
    };
    const registry = new AdapterRegistry();
    registry.registerPackProvider(packer, { makeDefault: true });
    setAdapterRegistry(registry);

    await expect(
      packProject({
        root,
        ecosystem: 'fixture',
        strategy: 'delegate',
        name: 'demo',
        version: '1.0.0',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
});
