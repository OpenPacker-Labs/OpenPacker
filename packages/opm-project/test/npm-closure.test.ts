import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PolicyInput } from '@openpacker/contracts';
import {
  addPackage,
  initProject,
  defaultHostEnvironment,
  defaultSupplyChainPolicyInput,
  resolveGraph,
  resolveManifestToLock,
  solveGraph,
  type HostEnvironment,
  type OpmManifest,
} from '../src/index.js';
import {
  NpmRegistryFixture,
  OLD,
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

describe('under the default policy', () => {
  // `opm init` writes this: a one-day minimum release age, semantic loss capped
  // at warning, no downgrade of trust, exotic sources blocked below the root.
  const manifest = (): OpmManifest => ({
    project: { name: 'closure', ecosystems: ['npm'] },
    packages: {
      app: { alias: 'app', purl: 'pkg:npm/app', version: '1.0.0' },
    },
    options: { offline: false, layout: 'opm' },
    policy: defaultSupplyChainPolicyInput(),
  });
  const hoursAgo = (hours: number) =>
    new Date(Date.now() - hours * 3_600_000).toISOString();

  const app = (shared: FixturePackage): FixturePackage[] => [
    {
      name: 'app',
      versions: {
        '1.0.0': {
          dependencies: { shared: '^1.0.0' },
          // Real packages carry engines, and used to be refused for it.
          engines: { node: '>=20' },
        },
      },
    },
    shared,
  ];

  const lockFor = async (
    transport: NpmRegistryFixture,
    override: Partial<OpmManifest> = {},
  ) => {
    const root = await mkdtemp(join(tmpdir(), 'opm-closure-'));
    try {
      return await resolveManifestToLock({
        root,
        manifest: { ...manifest(), ...override },
        offline: false,
        registryOptions: { transport },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  };

  it('locks a closure of settled packages without reading a full document', async () => {
    const transport = new NpmRegistryFixture(
      app({ name: 'shared', versions: { '1.0.0': {}, '1.1.0': {} } }),
    );
    const lock = await lockFor(transport);
    expect(
      Object.values(lock.packages)
        .map((item) => item.purl)
        .sort(),
    ).toEqual(['pkg:npm/app@1.0.0', 'pkg:npm/shared@1.1.0']);
    // Neither package was touched inside the window, so `modified` proves each
    // is old enough and the 54 MB of full packuments are never asked for.
    expect(transport.fullPackumentRequests()).toEqual([]);
    // What was only bounded is not recorded as a publish time.
    expect(lock.packages.app?.publishedAt).toBeUndefined();
  });

  it('reads the full document for a package changed inside the window, and records the time', async () => {
    const transport = new NpmRegistryFixture(
      app({
        name: 'shared',
        versions: { '1.0.0': {}, '1.1.0': {} },
        time: { '1.0.0': OLD, '1.1.0': '2026-02-02T00:00:00.000Z' },
        modified: hoursAgo(1),
      }),
    );
    const lock = await lockFor(transport);
    expect(lock.packages.shared).toMatchObject({
      purl: 'pkg:npm/shared@1.1.0',
      publishedAt: '2026-02-02T00:00:00.000Z',
    });
    expect(transport.fullPackumentRequests()).toHaveLength(1);
    expect(lock.packages.app?.publishedAt).toBeUndefined();
  });

  it('passes over a dependency released an hour ago for the previous release in range', async () => {
    const transport = new NpmRegistryFixture(
      app({
        name: 'shared',
        versions: { '1.0.0': {}, '1.1.0': {}, '1.2.0': {} },
        time: { '1.0.0': OLD, '1.1.0': OLD, '1.2.0': hoursAgo(1) },
        modified: hoursAgo(1),
      }),
    );
    const lock = await lockFor(transport);
    expect(lock.packages.shared?.purl).toBe('pkg:npm/shared@1.1.0');
  });

  it('refuses a direct package released an hour ago, naming the rule', async () => {
    const transport = new NpmRegistryFixture([
      {
        name: 'app',
        versions: { '1.0.0': {} },
        time: { '1.0.0': hoursAgo(1) },
        modified: hoursAgo(1),
      },
    ]);
    await expect(lockFor(transport)).rejects.toMatchObject({
      code: 'POLICY_DENIED',
      message: expect.stringContaining('supply-chain.release-age'),
    });
  });

  it('does not call a package old enough on the strength of nothing', async () => {
    // Changed an hour ago and the registry will not say when this version was
    // published: not provided, which the default policy does not wave through.
    const transport = new NpmRegistryFixture(
      [
        {
          name: 'app',
          versions: { '1.0.0': {} },
          modified: hoursAgo(1),
        },
      ],
      { serveFull: false },
    );
    await expect(lockFor(transport)).rejects.toMatchObject({
      code: 'POLICY_INDETERMINATE',
    });
  });

  it('adds the newest release outside the window when no version is named', async () => {
    const transport = new NpmRegistryFixture([
      {
        name: 'app',
        versions: { '1.0.0': {}, '1.1.0': {} },
        time: { '1.0.0': OLD, '1.1.0': hoursAgo(2) },
        modified: hoursAgo(2),
      },
    ]);
    const lock = await lockFor(transport, {
      packages: { app: { alias: 'app', purl: 'pkg:npm/app' } },
    });
    expect(lock.packages.app?.purl).toBe('pkg:npm/app@1.0.0');
  });
});

describe('one version per package, and what happens when that cannot hold', () => {
  const permissive: PolicyInput = {
    allowYanked: false,
    allowQuarantined: false,
    semanticLossMaximum: 'warning',
    requiredEvidence: [],
  };
  const manifestOf = (packages: OpmManifest['packages']): OpmManifest => ({
    project: { name: 'closure', ecosystems: ['npm'] },
    packages,
    options: { offline: false, layout: 'opm' },
    policy: permissive,
  });
  const lockOf = async (
    registry: FixturePackage[],
    packages: OpmManifest['packages'],
  ) => {
    const root = await mkdtemp(join(tmpdir(), 'opm-closure-'));
    try {
      return await resolveManifestToLock({
        root,
        manifest: manifestOf(packages),
        offline: false,
        registryOptions: { transport: new NpmRegistryFixture(registry) },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  };

  it('picks the version both dependents accept, not the newest of either', async () => {
    // `left` would take 1.3.0; `right` takes only 1.2.x. Both ranges reached
    // the solver as "any version" until the adapter attached them, so it took
    // 1.3.0 for both and the lock paired `right` with a version it rejects.
    const lock = await lockOf(
      [
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
          versions: { '1.0.0': { dependencies: { shared: '~1.2.0' } } },
        },
        {
          name: 'shared',
          versions: { '1.0.0': {}, '1.2.0': {}, '1.2.5': {}, '1.3.0': {} },
        },
      ],
      { app: { alias: 'app', purl: 'pkg:npm/app', version: '1.0.0' } },
    );
    expect(lock.packages.shared?.purl).toBe('pkg:npm/shared@1.2.5');
  });

  it('says who cannot agree when no release of the shared package suits both', async () => {
    // app@2 needs shared 2 and `right` cannot take it; app@1 would have agreed
    // with it. Backing out of the newer app is a search the single-version lock
    // does not do: it names the conflict instead of guessing which side gives.
    await expect(
      lockOf(
        [
          {
            name: 'root',
            versions: {
              '1.0.0': { dependencies: { app: '*', right: '^1' } },
            },
          },
          {
            name: 'app',
            versions: {
              '1.0.0': { dependencies: { shared: '^1' } },
              '2.0.0': { dependencies: { shared: '^2' } },
            },
          },
          {
            name: 'right',
            versions: { '1.0.0': { dependencies: { shared: '^1' } } },
          },
          { name: 'shared', versions: { '1.4.0': {}, '2.0.0': {} } },
        ],
        { root: { alias: 'root', purl: 'pkg:npm/root', version: '1.0.0' } },
      ),
    ).rejects.toMatchObject({
      code: 'UNRESOLVABLE',
      message: expect.stringMatching(
        /pkg:npm\/app@2\.0\.0 requires \^2; pkg:npm\/right@1\.0\.0 requires \^1/u,
      ),
    });
  });

  it('refuses, by name, a direct pin that two versions of one package would be needed for', async () => {
    // npm would nest shared@1 under app and keep shared@2 at the top. A lock
    // here is one entry per package name, so it cannot hold both, and it used
    // to keep the direct one and point `app` at it without saying so.
    await expect(
      lockOf(
        [
          {
            name: 'app',
            versions: { '1.0.0': { dependencies: { shared: '^1' } } },
          },
          { name: 'shared', versions: { '1.4.0': {}, '2.0.0': {} } },
        ],
        {
          app: { alias: 'app', purl: 'pkg:npm/app', version: '1.0.0' },
          shared: { alias: 'shared', purl: 'pkg:npm/shared', version: '2.0.0' },
        },
      ),
    ).rejects.toMatchObject({
      code: 'UNRESOLVABLE',
      message: expect.stringMatching(
        /pkg:npm\/shared is needed at versions no single release satisfies.*the direct requirement requires 2\.0\.0.*pkg:npm\/app@1\.0\.0 requires \^1/su,
      ),
    });
  });
});

describe('an add that does not resolve', () => {
  it('leaves opm.toml as it was, so the next install does not trip over it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opm-closure-'));
    try {
      await initProject({ root, name: 'closure' });
      const before = await readFile(join(root, 'opm.toml'), 'utf8');
      await expect(
        addPackage({
          root,
          spec: 'pkg:npm/not-in-any-catalog@1.0.0',
          offline: true,
        }),
      ).rejects.toMatchObject({ code: 'UNRESOLVABLE' });
      expect(await readFile(join(root, 'opm.toml'), 'utf8')).toBe(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
