import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FrozenWorkspaceInput } from '@openpacker/adapter-core';
import { NpmProjectFormat } from './project.js';
import {
  LINUX_X64,
  diskMembers,
  link,
  member,
  registry,
  workspaceLock,
} from './workspace-fixture.js';

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

const oneDeps = { left: '^1.0.0', two: '^2.0.0' };
const one = member('one', { dependencies: oneDeps });
const two = member('two', {
  version: '2.0.0',
  devDependencies: { right: '1' },
});
const packages = {
  'node_modules/left': registry('left', '1.2.0'),
  'node_modules/right': registry('right', '1.0.0', { dev: true }),
};
const root = { dependencies: { one: '^1.0.0' } };
const members = { 'packages/one': one, 'packages/two': two };

async function readLock(
  lock: Record<string, unknown>,
  disk: FrozenWorkspaceInput | undefined,
  manifest: Record<string, unknown> = {
    name: 'app',
    ...root,
    workspaces: ['packages/*'],
  },
) {
  const dir = await mkdtemp(join(tmpdir(), 'npm-frozen-ws-'));
  temps.push(dir);
  await writeFile(join(dir, 'package.json'), JSON.stringify(manifest));
  await writeFile(join(dir, 'package-lock.json'), JSON.stringify(lock));
  const format = new NpmProjectFormat();
  const detected = (await format.detect(dir))!;
  return format.readFrozenLock!(detected, {
    target: LINUX_X64,
    omit: new Set(),
    ...(disk && { workspace: disk }),
  });
}

const input = (
  onDisk: Record<string, Record<string, unknown>> = members,
): FrozenWorkspaceInput => ({
  disk: async () => diskMembers(onDisk),
  scope: { kind: 'all' },
});

const lock = (
  over: Parameters<typeof workspaceLock>[0] extends infer T
    ? Partial<T>
    : never = {},
) => workspaceLock({ root, members, packages, ...over });

describe('reading a workspace lock against the workspace on disk', () => {
  it('reads a lock whose members are the ones on disk', async () => {
    const result = await readLock(lock(), input());
    expect(result.refused).toEqual([]);
    expect(result.packages.map((pkg) => pkg.path)).toEqual([
      'node_modules/left',
      'node_modules/right',
    ]);
    expect(result.workspace?.layout.links.map((l) => l.path)).toEqual([
      'node_modules/one',
      'node_modules/two',
    ]);
  });

  it('accepts a project that depends on its own member by a plain range', async () => {
    const result = await readLock(lock(), input());
    expect(result.workspace?.memberDirs).toEqual([
      'packages/one',
      'packages/two',
    ]);
  });

  it('takes the root out of the comparison', async () => {
    const result = await readLock(lock(), {
      disk: async () => diskMembers({ '': { name: 'app' }, ...members }),
      scope: { kind: 'all' },
    });
    expect(result.refused).toEqual([]);
  });

  it('does not look at the workspace on disk of a project that has none', async () => {
    let asked = 0;
    const plain = {
      lockfileVersion: 3,
      packages: {
        '': { name: 'app', dependencies: { left: '^1.0.0' } },
        'node_modules/left': registry('left', '1.2.0'),
      },
    };
    const result = await readLock(
      plain,
      {
        disk: async () => {
          asked += 1;
          throw new Error('discovery would fail here');
        },
        scope: { kind: 'all' },
      },
      { name: 'app', dependencies: { left: '^1.0.0' } },
    );
    expect(result.packages.map((pkg) => pkg.path)).toEqual([
      'node_modules/left',
    ]);
    expect(asked).toBe(0);
  });

  it('looks when package.json declares workspaces, though the lock lists no member', async () => {
    let asked = 0;
    await expect(
      readLock(
        { lockfileVersion: 3, packages: { '': { name: 'app' } } },
        {
          disk: async () => {
            asked += 1;
            return diskMembers({ 'packages/one': one });
          },
          scope: { kind: 'all' },
        },
        { name: 'app', workspaces: ['packages/*'] },
      ),
    ).rejects.toThrow(
      /packages\/one \(one\) is a member on disk and is not in the lock/u,
    );
    expect(asked).toBe(1);
  });

  describe('refuses, naming both sides, when the members differ', () => {
    it('has a member the disk lacks', async () => {
      await expect(
        readLock(lock(), input({ 'packages/one': one })),
      ).rejects.toThrow(
        /not in sync .*the lock lists the members packages\/one, packages\/two; the project declares the members packages\/one; packages\/two \(two\) is a member in the lock and is not on disk/su,
      );
    });

    it('lacks a member the disk has', async () => {
      await expect(
        readLock(lock(), input({ ...members, 'packages/new': member('new') })),
      ).rejects.toThrow(
        /the lock lists the members packages\/one, packages\/two; the project declares the members packages\/new, packages\/one, packages\/two; packages\/new \(new\) is a member on disk and is not in the lock/su,
      );
    });

    it('names a member differently', async () => {
      await expect(
        readLock(
          lock(),
          input({ ...members, 'packages/two': { ...two, name: 'deux' } }),
        ),
      ).rejects.toThrow(
        /packages\/two is named "two" in the lock and "deux" on disk/u,
      );
    });

    it('holds a member at another version', async () => {
      await expect(
        readLock(
          lock(),
          input({ ...members, 'packages/two': { ...two, version: '3.0.0' } }),
        ),
      ).rejects.toThrow(
        /packages\/two is version "2\.0\.0" in the lock and "3\.0\.0" on disk/u,
      );
    });

    it('sees no workspace on disk at all, when the host found none', async () => {
      await expect(readLock(lock(), undefined)).rejects.toThrow(
        /the lock lists the members packages\/one, packages\/two; the project declares the members \(none\)/u,
      );
    });
  });

  describe('holds each member to its own package.json, as npm ci does', () => {
    it('refuses a dependency added since the lock was written', async () => {
      await expect(
        readLock(
          lock(),
          input({
            ...members,
            'packages/one': {
              ...one,
              dependencies: { ...oneDeps, fresh: '1' },
            },
          }),
        ),
      ).rejects.toThrow(
        /packages\/one: dependencies\.fresh is in package\.json and not in the lock/u,
      );
    });

    it('refuses a dependency dropped since', async () => {
      await expect(
        readLock(
          lock(),
          input({
            ...members,
            'packages/one': { ...one, dependencies: { two: '^2.0.0' } },
          }),
        ),
      ).rejects.toThrow(
        /packages\/one: dependencies\.left is in the lock and no longer in package\.json/u,
      );
    });

    it('refuses a spec the locked version no longer satisfies', async () => {
      await expect(
        readLock(
          lock(),
          input({
            ...members,
            'packages/one': {
              ...one,
              dependencies: { left: '^3.0.0', two: '^2.0.0' },
            },
          }),
        ),
      ).rejects.toThrow(
        /packages\/one: dependencies\.left: package\.json asks for \^3\.0\.0, the lock has 1\.2\.0/u,
      );
    });

    it("holds a dependency on another member to that member's version", async () => {
      await expect(
        readLock(
          lock(),
          input({
            ...members,
            'packages/one': {
              ...one,
              dependencies: { left: '^1.0.0', two: '^3.0.0' },
            },
          }),
        ),
      ).rejects.toThrow(
        /packages\/one: dependencies\.two: package\.json asks for \^3\.0\.0, the lock has 2\.0\.0/u,
      );
    });

    it('lets a changed spec the locked version still satisfies through', async () => {
      const result = await readLock(
        lock(),
        input({
          ...members,
          'packages/one': {
            ...one,
            dependencies: { left: '>=1.1.0', two: '2' },
          },
        }),
      );
      expect(result.refused).toEqual([]);
    });

    it('refuses a member that lists a dependency the lock lacks', async () => {
      const withGap = {
        ...members,
        'packages/one': { ...one, dependencies: { ...oneDeps, gap: '1' } },
      };
      await expect(
        readLock(lock({ members: withGap }), input(withGap)),
      ).rejects.toThrow(
        /packages\/one: gap \(dependencies\) has no entry in the lock/u,
      );
    });

    it('does not need an optional dependency to be in the lock', async () => {
      const optional = {
        ...members,
        'packages/one': { ...one, optionalDependencies: { never: '1' } },
      };
      const result = await readLock(
        lock({ members: optional }),
        input(optional),
      );
      expect(result.refused).toEqual([]);
    });
  });

  describe('lists what it cannot install, by name, and installs none of it', () => {
    it('refuses a link outside the project and a link to a directory that is not a member', async () => {
      const result = await readLock(
        lock({
          packages: {
            ...packages,
            'node_modules/evil': link('../outside'),
            'node_modules/vendored': link('vendor/vendored'),
            'vendor/vendored': { name: 'vendored', version: '1.0.0' },
          },
        }),
        input(),
      );
      expect(result.packages).toEqual([]);
      expect(result.workspace).toBeUndefined();
      expect(result.refused.map((entry) => entry.path)).toEqual([
        'vendor/vendored',
        'node_modules/evil',
        'node_modules/vendored',
      ]);
      expect(result.refused[1]?.reason).toMatch(/leaves the project root/u);
    });

    it('refuses before it compares members, so the list is the whole answer', async () => {
      const result = await readLock(
        lock({ packages: { ...packages, 'node_modules/evil': link('/etc') } }),
        input({ 'packages/one': one }),
      );
      expect(result.refused.map((entry) => entry.path)).toEqual([
        'node_modules/evil',
      ]);
    });
  });
});
