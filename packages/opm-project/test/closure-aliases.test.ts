import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { configureDefaultAdapters } from '@openpacker/adapters-default';
import type { PolicyInput } from '@openpacker/contracts';
import {
  defaultHostEnvironment,
  installFromLock,
  projectNativeFormats,
  resolveGraph,
  solveGraph,
} from '../src/index.js';
import { direct, lockOf, permissive } from './closure-support.js';
import {
  NpmRegistryFixture,
  OLD,
  type FixturePackage,
} from './npm-registry-fixture.js';

configureDefaultAdapters();

/**
 * `npm:` aliases in a closure (ADR 0054): `"string-width-cjs":
 * "npm:string-width@^4.2.0"` is the registry's string-width, installed in a
 * directory called string-width-cjs, resolved and checked as string-width.
 */

/** @isaacs/cliui, as it is: the plain names and their `-cjs` aliases. */
const cliui = (): FixturePackage[] => [
  {
    name: 'cliui',
    versions: {
      '8.0.2': {
        dependencies: {
          'string-width': '^5.1.2',
          'string-width-cjs': 'npm:string-width@^4.2.0',
          'strip-ansi': '^7.0.1',
          'strip-ansi-cjs': 'npm:strip-ansi@^6.0.1',
        },
        files: {
          'index.js':
            "module.exports = { plain: require('string-width').version, cjs: require('string-width-cjs').version, cjsName: require('string-width-cjs/package.json').name, cjsInner: require('string-width-cjs').inner, strip: require('strip-ansi-cjs').version };\n",
        },
      },
    },
  },
  {
    name: 'string-width',
    versions: {
      '4.2.3': {
        dependencies: { 'strip-ansi': '^6.0.1' },
        files: {
          'index.js':
            "module.exports = { version: '4.2.3', inner: require('strip-ansi').version };\n",
        },
      },
      '5.1.2': {
        dependencies: { 'strip-ansi': '^7.0.1' },
        files: {},
      },
    },
  },
  {
    name: 'strip-ansi',
    versions: { '6.0.1': { files: {} }, '7.1.0': { files: {} } },
  },
];

describe('the aliases of @isaacs/cliui', () => {
  it('locks each target as the package it is, beside the unaliased version', async () => {
    const { lock } = await lockOf(cliui(), direct('cliui', '8.0.2'));
    expect(Object.keys(lock.packages).sort()).toEqual([
      'cliui',
      'string-width.4.2.3',
      'string-width.5.1.2',
      'strip-ansi.6.0.1',
      'strip-ansi.7.1.0',
    ]);
    expect(lock.packages.cliui).toMatchObject({
      dependencies: ['string-width.5.1.2', 'strip-ansi.7.1.0'],
      aliases: {
        'string-width-cjs': 'string-width.4.2.3',
        'strip-ansi-cjs': 'strip-ansi.6.0.1',
      },
    });
    // The entries are the real packages: their purl, digest and source are the
    // target's, and nothing in them says "cjs".
    expect(lock.packages['string-width.4.2.3']).toMatchObject({
      purl: 'pkg:npm/string-width@4.2.3',
      reason: 'transitive',
      dependencies: ['strip-ansi.6.0.1'],
    });
    expect(lock.packages['string-width.4.2.3']?.aliases).toBeUndefined();
    expect(lock.packages['string-width.4.2.3']?.source).toContain(
      '/string-width/-/string-width-4.2.3.tgz',
    );
  });

  it('installs under the alias, runs, and keeps the package its own name', async () => {
    const { lock, root, manifest } = await lockOf(
      cliui(),
      direct('cliui', '8.0.2'),
    );
    await installFromLock({
      root,
      lock,
      offline: false,
      policy: manifest.policy!,
    });
    await projectNativeFormats({ root, manifest, lock });
    const modules = join(root, 'node_modules');
    expect(
      (await readdir(modules)).filter((name) => !name.startsWith('.')).sort(),
    ).toEqual([
      'cliui',
      'string-width',
      'string-width-cjs',
      'strip-ansi',
      'strip-ansi-cjs',
    ]);
    // The alias directory holds string-width@4.2.3 and says so.
    expect(
      JSON.parse(
        await readFile(
          join(modules, 'string-width-cjs', 'package.json'),
          'utf8',
        ),
      ),
    ).toMatchObject({ name: 'string-width', version: '4.2.3' });
    // string-width@4 needs strip-ansi@6, the alias's, not the root's 7.
    expect(
      JSON.parse(
        await readFile(
          join(
            modules,
            'string-width-cjs',
            'node_modules',
            'strip-ansi',
            'package.json',
          ),
          'utf8',
        ),
      ).version,
    ).toBe('6.0.1');
    expect(
      JSON.parse(
        execFileSync(
          process.execPath,
          ['-e', "console.log(JSON.stringify(require('cliui')))"],
          { cwd: root, encoding: 'utf8' },
        ),
      ),
    ).toEqual({
      plain: '5.1.2',
      cjs: '4.2.3',
      cjsName: 'string-width',
      cjsInner: '6.0.1',
      strip: '6.0.1',
    });
  });

  it('is the same lock, byte for byte, the next time', async () => {
    const first = await lockOf(cliui(), direct('cliui', '8.0.2'));
    const second = await lockOf(cliui(), direct('cliui', '8.0.2'));
    const { serializeLockfile } = await import('../src/index.js');
    expect(serializeLockfile(second.lock)).toBe(serializeLockfile(first.lock));
  });
});

describe('the forms an alias takes', () => {
  /** `app` depends on `x` as `spec`; the registry has the versions given. */
  const resolved = async (
    spec: string,
    versions: FixturePackage['versions'],
    extra: Partial<FixturePackage> = {},
  ) => {
    const { lock } = await lockOf(
      [
        {
          name: 'app',
          versions: { '1.0.0': { dependencies: { x: spec } } },
        },
        { name: 'target', versions, ...extra },
        { name: '@scope/target', versions, ...extra },
      ],
      direct('app', '1.0.0'),
    );
    return lock;
  };
  const targetVersions = {
    '1.0.0': {},
    '1.5.0': {},
    '2.0.0': {},
    '3.0.0-rc.1': {},
  };

  it('npm:name@range takes the newest release in the range', async () => {
    const lock = await resolved('npm:target@^1', targetVersions);
    expect(lock.packages.app?.aliases).toEqual({ x: 'target' });
    expect(lock.packages.target?.purl).toBe('pkg:npm/target@1.5.0');
  });

  it('npm:@scope/name@range names a scoped target', async () => {
    const lock = await resolved('npm:@scope/target@^2', targetVersions);
    expect(lock.packages.app?.aliases).toEqual({ x: '-40scope-target' });
    expect(lock.packages['-40scope-target']?.purl).toBe(
      'pkg:npm/%40scope/target@2.0.0',
    );
  });

  it('npm:name takes the newest release, and not a prerelease', async () => {
    const lock = await resolved('npm:target', targetVersions);
    expect(lock.packages.target?.purl).toBe('pkg:npm/target@2.0.0');
  });

  it('npm:name@1.5.0 takes exactly that release', async () => {
    const lock = await resolved('npm:target@1.5.0', targetVersions);
    expect(lock.packages.target?.purl).toBe('pkg:npm/target@1.5.0');
  });

  it('npm:name@tag takes the release the dist-tag points at, and locks the version', async () => {
    const lock = await resolved('npm:target@next', targetVersions, {
      distTags: { next: '3.0.0-rc.1' },
    });
    expect(lock.packages.target?.purl).toBe('pkg:npm/target@3.0.0-rc.1');
    expect(JSON.stringify(lock)).not.toContain('"next"');
  });

  it('says which dependent asked for a dist-tag the package does not have', async () => {
    await expect(
      resolved('npm:target@nope', targetVersions, {
        distTags: { next: '3.0.0-rc.1' },
      }),
    ).rejects.toMatchObject({
      code: 'UNRESOLVABLE',
      message: expect.stringMatching(
        /pkg:npm\/target: the package has no dist-tag "nope" \(required by pkg:npm\/app@1\.0\.0\)/u,
      ),
    });
  });

  it('names the dependent and the alias for a range nothing published satisfies', async () => {
    await expect(
      resolved('npm:target@^9', targetVersions),
    ).rejects.toMatchObject({
      code: 'UNRESOLVABLE',
      message: expect.stringMatching(
        /pkg:npm\/target: no published version satisfies \^9 \(required by pkg:npm\/app@1\.0\.0\)/u,
      ),
    });
  });

  it('is not read as the registry package of the install name', async () => {
    // A registry package called `x` exists, and is a trap.
    const { lock } = await lockOf(
      [
        {
          name: 'app',
          versions: { '1.0.0': { dependencies: { x: 'npm:target@^1' } } },
        },
        { name: 'target', versions: { '1.0.0': {} } },
        { name: 'x', versions: { '9.9.9': {} } },
      ],
      direct('app', '1.0.0'),
    );
    expect(
      Object.values(lock.packages)
        .map((item) => item.purl)
        .sort(),
    ).toEqual(['pkg:npm/app@1.0.0', 'pkg:npm/target@1.0.0']);
  });

  it('keeps one release under two names when two dependents ask for it', async () => {
    const { lock } = await lockOf(
      [
        {
          name: 'app',
          versions: {
            '1.0.0': {
              dependencies: { a: 'npm:target@^1', b: 'npm:target@^1' },
            },
          },
        },
        { name: 'target', versions: { '1.0.0': {} } },
      ],
      direct('app', '1.0.0'),
    );
    expect(Object.keys(lock.packages).sort()).toEqual(['app', 'target']);
    expect(lock.packages.app?.aliases).toEqual({ a: 'target', b: 'target' });
  });
});

describe('an alias in optionalDependencies, where the platform builds of a native package are', () => {
  const host = (os: string, architecture: string) =>
    defaultHostEnvironment({
      nativeTarget: { os, architecture, libc: 'glibc' },
    });
  const registry = () =>
    new NpmRegistryFixture([
      {
        name: 'codex',
        versions: {
          '1.0.0': {
            optionalDependencies: {
              'codex-linux-x64': 'npm:platform@1.0.0-linux-x64',
              'codex-darwin-arm64': 'npm:platform@1.0.0-darwin-arm64',
            },
          },
        },
      },
      {
        name: 'platform',
        versions: {
          '1.0.0-linux-x64': { os: ['linux'], cpu: ['x64'] },
          '1.0.0-darwin-arm64': { os: ['darwin'], cpu: ['arm64'] },
        },
      },
    ]);

  it.each([
    ['linux', 'x64', '1.0.0-linux-x64', 'codex-linux-x64'],
    ['darwin', 'arm64', '1.0.0-darwin-arm64', 'codex-darwin-arm64'],
  ])(
    'installs the build that runs on %s %s and none of the others',
    async (os, cpu, version) => {
      const graph = await resolveGraph({
        roots: [{ purl: 'pkg:npm/codex' }],
        options: { transport: registry() },
        host: host(os, cpu),
      });
      const solved = await solveGraph({
        graph,
        rootRequirements: [{ purl: 'pkg:npm/codex' }],
      });
      expect(
        solved.selected.map((item) => item.identity.exactPurl).sort(),
      ).toEqual(['pkg:npm/codex@1.0.0', `pkg:npm/platform@${version}`]);
      expect(solved.dependencyEdges).toEqual([
        expect.objectContaining({
          installName: expect.stringMatching(/^codex-/u),
        }),
      ]);
    },
  );
});

describe('policy applies to the real package, not to its alias', () => {
  const hoursAgo = (hours: number) =>
    new Date(Date.now() - hours * 3_600_000).toISOString();
  const window: PolicyInput = { ...permissive, minimumReleaseAgeMinutes: 1440 };

  it('passes over a release inside the minimum age for the previous one in range', async () => {
    const { lock } = await lockOf(
      [
        {
          name: 'app',
          versions: { '1.0.0': { dependencies: { x: 'npm:fresh@^1' } } },
        },
        {
          name: 'fresh',
          versions: { '1.0.0': {}, '1.1.0': {} },
          time: { '1.0.0': OLD, '1.1.0': hoursAgo(2) },
          modified: hoursAgo(2),
        },
      ],
      direct('app', '1.0.0'),
      window,
    );
    expect(lock.packages.fresh?.purl).toBe('pkg:npm/fresh@1.0.0');
  });

  it('says what the policy set aside when an alias asks for exactly a release inside the window', async () => {
    await expect(
      lockOf(
        [
          {
            name: 'app',
            versions: { '1.0.0': { dependencies: { x: 'npm:fresh@1.1.0' } } },
          },
          {
            name: 'fresh',
            versions: { '1.1.0': {} },
            time: { '1.1.0': hoursAgo(2) },
            modified: hoursAgo(2),
          },
        ],
        direct('app', '1.0.0'),
        window,
      ),
    ).rejects.toMatchObject({
      code: 'UNRESOLVABLE',
      message: expect.stringMatching(
        /pkg:npm\/app@1\.0\.0 requires pkg:npm\/fresh 1\.1\.0 \(as x\), and no such release can be installed.*What the policy set aside:\n  - pkg:npm\/fresh@1\.1\.0: published inside the 1440-minute minimum release age \(required by pkg:npm\/app@1\.0\.0\)/su,
      ),
    });
  });

  it('refuses a target whose publish time nobody will give, naming the package, the dependent and the alias', async () => {
    await expect(
      lockOf(
        [
          {
            name: 'app',
            versions: { '1.0.0': { dependencies: { x: 'npm:fresh@1.1.0' } } },
          },
          {
            name: 'fresh',
            versions: { '1.1.0': {} },
            modified: hoursAgo(2),
          },
        ],
        direct('app', '1.0.0'),
        window,
        { serveFull: false },
      ),
    ).rejects.toMatchObject({
      code: 'POLICY_INDETERMINATE',
      message: expect.stringContaining(
        'pkg:npm/fresh@1.1.0 is required by pkg:npm/app@1.0.0 as x',
      ),
    });
  });
});

describe('a dependency the package bundles', () => {
  it('is not resolved, and not asked for', async () => {
    const { lock, fixture } = await lockOf(
      [
        {
          name: 'outer',
          versions: {
            '1.0.0': {
              dependencies: {
                inner: '^1',
                'inner-cjs': 'npm:inner@^1',
                free: '^1',
              },
              bundleDependencies: ['inner', 'inner-cjs'],
            },
          },
        },
        { name: 'free', versions: { '1.0.0': {} } },
        // `inner` is not in the registry at all: a walk that asked for it fails.
      ],
      direct('outer', '1.0.0'),
    );
    expect(Object.keys(lock.packages).sort()).toEqual(['free', 'outer']);
    expect(fixture.packumentRequests('inner')).toBe(0);
    expect(lock.packages.outer?.aliases).toBeUndefined();
  });
});
