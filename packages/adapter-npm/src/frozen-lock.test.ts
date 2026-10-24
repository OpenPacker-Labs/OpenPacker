import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { NativeTarget } from '@openpacker/adapter-core';
import { lockDisagreements } from './frozen-lock.js';
import { readPackageLock } from './lock-tree.js';
import { NpmProjectFormat } from './project.js';

const linuxX64: NativeTarget = {
  os: 'linux',
  architecture: 'x64',
  libc: 'glibc',
};

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
    // npm and pnpm are this lock's tar readers: what they read differently
    // is refused (ADR 0058 §8).
    expect(result.extraction).toEqual({
      acceptRedundantEntries: true,
      requireNpmReaderAgreement: true,
    });
  });

  it('does not install a workspace lock for a project whose workspace it was not shown', async () => {
    const { detected } = await project({
      'package.json': { name: 'app', workspaces: ['packages/*'] },
      'package-lock.json': lockOf(
        {
          'node_modules/@app/one': { resolved: 'packages/one', link: true },
          'packages/one': { name: '@app/one', version: '1.0.0' },
          'packages/one/node_modules/x': registry('x', '1.0.0'),
        },
        { workspaces: ['packages/*'] },
      ),
    });
    await expect(
      new NpmProjectFormat().readFrozenLock!(detected, options),
    ).rejects.toThrow(
      /not in sync.*the lock lists the members packages\/one; the project declares the members \(none\)/su,
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

  describe('a lock whose places cannot be written', () => {
    const both = {
      'node_modules/MS': registry('ms', '2.1.3', { name: 'ms' }),
      'node_modules/ms': registry('ms', '2.1.3'),
    };
    const deps = { ms: '2.1.3', MS: 'npm:ms@2.1.3' };

    it('is refused while it is read, before anything is fetched or removed', async () => {
      const { detected } = await project({
        'package.json': { name: 'app', dependencies: deps },
        'package-lock.json': lockOf(both, { dependencies: deps }),
      });
      await expect(
        new NpmProjectFormat().readFrozenLock!(detected, options),
      ).rejects.toMatchObject({
        code: 'LAYOUT_PATHS_INVALID',
        message: expect.stringMatching(
          /ms@2\.1\.3 would be installed as ms, which differs only by case from MS.*\(at node_modules\/ms\)/u,
        ),
      });
    });

    it('is not asked about when the lock is already refused for what it holds', async () => {
      const { detected } = await project({
        'package.json': { name: 'app', dependencies: deps },
        'package-lock.json': lockOf(
          { ...both, 'node_modules/x': { version: '1.0.0' } },
          { dependencies: deps },
        ),
      });
      const result = await new NpmProjectFormat().readFrozenLock!(
        detected,
        options,
      );
      expect(result.refused.map((entry) => entry.path)).toEqual([
        'node_modules/x',
      ]);
    });
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
