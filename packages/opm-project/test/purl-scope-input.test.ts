import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { configureDefaultAdapters } from '@openpacker/adapters-default';
import {
  addPackage,
  initProject,
  listRegistryVersions,
  projectPaths,
  readManifestFile,
  removePackage,
  resolveRegistryArtifact,
  searchRegistry,
  whyPackage,
  writeManifestFile,
} from '../src/index.js';
import { permissive } from './closure-support.js';
import {
  NpmRegistryFixture,
  type FixturePackage,
} from './npm-registry-fixture.js';

configureDefaultAdapters();

/**
 * `opm versions pkg:npm/@vercel/sdk` said "PURL path has an empty segment";
 * only `pkg:npm/%40vercel/sdk` worked. Every command that reads a PURL takes
 * either spelling, and what opm writes is the encoded one.
 */

const registry = (): FixturePackage[] => [
  { name: '@scope/tool', versions: { '1.0.0': {}, '1.1.0': {} } },
];

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function projectWithTool(spec: string) {
  const root = await mkdtemp(join(tmpdir(), 'opm-purl-scope-'));
  roots.push(root);
  await initProject({ root, name: 'scopes' });
  const paths = projectPaths(root);
  const manifest = await readManifestFile(paths.manifest);
  manifest.project.ecosystems = ['npm'];
  manifest.policy = permissive;
  await writeManifestFile(paths.manifest, manifest);
  await addPackage({
    root,
    spec,
    registryOptions: { transport: new NpmRegistryFixture(registry()) },
  });
  return { root, paths };
}

describe('an npm scope typed with a literal @', () => {
  const transport = () => ({ transport: new NpmRegistryFixture(registry()) });

  it('lists versions', async () => {
    expect(
      await listRegistryVersions('npm', 'pkg:npm/@scope/tool', transport()),
    ).toEqual(['pkg:npm/%40scope/tool@1.0.0', 'pkg:npm/%40scope/tool@1.1.0']);
  });

  it('describes a release', async () => {
    const artifact = await resolveRegistryArtifact(
      'npm',
      'pkg:npm/@scope/tool@1.0.0',
      transport(),
    );
    expect(artifact.exactPurl).toBe('pkg:npm/%40scope/tool@1.0.0');
  });

  it('is searched for', async () => {
    const found = await searchRegistry(
      'npm',
      'pkg:npm/@scope/tool',
      transport(),
    );
    expect(found.map((item) => item.canonicalPurl)).toEqual([
      'pkg:npm/%40scope/tool',
    ]);
  });

  it('locks what the encoded spelling locks, encoded', async () => {
    const literal = await projectWithTool('pkg:npm/@scope/tool');
    const encoded = await projectWithTool('pkg:npm/%40scope/tool');
    // opm.toml keeps the spelling typed, as it always has, so only the digest
    // of it differs.
    const lockOf = async (root: string) =>
      (await readFile(join(root, 'opm.lock.json'), 'utf8')).replace(
        /"manifestDigest": "[^"]*"/u,
        '',
      );
    const lock = await lockOf(literal.root);
    expect(lock).toBe(await lockOf(encoded.root));
    expect(lock).toContain('"purl": "pkg:npm/%40scope/tool@1.1.0"');
    expect(lock).not.toContain('pkg:npm/@');
  });

  it('is explained by opm why, in either spelling, with or without a version', async () => {
    const { root } = await projectWithTool('pkg:npm/@scope/tool');
    const byAlias = await whyPackage(root, 'tool');
    expect(await whyPackage(root, 'pkg:npm/@scope/tool')).toBe(byAlias);
    expect(await whyPackage(root, 'pkg:npm/%40scope/tool')).toBe(byAlias);
    expect(await whyPackage(root, 'pkg:npm/@scope/tool@1.1.0')).toBe(byAlias);
    await expect(
      whyPackage(root, 'pkg:npm/@scope/tool@1.0.0'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('is removed by opm remove', async () => {
    const { root, paths } = await projectWithTool('pkg:npm/%40scope/tool');
    const removed = await removePackage({ root, alias: 'pkg:npm/@scope/tool' });
    expect(removed.alias).toBe('tool');
    expect((await readManifestFile(paths.manifest)).packages).toEqual({});
  });
});
