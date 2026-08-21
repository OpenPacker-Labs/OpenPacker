import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { FixtureHttpTransport } from '@openpacker/adapter-core';
import {
  addPackage,
  initProject,
  readLockfile,
  readManifestFile,
  syncProject,
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

async function digestOfFixture(): Promise<{
  digest: string;
  size: number;
}> {
  const bytes = await readFile(fixtureTgz);
  return {
    digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    size: bytes.byteLength,
  };
}

async function writeCatalog(
  root: string,
  versions: readonly { name: string; version: string }[],
): Promise<void> {
  const { digest, size } = await digestOfFixture();
  const packages: Record<
    string,
    {
      purl: string;
      version: string;
      digest: string;
      size: number;
      format: string;
      mediaType: string;
      source: string;
      bins: { name: string; path: string }[];
    }
  > = {};
  for (const { name, version } of versions) {
    const purl = `pkg:npm/${name}@${version}`;
    packages[purl] = {
      purl,
      version,
      digest,
      size,
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

async function tempProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'opm-update-'));
  temps.push(dir);
  await initProject({ root: dir, name: 'update-app' });
  return dir;
}

async function rewriteVersion(
  root: string,
  alias: string,
  version: string,
): Promise<void> {
  const paths = projectPaths(root);
  const manifest = await readManifestFile(paths.manifest);
  const pkg = manifest.packages[alias];
  if (!pkg) throw new Error(`missing ${alias}`);
  pkg.version = version;
  await writeManifestFile(paths.manifest, manifest);
}

describe('updateProject', () => {
  it('bumps a ranged direct to the newest in-range catalog version and leaves an unselected exact pin', async () => {
    const root = await tempProject();
    await writeCatalog(root, [
      { name: 'alpha', version: '1.0.0' },
      { name: 'alpha', version: '1.2.0' },
      { name: 'beta', version: '1.0.0' },
    ]);
    await addPackage({
      root,
      spec: 'pkg:npm/alpha@1.0.0',
      offline: true,
    });
    await addPackage({
      root,
      spec: 'pkg:npm/beta@1.0.0',
      offline: true,
    });
    await rewriteVersion(root, 'alpha', '^1.0.0');

    const result = await updateProject({ root, offline: true });
    expect(result.lock.packages.alpha?.version).toBe('1.2.0');
    expect(result.lock.packages.alpha?.purl).toBe('pkg:npm/alpha@1.2.0');
    expect(result.lock.packages.beta?.version).toBe('1.0.0');
    expect(result.updated).toEqual(['alpha']);
    expect(result.manifest.packages.alpha?.version).toBe('^1.0.0');
  });

  it('does not change an exact pin unless latest is set', async () => {
    const root = await tempProject();
    await writeCatalog(root, [
      { name: 'alpha', version: '1.0.0' },
      { name: 'alpha', version: '1.2.0' },
    ]);
    await addPackage({
      root,
      spec: 'pkg:npm/alpha@1.0.0',
      offline: true,
    });

    const result = await updateProject({ root, offline: true });
    expect(result.lock.packages.alpha?.version).toBe('1.0.0');
    expect(result.updated).toEqual([]);
  });

  it('refuses to update a named exact pin without --latest', async () => {
    const root = await tempProject();
    await writeCatalog(root, [
      { name: 'alpha', version: '1.0.0' },
      { name: 'alpha', version: '1.2.0' },
    ]);
    await addPackage({
      root,
      spec: 'pkg:npm/alpha@1.0.0',
      offline: true,
    });

    await expect(
      updateProject({ root, aliases: ['alpha'], offline: true }),
    ).rejects.toMatchObject({
      code: 'UNRESOLVABLE',
      message: expect.stringMatching(/exact pin; pass --latest/u),
    });
  });

  it('rewrites the manifest version and lock when latest is set on an exact pin', async () => {
    const root = await tempProject();
    await writeCatalog(root, [
      { name: 'alpha', version: '1.0.0' },
      { name: 'alpha', version: '1.2.0' },
    ]);
    await addPackage({
      root,
      spec: 'pkg:npm/alpha@1.0.0',
      offline: true,
    });

    const result = await updateProject({
      root,
      aliases: ['alpha'],
      latest: true,
      offline: true,
    });
    expect(result.manifest.packages.alpha?.version).toBe('1.2.0');
    expect(result.lock.packages.alpha?.version).toBe('1.2.0');
    expect(result.updated).toEqual(['alpha']);
    const disk = await readManifestFile(projectPaths(root).manifest);
    expect(disk.packages.alpha?.version).toBe('1.2.0');
  });

  it('updates only the named ranged alias and keeps the other ranged lock pin', async () => {
    const root = await tempProject();
    await writeCatalog(root, [
      { name: 'alpha', version: '1.0.0' },
      { name: 'alpha', version: '1.2.0' },
      { name: 'gamma', version: '1.0.0' },
      { name: 'gamma', version: '1.1.0' },
    ]);
    await addPackage({
      root,
      spec: 'pkg:npm/alpha@1.0.0',
      offline: true,
    });
    await addPackage({
      root,
      spec: 'pkg:npm/gamma@1.0.0',
      offline: true,
    });
    await rewriteVersion(root, 'alpha', '^1.0.0');
    await rewriteVersion(root, 'gamma', '^1.0.0');

    const result = await updateProject({
      root,
      aliases: ['alpha'],
      offline: true,
    });
    expect(result.lock.packages.alpha?.version).toBe('1.2.0');
    expect(result.lock.packages.gamma?.version).toBe('1.0.0');
    expect(result.updated).toEqual(['alpha']);
  });

  it('throws NOT_FOUND for an alias that is not a direct package', async () => {
    const root = await tempProject();
    await expect(
      updateProject({ root, aliases: ['missing'], offline: true }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('is a no-op for file-sourced packages', async () => {
    const root = await tempProject();
    await addPackage({
      root,
      spec: 'pkg:npm/demo-tool@1.1.0',
      source: fixtureTgz,
      offline: true,
    });
    const before = await readLockfile(projectPaths(root).lock);
    const result = await updateProject({
      root,
      aliases: ['demo-tool'],
      latest: true,
      offline: true,
    });
    expect(result.updated).toEqual([]);
    expect(result.lock.packages['demo-tool']?.purl).toBe(
      before?.packages['demo-tool']?.purl,
    );
  });

  it('fails closed offline when a registry-sourced package has no catalog versions', async () => {
    const root = await tempProject();
    await writeCatalog(root, [{ name: 'alpha', version: '1.0.0' }]);
    await addPackage({
      root,
      spec: 'pkg:npm/alpha@1.0.0',
      offline: true,
    });
    await rewriteVersion(root, 'alpha', '^1.0.0');
    await writeFile(
      join(root, '.opm/catalog.json'),
      `${JSON.stringify({ schemaVersion: 1, packages: {} }, null, 2)}\n`,
    );

    await expect(updateProject({ root, offline: true })).rejects.toMatchObject({
      code: expect.stringMatching(/^(UNRESOLVABLE|UNAVAILABLE)$/u),
    });
  });

  it('differs from syncProject: update picks the newest in-range version, not the first catalog match', async () => {
    const root = await tempProject();
    await writeCatalog(root, [
      { name: 'alpha', version: '1.0.0' },
      { name: 'alpha', version: '1.2.0' },
    ]);
    await addPackage({
      root,
      spec: 'pkg:npm/alpha@1.0.0',
      offline: true,
    });
    await rewriteVersion(root, 'alpha', '^1.0.0');

    const synced = await syncProject({ root, offline: true });
    expect(synced.lock.packages.alpha?.version).toBe('1.0.0');

    await addPackage({
      root,
      spec: 'pkg:npm/alpha@1.0.0',
      offline: true,
    });
    await rewriteVersion(root, 'alpha', '^1.0.0');
    const updated = await updateProject({ root, offline: true });
    expect(updated.lock.packages.alpha?.version).toBe('1.2.0');
  });

  it('acts like sync when no lock is present and still reports updated aliases', async () => {
    const root = await tempProject();
    await writeCatalog(root, [
      { name: 'alpha', version: '1.0.0' },
      { name: 'alpha', version: '1.2.0' },
    ]);
    const paths = projectPaths(root);
    const manifest = await readManifestFile(paths.manifest);
    manifest.packages.alpha = {
      alias: 'alpha',
      purl: 'pkg:npm/alpha',
      version: '^1.0.0',
    };
    await writeManifestFile(paths.manifest, manifest);
    await rm(paths.lock, { force: true });

    const result = await updateProject({ root, offline: true });
    expect(result.lock.packages.alpha).toBeDefined();
    expect(result.updated).toContain('alpha');
  });

  it('snapshots the lock rewrite for a ranged bump', async () => {
    const root = await tempProject();
    await writeCatalog(root, [
      { name: 'alpha', version: '1.0.0' },
      { name: 'alpha', version: '1.2.0' },
      { name: 'beta', version: '1.0.0' },
    ]);
    await addPackage({
      root,
      spec: 'pkg:npm/alpha@1.0.0',
      offline: true,
    });
    await addPackage({
      root,
      spec: 'pkg:npm/beta@1.0.0',
      offline: true,
    });
    await rewriteVersion(root, 'alpha', '^1.0.0');
    const result = await updateProject({ root, offline: true });
    const packages: Record<
      string,
      { purl: string; version: string; reason: string; digest: string }
    > = {};
    for (const alias of Object.keys(result.lock.packages).sort()) {
      const pkg = result.lock.packages[alias]!;
      packages[alias] = {
        purl: pkg.purl,
        version: pkg.version,
        reason: pkg.reason,
        digest: pkg.digest,
      };
    }
    await expect(
      `${JSON.stringify({ packages }, null, 2)}\n`,
    ).toMatchFileSnapshot('__snapshots__/update-lock.snap');
  });

  it('skips a yanked newest version and keeps the latest eligible in-range pin', async () => {
    const root = await tempProject();
    const { digest, size } = await digestOfFixture();
    await writeFile(
      join(root, '.opm/catalog.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          packages: {
            'pkg:pypi/demo-tool@1.0.0': {
              purl: 'pkg:pypi/demo-tool@1.0.0',
              version: '1.0.0',
              digest,
              size,
              format: 'tar+gzip',
              mediaType: 'application/vnd.pypi.package+gzip',
              source: `file:${fixtureTgz}`,
              bins: [],
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    await addPackage({
      root,
      spec: 'pkg:pypi/demo-tool@1.0.0',
      offline: true,
    });
    await rewriteVersion(root, 'demo-tool', '>=1.0.0');

    const encoder = new TextEncoder();
    const fixtureDir = new URL(
      '../../../fixtures/catalogs/pypi/',
      import.meta.url,
    );
    const demoProject = await readFile(new URL('project.json', fixtureDir));
    const rewritten = encoder.encode(
      new TextDecoder()
        .decode(demoProject)
        .replaceAll(
          'https://fixtures.openpacker.invalid/pypi/',
          'https://files.pythonhosted.org/packages/fixture/',
        ),
    );
    const transport = new FixtureHttpTransport(
      new Map([
        [
          'https://fixtures.test/demo-tool/json',
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: rewritten,
          },
        ],
      ]),
    );
    const previousRegistry = process.env.OPM_REGISTRY_PYPI;
    const previousOrigins = process.env.OPM_REGISTRY_PYPI_ORIGINS;
    process.env.OPM_REGISTRY_PYPI = 'https://fixtures.test';
    process.env.OPM_REGISTRY_PYPI_ORIGINS = 'https://files.pythonhosted.org';
    try {
      const result = await updateProject({
        root,
        offline: false,
        registryOptions: {
          transport,
          now: () => '2026-08-04T00:00:00Z',
        },
      });
      expect(transport.requests.length).toBeGreaterThan(0);
      expect(result.lock.packages['demo-tool']?.version).toBe('1.0.0');
      expect(result.lock.packages['demo-tool']?.purl).not.toContain('@1.1.0');
    } finally {
      if (previousRegistry === undefined) delete process.env.OPM_REGISTRY_PYPI;
      else process.env.OPM_REGISTRY_PYPI = previousRegistry;
      if (previousOrigins === undefined)
        delete process.env.OPM_REGISTRY_PYPI_ORIGINS;
      else process.env.OPM_REGISTRY_PYPI_ORIGINS = previousOrigins;
    }
  });
});
