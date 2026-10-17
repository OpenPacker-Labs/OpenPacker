import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { configureDefaultAdapters } from '@openpacker/adapters-default';
import {
  addPackage,
  defaultSupplyChainPolicyInput,
  fetchTool,
  initProject,
  projectPaths,
  readManifestFile,
  updateProject,
  writeManifestFile,
} from '../src/index.js';
import { defaultReleaseOrder } from '../src/default-release.js';
import { permissive } from './closure-support.js';
import {
  NpmRegistryFixture,
  type FixturePackage,
} from './npm-registry-fixture.js';

configureDefaultAdapters();

/**
 * A requirement that names no version means the registry's `latest`, else its
 * newest release that is not a prerelease, as npm and pnpm read a bare name.
 * `opm add pkg:npm/@vercel/sdk` used to lock 14.0.0-canary.9 while `latest`
 * was 1.28.43, and `opm add pkg:npm/luxon` 3.8.0-alpha.1 over 3.7.2.
 */

const canaries = (from: number, count: number) =>
  Object.fromEntries(
    Array.from({ length: count }, (_, index) => [
      `2.0.0-canary.${from + index}`,
      {},
    ]),
  );

/** `latest` behind eight canaries: more than the walk's six candidates. */
const sdk = (distTags: FixturePackage['distTags']): FixturePackage[] => [
  {
    name: 'sdk',
    versions: {
      '1.0.0': {},
      '1.1.0': {},
      '1.2.0': {},
      ...canaries(0, 8),
    },
    distTags,
  },
];

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function project(policy = permissive): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'opm-default-release-'));
  roots.push(root);
  await initProject({ root, name: 'default-release' });
  const paths = projectPaths(root);
  const manifest = await readManifestFile(paths.manifest);
  manifest.project.ecosystems = ['npm'];
  manifest.policy = policy;
  await writeManifestFile(paths.manifest, manifest);
  return root;
}

const addSdk = async (registry: FixturePackage[], root?: string) => {
  const added = await addPackage({
    root: root ?? (await project()),
    spec: 'pkg:npm/sdk',
    registryOptions: { transport: new NpmRegistryFixture(registry) },
  });
  return added.lock.packages.sdk?.purl;
};

describe('the release a requirement with no version means', () => {
  const order = (versions: string[], latest?: string) =>
    defaultReleaseOrder({ ecosystem: 'npm', versions, latest });

  it('is the latest dist-tag, then the releases before it', () => {
    expect(
      order(['1.0.0', '1.1.0', '2.0.0-canary.1', '2.0.0-canary.2'], '1.1.0'),
    ).toEqual(['1.1.0', '1.0.0']);
  });

  it('never takes a release newer than latest, prerelease or not', () => {
    expect(order(['1.0.0', '1.1.0', '2.0.0'], '1.1.0')).toEqual([
      '1.1.0',
      '1.0.0',
    ]);
  });

  it('is latest even when latest is a prerelease', () => {
    expect(order(['1.0.0-rc.1', '1.0.0-rc.2'], '1.0.0-rc.1')).toEqual([
      '1.0.0-rc.1',
    ]);
  });

  it('without latest, is the newest release that is not a prerelease', () => {
    expect(order(['1.0.0', '1.1.0', '3.8.0-alpha.1'])).toEqual([
      '1.1.0',
      '1.0.0',
    ]);
  });

  it('falls back to prereleases only when nothing else was published', () => {
    expect(order(['0.1.0-beta.1', '0.1.0-beta.2'])).toEqual([
      '0.1.0-beta.2',
      '0.1.0-beta.1',
    ]);
  });

  it('keeps the registry order where the ecosystem has no codec', () => {
    // A plugin adapter may ship a catalog and no codec: nothing can say what a
    // prerelease is there, so the registry's order stands, as it did.
    const plain = (versions: string[], latest?: string) =>
      defaultReleaseOrder({ ecosystem: 'no-codec-here', versions, latest });
    expect(plain(['1.0.0', '2.0.0-rc.1'])).toEqual(['2.0.0-rc.1', '1.0.0']);
    expect(plain(['a', 'b', 'c'], 'b')).toEqual(['b', 'a']);
  });

  it('reads prereleases by the ecosystem, not by npm', () => {
    expect(
      defaultReleaseOrder({
        ecosystem: 'pypi',
        versions: ['1.0', '1.1', '2.0a1', '2.0rc1'],
      }),
    ).toEqual(['1.1', '1.0']);
  });
});

describe('opm add with no version', () => {
  it('locks the latest dist-tag, not a newer canary', async () => {
    expect(await addSdk(sdk({ latest: '1.1.0' }))).toBe('pkg:npm/sdk@1.1.0');
  });

  it('locks the newest non-prerelease when the registry has no latest', async () => {
    expect(await addSdk(sdk({ latest: undefined }))).toBe('pkg:npm/sdk@1.2.0');
  });

  it('locks the newest prerelease when nothing else was published', async () => {
    const registry: FixturePackage[] = [
      {
        name: 'sdk',
        versions: canaries(0, 3),
        distTags: { latest: undefined },
      },
    ];
    expect(await addSdk(registry)).toBe('pkg:npm/sdk@2.0.0-canary.2');
  });

  it('passes over a latest inside the minimum release age for the release before it', async () => {
    const recent = new Date(Date.now() - 3_600_000).toISOString();
    const registry = sdk({ latest: '1.2.0' });
    registry[0]!.time = { '1.2.0': recent };
    registry[0]!.modified = recent;
    const root = await project(defaultSupplyChainPolicyInput());
    expect(await addSdk(registry, root)).toBe('pkg:npm/sdk@1.1.0');
  });
});

describe('opm update --latest', () => {
  it('moves to the latest dist-tag by the same rule as add', async () => {
    const root = await project();
    const old = sdk({ latest: '1.0.0' });
    await addPackage({
      root,
      spec: 'pkg:npm/sdk@1.0.0',
      registryOptions: { transport: new NpmRegistryFixture(old) },
    });
    const updated = await updateProject({
      root,
      aliases: ['sdk'],
      latest: true,
      registryOptions: {
        transport: new NpmRegistryFixture(sdk({ latest: '1.2.0' })),
      },
    });
    expect(updated.lock.packages.sdk?.purl).toBe('pkg:npm/sdk@1.2.0');
    expect(updated.manifest.packages.sdk?.version).toBe('1.2.0');
  });
});

describe('opmx with no version', () => {
  it('runs what opm add would lock', async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), 'opm-default-release-x-'));
    roots.push(cacheRoot);
    const tool = await fetchTool({
      purl: 'pkg:npm/sdk',
      cacheRoot,
      registryOptions: {
        transport: new NpmRegistryFixture(sdk({ latest: '1.1.0' }), {
          abbreviatedTime: true,
        }),
      },
    });
    expect(tool.exactPurl).toBe('pkg:npm/sdk@1.1.0');
  });
});
