import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { NativeTarget } from '@openpacker/adapter-core';
import {
  classifyResolved,
  lockDisagreements,
  planFrozenPackageLock,
} from './frozen-lock.js';
import { readPackageLock } from './lock-tree.js';
import { NpmProjectFormat } from './project.js';

const linuxX64: NativeTarget = {
  os: 'linux',
  architecture: 'x64',
  libc: 'glibc',
};
const darwinArm: NativeTarget = { os: 'darwin', architecture: 'arm64' };

const registry = (
  name: string,
  version: string,
  extra: Record<string, unknown> = {},
) => ({
  version,
  resolved: `https://registry.npmjs.org/${name}/-/${name.split('/').at(-1)}-${version}.tgz`,
  integrity: `sha512-${name.replace(/\W/gu, '')}${version}`,
  ...extra,
});

function tree(
  packages: Record<string, unknown>,
  root: Record<string, unknown> = {},
) {
  return readPackageLock({
    name: 'app',
    version: '1.0.0',
    lockfileVersion: 3,
    packages: { '': { name: 'app', version: '1.0.0', ...root }, ...packages },
  });
}

const plan = (
  lock: ReturnType<typeof tree>,
  target = linuxX64,
  omit: ('dev' | 'optional' | 'peer')[] = [],
) =>
  planFrozenPackageLock({
    tree: lock,
    options: { target, omit: new Set(omit) },
  });
const paths = (result: ReturnType<typeof plan>) =>
  result.packages.map((entry) => entry.path);

describe('which entries a host installs', () => {
  it('installs every path of a package nested in several versions, parents first', () => {
    const result = plan(
      tree(
        {
          'node_modules/b': registry('b', '1.0.0', {
            dependencies: { c: '^2.0.0' },
          }),
          'node_modules/b/node_modules/c': registry('c', '2.0.0'),
          'node_modules/a': registry('a', '1.0.0', {
            dependencies: { c: '^1.0.0' },
          }),
          'node_modules/c': registry('c', '1.0.0'),
        },
        { dependencies: { a: '^1.0.0', b: '^1.0.0' } },
      ),
    );
    expect(paths(result)).toEqual([
      'node_modules/a',
      'node_modules/b',
      'node_modules/c',
      'node_modules/b/node_modules/c',
    ]);
    expect(result.refused).toEqual([]);
    expect(result.packages[3]).toMatchObject({
      name: 'c',
      version: '2.0.0',
      exactPurl: 'pkg:npm/c@2.0.0',
      direct: false,
    });
    expect(result.packages[0]).toMatchObject({
      direct: true,
      scope: 'runtime',
    });
  });

  it('leaves out an optional package that is for another platform', () => {
    const lock = tree(
      {
        'node_modules/esbuild': registry('esbuild', '0.25.0', {
          optionalDependencies: {
            '@esbuild/linux-x64': '0.25.0',
            '@esbuild/darwin-arm64': '0.25.0',
          },
        }),
        'node_modules/@esbuild/linux-x64': registry(
          '@esbuild/linux-x64',
          '0.25.0',
          {
            optional: true,
            os: ['linux'],
            cpu: ['x64'],
          },
        ),
        'node_modules/@esbuild/darwin-arm64': registry(
          '@esbuild/darwin-arm64',
          '0.25.0',
          { optional: true, os: ['darwin'], cpu: ['arm64'] },
        ),
      },
      { dependencies: { esbuild: '^0.25.0' } },
    );
    const here = plan(lock);
    expect(paths(here)).toEqual([
      'node_modules/@esbuild/linux-x64',
      'node_modules/esbuild',
    ]);
    expect(here.skipped).toEqual([
      expect.objectContaining({
        path: 'node_modules/@esbuild/darwin-arm64',
        reason: expect.stringMatching(/optional, and for os darwin cpu arm64/u),
      }),
    ]);
    expect(paths(plan(lock, darwinArm))).toEqual([
      'node_modules/@esbuild/darwin-arm64',
      'node_modules/esbuild',
    ]);
  });

  it('tells glibc from musl', () => {
    const lock = tree(
      {
        'node_modules/x': registry('x', '1.0.0', {
          optionalDependencies: { 'x-gnu': '1', 'x-musl': '1' },
        }),
        'node_modules/x-gnu': registry('x-gnu', '1.0.0', {
          optional: true,
          os: ['linux'],
          libc: ['glibc'],
        }),
        'node_modules/x-musl': registry('x-musl', '1.0.0', {
          optional: true,
          os: ['linux'],
          libc: ['musl'],
        }),
      },
      { dependencies: { x: '1' } },
    );
    expect(paths(plan(lock, linuxX64))).toContain('node_modules/x-gnu');
    expect(paths(plan(lock, linuxX64))).not.toContain('node_modules/x-musl');
    expect(paths(plan(lock, { ...linuxX64, libc: 'musl' }))).toEqual([
      'node_modules/x',
      'node_modules/x-musl',
    ]);
  });

  it('reads negated and "any" lists the way npm does', () => {
    const lock = tree(
      {
        'node_modules/neg': registry('neg', '1.0.0', {
          optional: true,
          os: ['!win32'],
        }),
        'node_modules/negmac': registry('negmac', '1.0.0', {
          optional: true,
          os: ['!linux', '!win32'],
        }),
        'node_modules/any': registry('any', '1.0.0', {
          optional: true,
          os: ['any'],
          cpu: ['any'],
        }),
        'node_modules/mixed': registry('mixed', '1.0.0', {
          optional: true,
          os: ['linux', 'darwin', '!darwin'],
        }),
      },
      {
        optionalDependencies: {
          neg: '1',
          negmac: '1',
          any: '1',
          mixed: '1',
        },
      },
    );
    expect(paths(plan(lock, linuxX64)).sort()).toEqual([
      'node_modules/any',
      'node_modules/mixed',
      'node_modules/neg',
    ]);
    expect(paths(plan(lock, darwinArm)).sort()).toEqual([
      'node_modules/any',
      'node_modules/neg',
      'node_modules/negmac',
    ]);
  });

  it('refuses a platform mismatch on a package that is not optional', () => {
    const result = plan(
      tree(
        {
          'node_modules/mac-only': registry('mac-only', '1.0.0', {
            os: ['darwin'],
          }),
        },
        { dependencies: { 'mac-only': '1' } },
      ),
    );
    expect(result.packages).toEqual([]);
    expect(result.refused).toEqual([
      {
        path: 'node_modules/mac-only',
        reason: expect.stringMatching(
          /mac-only@1\.0\.0 is for os darwin, not this machine \(linux\/x64\/glibc\), and is not optional/u,
        ),
      },
    ]);
  });

  it('drops what only a skipped optional package needs, and keeps what others need', () => {
    const lock = tree(
      {
        'node_modules/host': registry('host', '1.0.0', {
          optionalDependencies: { native: '1' },
          dependencies: { shared: '1' },
        }),
        'node_modules/native': registry('native', '1.0.0', {
          optional: true,
          os: ['darwin'],
          dependencies: { 'native-helper': '1', shared: '1' },
        }),
        'node_modules/native-helper': registry('native-helper', '1.0.0', {
          optional: true,
          dependencies: { 'deep-helper': '1' },
        }),
        'node_modules/deep-helper': registry('deep-helper', '1.0.0', {
          optional: true,
        }),
        'node_modules/shared': registry('shared', '1.0.0'),
      },
      { dependencies: { host: '1' } },
    );
    const result = plan(lock);
    expect(paths(result)).toEqual(['node_modules/host', 'node_modules/shared']);
    expect(result.skipped.map((entry) => entry.path).sort()).toEqual([
      'node_modules/deep-helper',
      'node_modules/native',
      'node_modules/native-helper',
    ]);
    expect(
      result.skipped.find((entry) => entry.path.endsWith('native-helper'))
        ?.reason,
    ).toBe(
      'only needed by node_modules/native, which this machine does not install',
    );
  });

  it('drops a package that needs a skipped optional one outright', () => {
    // `wrapper` is only reachable through an optional edge and requires `native`
    // outright, so npm drops it with `native`.
    const lock = tree(
      {
        'node_modules/app-dep': registry('app-dep', '1.0.0', {
          optionalDependencies: { wrapper: '1' },
        }),
        'node_modules/wrapper': registry('wrapper', '1.0.0', {
          optional: true,
          dependencies: { native: '1' },
        }),
        'node_modules/native': registry('native', '1.0.0', {
          optional: true,
          os: ['darwin'],
        }),
      },
      { dependencies: { 'app-dep': '1' } },
    );
    expect(paths(plan(lock))).toEqual(['node_modules/app-dep']);
  });

  it('omits dev entries for a production install, and devOptional only with optional', () => {
    const lock = tree(
      {
        'node_modules/runtime': registry('runtime', '1.0.0'),
        'node_modules/test-tool': registry('test-tool', '1.0.0', { dev: true }),
        'node_modules/both': registry('both', '1.0.0', { devOptional: true }),
        'node_modules/opt': registry('opt', '1.0.0', { optional: true }),
        'node_modules/peer-only': registry('peer-only', '1.0.0', {
          peer: true,
        }),
      },
      {
        dependencies: { runtime: '1' },
        devDependencies: { 'test-tool': '1' },
      },
    );
    expect(paths(plan(lock)).sort()).toEqual([
      'node_modules/both',
      'node_modules/opt',
      'node_modules/peer-only',
      'node_modules/runtime',
      'node_modules/test-tool',
    ]);
    expect(paths(plan(lock, linuxX64, ['dev'])).sort()).toEqual([
      'node_modules/both',
      'node_modules/opt',
      'node_modules/peer-only',
      'node_modules/runtime',
    ]);
    expect(paths(plan(lock, linuxX64, ['dev', 'optional'])).sort()).toEqual([
      'node_modules/peer-only',
      'node_modules/runtime',
    ]);
    expect(paths(plan(lock, linuxX64, ['peer'])).sort()).toEqual([
      'node_modules/both',
      'node_modules/opt',
      'node_modules/runtime',
      'node_modules/test-tool',
    ]);
    expect(
      plan(lock, linuxX64, ['dev']).skipped.find((entry) =>
        entry.path.endsWith('test-tool'),
      )?.reason,
    ).toBe('dev dependency (omitted)');
  });

  it('does not fetch an entry shipped inside its parent', () => {
    const result = plan(
      tree(
        {
          'node_modules/a': registry('a', '1.0.0'),
          'node_modules/a/node_modules/b': { version: '1.0.0', inBundle: true },
        },
        { dependencies: { a: '1' } },
      ),
    );
    expect(paths(result)).toEqual(['node_modules/a']);
    expect(result.skipped).toEqual([
      expect.objectContaining({
        path: 'node_modules/a/node_modules/b',
        reason: "shipped inside its parent's tarball",
      }),
    ]);
  });

  it('keeps the name an aliased dependency lives under', () => {
    const [entry] = plan(
      tree(
        {
          'node_modules/string-width-cjs': registry('string-width', '4.2.3', {
            name: 'string-width',
          }),
        },
        { dependencies: { 'string-width-cjs': 'npm:string-width@^4.2.0' } },
      ),
    ).packages;
    expect(entry).toMatchObject({
      name: 'string-width-cjs',
      packageName: 'string-width',
      exactPurl: 'pkg:npm/string-width@4.2.3',
      sourceKind: 'registry',
      direct: true,
    });
  });

  it('reports install scripts and deprecation without acting on them', () => {
    const [entry] = plan(
      tree(
        {
          'node_modules/esbuild': registry('esbuild', '0.25.0', {
            hasInstallScript: true,
            deprecated: 'old',
          }),
        },
        { dependencies: { esbuild: '1' } },
      ),
    ).packages;
    expect(entry).toMatchObject({ hasInstallScript: true, deprecated: 'old' });
  });

  it('refuses an entry that does not pin its bytes or say where they are', () => {
    const result = plan(
      tree(
        {
          'node_modules/no-integrity': {
            version: '1.0.0',
            resolved:
              'https://registry.npmjs.org/no-integrity/-/no-integrity-1.0.0.tgz',
          },
          'node_modules/no-resolved': {
            version: '1.0.0',
            integrity: 'sha512-x',
          },
        },
        { dependencies: { 'no-integrity': '1', 'no-resolved': '1' } },
      ),
    );
    expect(result.packages).toEqual([]);
    expect(result.refused.map((entry) => entry.reason)).toEqual([
      expect.stringMatching(/no-integrity@1\.0\.0 has no integrity/u),
      expect.stringMatching(/no-resolved@1\.0\.0 has no resolved URL/u),
    ]);
  });

  it('refuses a nested entry whose parent the flags dropped', () => {
    const result = plan(
      tree(
        {
          'node_modules/a': registry('a', '1.0.0', { dev: true }),
          'node_modules/a/node_modules/b': registry('b', '1.0.0'),
        },
        { devDependencies: { a: '1' } },
      ),
      linuxX64,
      ['dev'],
    );
    expect(result.refused).toEqual([
      expect.objectContaining({
        path: 'node_modules/a/node_modules/b',
        reason: expect.stringMatching(
          /inside node_modules\/a, which is not installed/u,
        ),
      }),
    ]);
  });
});

describe('classifyResolved', () => {
  const entry = (resolved: string | undefined) => ({
    packageName: '@s/pkg',
    version: '1.2.3',
    resolved,
  });

  it('knows a registry archive from a URL dependency', () => {
    expect(
      classifyResolved(
        entry('https://registry.npmjs.org/@s/pkg/-/pkg-1.2.3.tgz'),
      ),
    ).toEqual({ kind: 'registry' });
    expect(
      classifyResolved(
        entry(
          'https://mirror.example/artifactory/api/npm/npm/@s/pkg/-/pkg-1.2.3.tgz',
        ),
      ),
    ).toEqual({ kind: 'registry' });
    expect(
      classifyResolved(entry('https://example.com/builds/pkg.tgz')),
    ).toEqual({
      kind: 'tarball',
    });
    expect(
      classifyResolved(
        entry('https://registry.npmjs.org/@s/pkg/-/pkg-9.9.9.tgz'),
      ),
    ).toEqual({ kind: 'tarball' });
  });

  it('names git and path sources', () => {
    expect(
      classifyResolved(entry('git+ssh://git@github.com/o/r.git#abc')),
    ).toEqual({
      kind: 'git',
    });
    expect(classifyResolved(entry('github:o/r#abc'))).toEqual({ kind: 'git' });
    expect(classifyResolved(entry('file:../pkg'))).toEqual({ kind: 'path' });
    expect(classifyResolved(entry('../pkg'))).toEqual({ kind: 'path' });
  });

  it('refuses what is not a fetchable address', () => {
    expect(classifyResolved(entry(undefined))).toHaveProperty('problem');
    expect(classifyResolved(entry('ftp://example.com/p.tgz'))).toHaveProperty(
      'problem',
    );
    expect(
      classifyResolved(
        entry('https://user:pw@example.com/@s/pkg/-/pkg-1.2.3.tgz'),
      ),
    ).toHaveProperty('problem', expect.stringMatching(/credentials/u));
  });
});

describe('lockDisagreements', () => {
  const lock = tree(
    {
      'node_modules/a': registry('a', '1.5.0'),
      'node_modules/t': registry('t', '1.0.0', { dev: true }),
    },
    { dependencies: { a: '^1.0.0' }, devDependencies: { t: '1' } },
  );
  const manifest = (over: Record<string, Record<string, string>> = {}) => ({
    dependencies: { a: '^1.0.0' },
    devDependencies: { t: '1' },
    optionalDependencies: {},
    peerDependencies: {},
    ...over,
  });

  it('is quiet when they agree', () => {
    expect(lockDisagreements(lock, manifest())).toEqual([]);
  });

  it('names a dependency added to or dropped from package.json', () => {
    expect(
      lockDisagreements(
        lock,
        manifest({ dependencies: { a: '^1.0.0', b: '1' } }),
      ),
    ).toEqual([
      'dependencies.b is in package.json and not in the lock',
      'b (dependencies) has no entry in the lock',
    ]);
    expect(lockDisagreements(lock, manifest({ devDependencies: {} }))).toEqual([
      'devDependencies.t is in the lock and no longer in package.json',
    ]);
  });

  it('names a locked version a changed spec no longer accepts', () => {
    expect(
      lockDisagreements(lock, manifest({ dependencies: { a: '^2.0.0' } })),
    ).toEqual([
      'dependencies.a: package.json asks for ^2.0.0, the lock has 1.5.0',
    ]);
  });

  it('lets a spec that changed but is still satisfied through', () => {
    expect(
      lockDisagreements(lock, manifest({ dependencies: { a: '^1.2.0' } })),
    ).toEqual([]);
  });
});

describe('reading a project', () => {
  const temps: string[] = [];
  afterEach(async () => {
    await Promise.all(
      temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  async function project(files: Record<string, unknown | string>) {
    const dir = await mkdtemp(join(tmpdir(), 'npm-frozen-'));
    temps.push(dir);
    for (const [name, body] of Object.entries(files))
      await writeFile(
        join(dir, name),
        typeof body === 'string' ? body : JSON.stringify(body),
      );
    const detected = await new NpmProjectFormat().detect(dir);
    return { dir, detected: detected! };
  }
  const options = { target: linuxX64, omit: new Set<'dev'>() };
  const lockOf = (
    packages: Record<string, unknown>,
    root: Record<string, unknown> = {},
  ) => ({
    name: 'app',
    version: '1.0.0',
    lockfileVersion: 3,
    packages: { '': { name: 'app', version: '1.0.0', ...root }, ...packages },
  });

  it('reads a project and returns the lock digest', async () => {
    const { detected } = await project({
      'package.json': { name: 'app', dependencies: { a: '^1.0.0' } },
      'package-lock.json': lockOf(
        { 'node_modules/a': registry('a', '1.0.0') },
        { dependencies: { a: '^1.0.0' } },
      ),
    });
    const result = await new NpmProjectFormat().readFrozenLock!(
      detected,
      options,
    );
    expect(result.packages.map((entry) => entry.path)).toEqual([
      'node_modules/a',
    ]);
    expect(result.lockDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(result.lockfileVersion).toBe(3);
  });

  it('refuses a workspace lock and lists its members', async () => {
    const { detected } = await project({
      'package.json': { name: 'app', workspaces: ['packages/*'] },
      'package-lock.json': lockOf(
        {
          'node_modules/@app/one': { resolved: 'packages/one', link: true },
          'node_modules/@app/two': { resolved: 'packages/two', link: true },
          'packages/one': { name: '@app/one', version: '1.0.0' },
          'packages/two': { name: '@app/two', version: '1.0.0' },
          'packages/two/node_modules/x': registry('x', '1.0.0'),
        },
        { workspaces: ['packages/*'] },
      ),
    });
    const result = await new NpmProjectFormat().readFrozenLock!(
      detected,
      options,
    );
    expect(result.packages).toEqual([]);
    expect(result.refused.map((entry) => entry.path)).toEqual([
      'node_modules/@app/one',
      'node_modules/@app/two',
      'packages/one',
      'packages/two',
      '(inside the members)',
    ]);
    expect(result.refused[2]?.reason).toBe(
      'a workspace member (@app/one); workspaces are not installed yet',
    );
  });

  it('refuses a lock that is behind its manifest, naming the difference', async () => {
    const { detected } = await project({
      'package.json': { name: 'app', dependencies: { a: '^2.0.0' } },
      'package-lock.json': lockOf(
        { 'node_modules/a': registry('a', '1.0.0') },
        { dependencies: { a: '^1.0.0' } },
      ),
    });
    await expect(
      new NpmProjectFormat().readFrozenLock!(detected, options),
    ).rejects.toThrow(
      /not in sync.*dependencies\.a: package\.json asks for \^2\.0\.0, the lock has 1\.0\.0/u,
    );
  });

  it('says what is missing', async () => {
    const noLock = await project({ 'package.json': { name: 'app' } });
    await expect(
      new NpmProjectFormat().readFrozenLock!(noLock.detected, options),
    ).rejects.toThrow(/No package-lock\.json/u);
    const noManifest = await project({
      'package.json': '{ not json',
      'package-lock.json': lockOf({}),
    });
    await expect(
      new NpmProjectFormat().readFrozenLock!(noManifest.detected, options),
    ).rejects.toThrow(/package\.json is not valid JSON/u);
  });

  it('does not follow a symbolic link to the lock', async () => {
    const { dir, detected } = await project({
      'package.json': { name: 'app' },
      'real-lock.json': lockOf({}),
    });
    await symlink(join(dir, 'real-lock.json'), join(dir, 'package-lock.json'));
    await expect(
      new NpmProjectFormat().readFrozenLock!(detected, options),
    ).rejects.toThrow(/is a symbolic link/u);
  });

  it('reads a lock in a directory that has a nested project folder', async () => {
    const { dir, detected } = await project({
      'package.json': { name: 'app' },
      'package-lock.json': lockOf({}),
    });
    await mkdir(join(dir, 'node_modules'));
    const result = await new NpmProjectFormat().readFrozenLock!(
      detected,
      options,
    );
    expect(result.packages).toEqual([]);
  });
});
