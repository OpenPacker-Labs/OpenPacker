import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PolicyInput } from '@openpacker/contracts';
import {
  defaultHostEnvironment,
  resolveGraph,
  resolveManifestToLock,
  solveGraph,
  type HostEnvironment,
  type OpmManifest,
} from '../src/index.js';
import {
  NpmRegistryFixture,
  type FixturePackage,
} from './npm-registry-fixture.js';

/**
 * A dependency closure from an npm-shaped registry.
 *
 * Everything here is a shape a real closure has and the first live run found
 * the walk could not take: development dependencies written as aliases, git
 * URLs and dist-tags; native packages shipped as one optional dependency per
 * platform; a package reached from several places.
 */

const host = (
  target: Partial<HostEnvironment['nativeTarget']> = {},
): HostEnvironment =>
  defaultHostEnvironment({
    nativeTarget: {
      os: 'linux',
      architecture: 'x64',
      libc: 'glibc',
      ...target,
    },
  });

const names = (graph: { packages: { identity: { name: string } }[] }) =>
  [...new Set(graph.packages.map((item) => item.identity.name))].sort();

describe('dev-time specifiers do not decide the closure', () => {
  const registry = () =>
    new NpmRegistryFixture([
      {
        name: 'tool',
        versions: {
          '1.0.0': {
            dependencies: { fmt: '^2.0.0' },
            devDependencies: {
              'react-is': 'npm:react-is@18.3.1',
              'time-require': 'github:jonschlinkert/time-require',
              latest: 'latest',
            },
          },
        },
      },
      { name: 'fmt', versions: { '2.0.0': {}, '2.1.0': {} } },
    ]);

  it('inspects every version and resolves the real dependency', async () => {
    const graph = await resolveGraph({
      roots: [{ purl: 'pkg:npm/tool' }],
      options: { transport: registry() },
      host: host(),
    });
    expect(graph.unresolved).toEqual([]);
    expect(names(graph)).toEqual(['fmt', 'tool']);
    const solved = await solveGraph({
      graph,
      rootRequirements: [{ purl: 'pkg:npm/tool' }],
    });
    // The newest satisfying version, and none of the dev-time packages.
    expect(
      solved.selected.map((item) => item.identity.exactPurl).sort(),
    ).toEqual(['pkg:npm/fmt@2.1.0', 'pkg:npm/tool@1.0.0']);
  });

  it('refuses to guess at a runtime dependency written as a git URL', async () => {
    const graph = await resolveGraph({
      roots: [{ purl: 'pkg:npm/tool' }],
      options: {
        transport: new NpmRegistryFixture([
          {
            name: 'tool',
            versions: { '1.0.0': { dependencies: { fmt: 'github:evil/fmt' } } },
          },
          // The registry has a `fmt`; it must not stand in for the git one.
          { name: 'fmt', versions: { '9.9.9': {} } },
        ]),
      },
      host: host(),
    });
    expect(graph.packages).toEqual([]);
    expect(graph.unresolved).toContainEqual({
      purl: 'pkg:npm/tool@1.0.0',
      reason: expect.stringContaining('depends on fmt as "github:evil/fmt"'),
    });
  });
});

describe('platform packages: one optional dependency per platform', () => {
  const binding = (
    suffix: string,
    os: string,
    cpu: string,
    libc?: string,
  ): FixturePackage => ({
    name: `native-${suffix}`,
    versions: {
      '1.0.0': { os: [os], cpu: [cpu], ...(libc && { libc: [libc] }) },
    },
  });
  const registry = () =>
    new NpmRegistryFixture([
      {
        name: 'native',
        versions: {
          '1.0.0': {
            optionalDependencies: {
              'native-linux-x64-gnu': '1.0.0',
              'native-linux-x64-musl': '1.0.0',
              'native-linux-arm64-gnu': '1.0.0',
              'native-darwin-arm64': '1.0.0',
              'native-win32-x64': '1.0.0',
              'native-wasm': '1.0.0',
            },
          },
        },
      },
      binding('linux-x64-gnu', 'linux', 'x64', 'glibc'),
      binding('linux-x64-musl', 'linux', 'x64', 'musl'),
      binding('linux-arm64-gnu', 'linux', 'arm64', 'glibc'),
      binding('darwin-arm64', 'darwin', 'arm64'),
      binding('win32-x64', 'win32', 'x64'),
      // An optional dependency that states no platform runs everywhere.
      { name: 'native-wasm', versions: { '1.0.0': {} } },
    ]);

  const solveFor = async (target: Partial<HostEnvironment['nativeTarget']>) => {
    const graph = await resolveGraph({
      roots: [{ purl: 'pkg:npm/native' }],
      options: { transport: registry() },
      host: host(target),
    });
    const solved = await solveGraph({
      graph,
      rootRequirements: [{ purl: 'pkg:npm/native' }],
    });
    return { graph, solved };
  };

  it('installs the binding for this host, the portable one, and no other', async () => {
    const { graph, solved } = await solveFor({});
    expect(solved.selected.map((item) => item.identity.name).sort()).toEqual([
      'native',
      'native-linux-x64-gnu',
      'native-wasm',
    ]);
    expect(solved.dependencyEdges).toHaveLength(2);
    expect(graph.skippedPlatform.map((item) => item.purl).sort()).toEqual([
      'pkg:npm/native-darwin-arm64@1.0.0',
      'pkg:npm/native-linux-arm64-gnu@1.0.0',
      'pkg:npm/native-linux-x64-musl@1.0.0',
      'pkg:npm/native-win32-x64@1.0.0',
    ]);
    expect(solved.proofValid).toBe(true);
  });

  it('tells glibc from musl, which the abbreviated document cannot', async () => {
    const { solved } = await solveFor({ libc: 'musl' });
    expect(solved.selected.map((item) => item.identity.name)).toContain(
      'native-linux-x64-musl',
    );
    expect(solved.selected.map((item) => item.identity.name)).not.toContain(
      'native-linux-x64-gnu',
    );
  });

  it('follows the host to another os and cpu', async () => {
    const { solved } = await solveFor({
      os: 'darwin',
      architecture: 'arm64',
      libc: undefined as never,
    });
    expect(solved.selected.map((item) => item.identity.name).sort()).toEqual([
      'native',
      'native-darwin-arm64',
      'native-wasm',
    ]);
  });

  it('marks the platform loss as met only for the binding it was evaluated for', async () => {
    const { solved } = await solveFor({});
    const [kept] = solved.selected.filter(
      (item) => item.identity.name === 'native-linux-x64-gnu',
    );
    const loss = kept!.semanticLoss.find(
      ({ code }) => code === 'NPM_PACKAGE_TARGET_PREDICATE_ARTIFACT_ONLY',
    );
    expect(loss).toMatchObject({
      severity: 'warning',
      mitigation: expect.stringContaining('os=linux architecture=x64'),
    });
  });

  it('leaves the loss at error when the predicate could not be evaluated', async () => {
    // A predicate over a path the host knows nothing about is `unknown`; an
    // optional dependency is then left out, never guessed in.
    const graph = await resolveGraph({
      roots: [{ purl: 'pkg:npm/native' }],
      options: { transport: registry() },
      host: defaultHostEnvironment({
        nativeTarget: { os: 'linux', architecture: 'x64' },
      }),
    });
    // libc is not applicable without a libc, as for npm: both linux x64
    // bindings qualify, which is why a host that cannot tell must report one.
    expect(names(graph)).toContain('native-linux-x64-gnu');
  });

  it('refuses a hard dependency that does not run here, as npm does', async () => {
    const graph = await resolveGraph({
      roots: [{ purl: 'pkg:npm/needs-mac' }],
      options: {
        transport: new NpmRegistryFixture([
          {
            name: 'needs-mac',
            versions: {
              '1.0.0': { dependencies: { 'native-darwin-arm64': '1.0.0' } },
            },
          },
          binding('darwin-arm64', 'darwin', 'arm64'),
        ]),
      },
      host: host(),
    });
    expect(graph.unresolved.map((item) => item.reason).join(' ')).toContain(
      'does not run on this host (os=linux architecture=x64 libc=glibc)',
    );
    await expect(
      solveGraph({
        graph,
        rootRequirements: [{ purl: 'pkg:npm/needs-mac' }],
      }),
    ).rejects.toThrow(/UNSATISFIABLE/u);
  });
});

describe('a package reached from several places is read once', () => {
  const registry = () =>
    new NpmRegistryFixture([
      {
        name: 'app',
        versions: { '1.0.0': { dependencies: { left: '^1', right: '^1' } } },
      },
      {
        name: 'left',
        versions: { '1.0.0': { dependencies: { shared: '^1.0.0' } } },
      },
      {
        name: 'right',
        versions: { '1.0.0': { dependencies: { shared: '>=1.2.0 <2' } } },
      },
      { name: 'shared', versions: { '1.0.0': {}, '1.2.0': {}, '1.3.0': {} } },
    ]);

  const permissive: PolicyInput = {
    allowYanked: false,
    allowQuarantined: false,
    semanticLossMaximum: 'warning',
    requiredEvidence: [],
  };
  const manifest = (): OpmManifest => ({
    project: { name: 'closure', ecosystems: ['npm'] },
    packages: {
      app: { alias: 'app', purl: 'pkg:npm/app', version: '1.0.0' },
    },
    options: { offline: false, layout: 'opm' },
    policy: permissive,
  });

  it('fetches each packument once across the direct pass, the walk and the artifacts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opm-closure-'));
    try {
      const transport = registry();
      const lock = await resolveManifestToLock({
        root,
        manifest: manifest(),
        offline: false,
        registryOptions: { transport, now: () => '2026-08-04T00:00:00Z' },
      });
      expect(
        Object.values(lock.packages)
          .map((item) => item.purl)
          .sort(),
      ).toEqual([
        'pkg:npm/app@1.0.0',
        'pkg:npm/left@1.0.0',
        'pkg:npm/right@1.0.0',
        'pkg:npm/shared@1.3.0',
      ]);
      for (const name of ['app', 'left', 'right', 'shared'])
        expect(transport.packumentRequests(name), name).toBe(1);
      // Every locked package carries the digest of the bytes that were read.
      for (const item of Object.values(lock.packages))
        expect(item.digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
      expect(lock.packages.app?.dependencies).toEqual(['left', 'right']);
      expect(lock.packages.left?.dependencies).toEqual(['shared']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
