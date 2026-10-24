import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { configureDefaultAdapters } from '@openpacker/adapters-default';
import {
  addPackage,
  initProject,
  projectPaths,
  readManifestFile,
  updateProject,
  writeManifestFile,
} from '../src/index.js';
import { assertLockMatchesManifest } from '../src/project.js';
import { isPinnedVersion, registryHintFor } from '../src/registry-target.js';
import { direct, lockOf, permissive } from './closure-support.js';
import {
  NpmRegistryFixture,
  type FixturePackage,
} from './npm-registry-fixture.js';

configureDefaultAdapters();

/**
 * A plain dist-tag, `"lib": "latest"` or `"lib": "next"`, as npm and pnpm read
 * it: the release the registry's dist-tags name, locked as that exact version
 * (ADR 0054 §3, amended 2026-10-17). In a package's dependencies it used to
 * fail the package ("a tag specifier that is not a registry version range"),
 * and in opm.toml a second `opm install` said "Lock package lib does not match
 * manifest version latest", because `latest` was taken for a pinned version.
 */

const lib = (next = '2.0.0-rc.1'): FixturePackage => ({
  name: 'lib',
  versions: { '1.0.0': {}, '1.1.0': {}, '2.0.0-rc.1': {}, '2.0.0-rc.2': {} },
  distTags: { latest: '1.0.0', next },
});

const app = (dependencies: Record<string, string>): FixturePackage => ({
  name: 'app',
  versions: { '1.0.0': { dependencies } },
});

describe('a plain dist-tag in a dependency', () => {
  it('takes the release each tag names, and locks the version', async () => {
    const { lock } = await lockOf(
      [
        app({ lib: 'latest', other: 'next' }),
        lib(),
        { ...lib('2.0.0-rc.2'), name: 'other' },
      ],
      direct('app', '1.0.0'),
    );
    // `latest` is 1.0.0 though 1.1.0 is newer: the tag decides, not the order.
    expect(lock.packages.lib?.purl).toBe('pkg:npm/lib@1.0.0');
    expect(lock.packages.other?.purl).toBe('pkg:npm/other@2.0.0-rc.2');
    expect(lock.packages.app?.dependencies).toEqual(['lib', 'other']);
    expect(JSON.stringify(lock)).not.toMatch(/"(latest|next)"/u);
  });

  it('says which dependent asked for a tag the package does not have', async () => {
    await expect(
      lockOf([app({ lib: 'ghost' }), lib()], direct('app', '1.0.0')),
    ).rejects.toMatchObject({
      code: 'UNRESOLVABLE',
      message: expect.stringMatching(
        /pkg:npm\/lib: the package has no dist-tag "ghost" \(required by pkg:npm\/app@1\.0\.0\)/u,
      ),
    });
  });
});

describe('a plain dist-tag in opm.toml', () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  const project = async () => {
    const root = await mkdtemp(join(tmpdir(), 'opm-dist-tag-'));
    roots.push(root);
    await initProject({ root, name: 'tags' });
    const paths = projectPaths(root);
    const manifest = await readManifestFile(paths.manifest);
    manifest.project.ecosystems = ['npm'];
    manifest.policy = permissive;
    await writeManifestFile(paths.manifest, manifest);
    return { root, paths };
  };

  it('is kept as the tag in opm.toml, locked as a version, and the lock is its lock', async () => {
    const { root, paths } = await project();
    const added = await addPackage({
      root,
      spec: 'pkg:npm/lib@next',
      registryOptions: { transport: new NpmRegistryFixture([lib()]) },
    });
    expect(added.lock.packages.lib?.purl).toBe('pkg:npm/lib@2.0.0-rc.1');
    expect(await readFile(paths.manifest, 'utf8')).toContain(
      'version = "next"',
    );
    // A lock that says 2.0.0-rc.1 for `next` is the lock of that manifest:
    // what `opm install` checks before it installs from a lock.
    expect(() =>
      assertLockMatchesManifest(root, added.manifest, added.lock),
    ).not.toThrow();
  });

  it('moves with the tag on opm update', async () => {
    const { root, paths } = await project();
    await addPackage({
      root,
      spec: 'pkg:npm/lib@next',
      registryOptions: { transport: new NpmRegistryFixture([lib()]) },
    });
    const updated = await updateProject({
      root,
      registryOptions: {
        transport: new NpmRegistryFixture([lib('2.0.0-rc.2')]),
      },
    });
    expect(updated.updated).toEqual(['lib']);
    expect(updated.lock.packages.lib?.purl).toBe('pkg:npm/lib@2.0.0-rc.2');
    expect((await readManifestFile(paths.manifest)).packages.lib?.version).toBe(
      'next',
    );
  });

  it('refuses an update to a tag the registry dropped, by name', async () => {
    const { root } = await project();
    await addPackage({
      root,
      spec: 'pkg:npm/lib@next',
      registryOptions: { transport: new NpmRegistryFixture([lib()]) },
    });
    await expect(
      updateProject({
        root,
        registryOptions: {
          transport: new NpmRegistryFixture([
            { ...lib(), distTags: { latest: '1.0.0' } },
          ]),
        },
      }),
    ).rejects.toMatchObject({
      code: 'UNRESOLVABLE',
      message: 'pkg:npm/lib has no dist-tag "next"',
    });
  });
});

describe("what opm.toml's version asks of the registry", () => {
  it('is a tag or a range to resolve where the ecosystem has a codec', () => {
    expect(registryHintFor('npm', 'next')).toBe('next');
    expect(registryHintFor('npm', '^1.0.0')).toBe('^1.0.0');
    expect(registryHintFor('npm', '1.0.0')).toBeUndefined();
    expect(isPinnedVersion('npm', '1.0.0')).toBe(true);
    expect(isPinnedVersion('npm', 'latest')).toBe(false);
    expect(isPinnedVersion('npm', '1.2.x')).toBe(false);
  });

  it('is passed to an adapter with no codec as written', () => {
    // A catalog-only plugin: nothing in opm can read a range or a tag for it.
    expect(registryHintFor('no-codec-here', 'next')).toBeUndefined();
    expect(registryHintFor('no-codec-here', '1.0.0')).toBeUndefined();
    expect(isPinnedVersion('no-codec-here', '1.0.0')).toBe(true);
  });
});
