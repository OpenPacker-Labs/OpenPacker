/**
 * Which locked package would provide an executable, from the manifest and the
 * lock alone. The lock is written by hand here: `opm exec` asks this about a
 * project whose `node_modules` is absent, so nothing needs installing.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  emptyLockfile,
  findBinProviders,
  initProject,
  writeLockfile,
  type LockPackage,
} from '../src/index.js';

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function entry(
  alias: string,
  purl: string,
  reason: 'direct' | 'transitive',
  bins: string[] = [],
): LockPackage {
  return {
    alias,
    purl,
    version: purl.slice(purl.lastIndexOf('@') + 1),
    digest: `sha256:${'0'.repeat(64)}`,
    size: 1,
    format: 'tar+gzip',
    mediaType: 'application/gzip',
    source: 'file:/dev/null',
    storeKey: alias,
    bins: bins.map((name) => ({ name, path: `package/${name}.js` })),
    reason,
    ecosystem: 'npm',
  };
}

async function project(
  packages: LockPackage[],
  options?: { projection?: string },
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'opm-bin-providers-'));
  temps.push(root);
  await initProject({ root, name: 'providers' });
  if (options?.projection !== undefined) {
    const manifest = await readFile(join(root, 'opm.toml'), 'utf8');
    await writeFile(
      join(root, 'opm.toml'),
      manifest.replace(
        'layout = "opm"',
        `layout = "opm"\nnative_projection = "${options.projection}"`,
      ),
    );
  }
  const lock = emptyLockfile();
  for (const locked of packages) lock.packages[locked.alias] = locked;
  await writeLockfile(join(root, 'opm.lock.json'), lock);
  return root;
}

describe('findBinProviders', () => {
  it('names a package whose lock entry declares the bin', async () => {
    const root = await project([
      entry('vitest', 'pkg:npm/vitest@4.1.9', 'direct', ['vitest']),
    ]);
    expect(await findBinProviders(root, 'vitest')).toEqual({
      locked: true,
      projection: 'manifest',
      providers: [
        {
          alias: 'vitest',
          purl: 'pkg:npm/vitest@4.1.9',
          direct: true,
          evidence: 'declared',
        },
      ],
    });
  });

  it('finds a bin declared under a name that is not the package name', async () => {
    const root = await project([
      entry('typescript', 'pkg:npm/typescript@5.9.2', 'direct', [
        'tsc',
        'tsserver',
      ]),
    ]);
    const report = await findBinProviders(root, 'tsserver');
    expect(report.providers.map((provider) => provider.alias)).toEqual([
      'typescript',
    ]);
  });

  it('falls back to the package name for a dependency whose bins the lock does not record', async () => {
    const root = await project([
      entry('vite', 'pkg:npm/vite@8.0.1', 'transitive'),
      entry('-40scope-nanoid', 'pkg:npm/%40scope/nanoid@5.0.0', 'transitive'),
    ]);
    expect((await findBinProviders(root, 'vite')).providers).toEqual([
      {
        alias: 'vite',
        purl: 'pkg:npm/vite@8.0.1',
        direct: false,
        evidence: 'named',
      },
    ]);
    // npm's default bin of @scope/nanoid is "nanoid".
    expect((await findBinProviders(root, 'nanoid')).providers).toHaveLength(1);
  });

  it('does not guess from the name when the entry records its bins', async () => {
    const root = await project([
      entry('rolldown', 'pkg:npm/rolldown@1.0.0', 'direct', ['other']),
    ]);
    expect((await findBinProviders(root, 'rolldown')).providers).toEqual([]);
  });

  it('puts declared evidence first, then direct requirements, then by alias', async () => {
    const root = await project([
      entry('zzz', 'pkg:npm/zzz@1.0.0', 'transitive', ['tool']),
      entry('aaa', 'pkg:npm/aaa@1.0.0', 'transitive', ['tool']),
      entry('tool', 'pkg:npm/tool@1.0.0', 'direct'),
      entry('mid', 'pkg:npm/mid@1.0.0', 'direct', ['tool']),
    ]);
    expect(
      (await findBinProviders(root, 'tool')).providers.map(
        (provider) => provider.alias,
      ),
    ).toEqual(['mid', 'aaa', 'zzz', 'tool']);
  });

  it('reports the projection level the manifest asks for', async () => {
    const root = await project([], { projection: 'layout' });
    expect((await findBinProviders(root, 'x')).projection).toBe('layout');
  });

  it('says nothing when there is no lock, and nothing when there is no project', async () => {
    const bare = await mkdtemp(join(tmpdir(), 'opm-bin-providers-'));
    temps.push(bare);
    expect(await findBinProviders(bare, 'x')).toEqual({
      locked: false,
      projection: undefined,
      providers: [],
    });
    await initProject({ root: bare, name: 'no-lock' });
    await rm(join(bare, 'opm.lock.json'), { force: true });
    expect(await findBinProviders(bare, 'x')).toEqual({
      locked: false,
      projection: 'manifest',
      providers: [],
    });
  });

  it('does not fail on a lock it cannot read', async () => {
    const root = await project([]);
    await writeFile(join(root, 'opm.lock.json'), '{ not json');
    expect(await findBinProviders(root, 'x')).toMatchObject({ locked: false });
  });
});
