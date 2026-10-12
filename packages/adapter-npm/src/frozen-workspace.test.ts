import { describe, expect, it } from 'vitest';
import type {
  FrozenOmit,
  FrozenWorkspaceScope,
} from '@openpacker/adapter-core';
import { planFrozenPackageLock } from './frozen-select.js';
import {
  LINUX_X64,
  member,
  registry,
  treeOf,
  workspaceLock,
} from './workspace-fixture.js';

/**
 * A project with a root that needs `a` and, for tests, `t`; three members:
 * `one` needs `a`, the member `two` and the optional `mac`; `two` needs `b`
 * and, for development, `dd`, and ships an executable; `three` wants its own
 * version of `shared`, which `one` takes from the project.
 */
const lock = workspaceLock({
  root: {
    dependencies: { a: '^1.0.0' },
    devDependencies: { t: '1' },
  },
  members: {
    'packages/one': member('one', {
      dependencies: { a: '^1.0.0', two: '^1.0.0', shared: '^1.0.0' },
      optionalDependencies: { mac: '^1.0.0' },
    }),
    'packages/two': member('two', {
      dependencies: { b: '^1.0.0' },
      devDependencies: { dd: '^1.0.0' },
      bin: { two: 'bin/two.js' },
    }),
    'packages/three': member('three', {
      dependencies: { shared: '^2.0.0' },
    }),
  },
  packages: {
    'node_modules/a': registry('a', '1.0.0'),
    'node_modules/t': registry('t', '1.0.0', { dev: true }),
    'node_modules/shared': registry('shared', '1.0.0'),
    'packages/three/node_modules/shared': registry('shared', '2.0.0'),
    'node_modules/b': registry('b', '1.0.0'),
    'node_modules/dd': registry('dd', '1.0.0', { dev: true }),
    'node_modules/mac': registry('mac', '1.0.0', {
      optional: true,
      os: ['darwin'],
      dependencies: { 'mac-helper': '1' },
    }),
    'node_modules/mac-helper': registry('mac-helper', '1.0.0', {
      optional: true,
    }),
  },
});

function plan(
  scope?: FrozenWorkspaceScope,
  omit: readonly FrozenOmit[] = [],
  from = lock,
) {
  return planFrozenPackageLock({
    tree: treeOf(from),
    options: {
      target: LINUX_X64,
      omit: new Set(omit),
      ...(scope && { workspace: { disk: async () => [], scope } }),
    },
  });
}

const paths = (result: ReturnType<typeof plan>) =>
  result.packages.map((pkg) => pkg.path).sort();
const left = (result: ReturnType<typeof plan>, kind: string) =>
  result.skipped
    .filter((item) => item.kind === kind)
    .map((item) => item.path)
    .sort();

describe('a frozen install of a workspace lock', () => {
  it('installs the packages of the project and of every member, each where the lock puts it', () => {
    const result = plan();
    expect(result.refused).toEqual([]);
    expect(paths(result)).toEqual([
      'node_modules/a',
      'node_modules/b',
      'node_modules/dd',
      'node_modules/shared',
      'node_modules/t',
      'packages/three/node_modules/shared',
    ]);
    expect(left(result, 'platform')).toEqual(['node_modules/mac']);
    expect(left(result, 'orphaned')).toEqual(['node_modules/mac-helper']);
  });

  it('says which members to link, and what to shim, and which directories hold a node_modules to clear', () => {
    const { workspace } = plan();
    expect(workspace?.memberDirs).toEqual([
      'packages/one',
      'packages/three',
      'packages/two',
    ]);
    expect(
      workspace?.layout.members.map((m) => [m.dir, m.name, m.bin]),
    ).toEqual([
      ['packages/one', 'one', {}],
      ['packages/three', 'three', {}],
      ['packages/two', 'two', { two: 'bin/two.js' }],
    ]);
    expect(workspace?.layout.links).toEqual([
      { path: 'node_modules/one', target: '../packages/one' },
      { path: 'node_modules/three', target: '../packages/three' },
      { path: 'node_modules/two', target: '../packages/two' },
    ]);
  });

  it('calls a package direct when the project or a member names it', () => {
    const direct = Object.fromEntries(
      plan().packages.map((pkg) => [pkg.path, pkg.direct]),
    );
    expect(direct).toMatchObject({
      'node_modules/a': true,
      // Named by no top but `dd`'s own member, for development.
      'node_modules/dd': true,
      'node_modules/shared': true,
      'packages/three/node_modules/shared': true,
    });
  });

  it('does not run the platform check on a package it leaves alone', () => {
    const macOnly = workspaceLock({
      members: {
        'packages/one': member('one', { dependencies: { onlymac: '1' } }),
        'packages/three': member('three'),
      },
      packages: {
        'node_modules/onlymac': registry('onlymac', '1.0.0', {
          os: ['darwin'],
        }),
      },
    });
    expect(
      plan(
        { kind: 'members', dirs: ['packages/three'], includeRoot: false },
        [],
        macOnly,
      ).refused,
    ).toEqual([]);
    expect(plan(undefined, [], macOnly).refused.map((r) => r.reason)).toEqual([
      expect.stringMatching(
        /onlymac@1\.0\.0 is for os darwin, not this machine .*and is not optional/u,
      ),
    ]);
  });

  describe('--omit', () => {
    it("leaves out what only a member's development dependencies need", () => {
      const result = plan(undefined, ['dev']);
      expect(left(result, 'omitted')).toEqual([
        'node_modules/dd',
        'node_modules/t',
      ]);
      expect(paths(result)).not.toContain('node_modules/dd');
      // The members themselves are not development dependencies of anything.
      expect(result.workspace?.layout.links).toHaveLength(3);
    });
  });

  describe('with a selection of members', () => {
    const only = (...dirs: string[]): FrozenWorkspaceScope => ({
      kind: 'members',
      dirs,
      includeRoot: false,
    });

    it('installs the member, what it needs, and nothing else', () => {
      const result = plan(only('packages/two'));
      expect(paths(result)).toEqual(['node_modules/b', 'node_modules/dd']);
      expect(left(result, 'workspace')).toEqual([
        'node_modules/a',
        'node_modules/mac',
        'node_modules/mac-helper',
        'node_modules/shared',
        'node_modules/t',
        'packages/three/node_modules/shared',
      ]);
      expect(result.workspace?.layout.links).toEqual([
        { path: 'node_modules/two', target: '../packages/two' },
      ]);
      expect(result.workspace?.layout.members.map((m) => m.dir)).toEqual([
        'packages/two',
      ]);
      // Every member's node_modules is cleared whichever are installed.
      expect(result.workspace?.memberDirs).toHaveLength(3);
    });

    it('takes along a member the selected one depends on, and what that one needs', () => {
      const result = plan(only('packages/one'));
      expect(paths(result)).toEqual([
        'node_modules/a',
        'node_modules/b',
        'node_modules/dd',
        'node_modules/shared',
      ]);
      expect(result.workspace?.layout.links.map((l) => l.path)).toEqual([
        'node_modules/one',
        'node_modules/two',
      ]);
      expect(left(result, 'platform')).toEqual(['node_modules/mac']);
    });

    it("keeps a member's own version of a package where the lock put it", () => {
      expect(paths(plan(only('packages/three')))).toEqual([
        'packages/three/node_modules/shared',
      ]);
    });

    it('applies --omit to what the member needs', () => {
      expect(paths(plan(only('packages/two'), ['dev']))).toEqual([
        'node_modules/b',
      ]);
    });

    it("adds the project's own dependencies, and only those, with the root", () => {
      const result = plan({
        kind: 'members',
        dirs: ['packages/three'],
        includeRoot: true,
      });
      expect(paths(result)).toEqual([
        'node_modules/a',
        'node_modules/t',
        'packages/three/node_modules/shared',
      ]);
      // The project's edges to its members' names are workspace edges.
      expect(result.workspace?.layout.links).toEqual([
        { path: 'node_modules/three', target: '../packages/three' },
      ]);
    });

    it('names a directory that is not a member of the lock', () => {
      expect(() => plan(only('packages/four'))).toThrow(
        /selection names packages\/four, which is not a member of the lock/u,
      );
    });
  });

  describe("with the project's own dependencies only", () => {
    it('links no member and installs no package only a member needs', () => {
      const result = plan({ kind: 'root' });
      expect(paths(result)).toEqual(['node_modules/a', 'node_modules/t']);
      expect(result.workspace?.layout).toEqual({ members: [], links: [] });
    });
  });

  it('refuses a package inside a member whose parent is not installed', () => {
    const result = plan(
      undefined,
      ['dev'],
      workspaceLock({
        members: { 'packages/one': member('one') },
        packages: {
          'packages/one/node_modules/p': registry('p', '1.0.0', { dev: true }),
          'packages/one/node_modules/p/node_modules/q': registry('q', '1.0.0'),
        },
      }),
    );
    expect(result.refused).toEqual([
      {
        path: 'packages/one/node_modules/p/node_modules/q',
        reason: expect.stringMatching(
          /q@1\.0\.0 lives inside packages\/one\/node_modules\/p, which is not installed/u,
        ),
      },
    ]);
  });

  it('puts a lock with no workspace through unchanged', () => {
    const result = planFrozenPackageLock({
      tree: treeOf({
        lockfileVersion: 3,
        packages: {
          '': { name: 'app', dependencies: { a: '1' } },
          'node_modules/a': registry('a', '1.0.0'),
        },
      }),
      options: { target: LINUX_X64, omit: new Set() },
    });
    expect(result.workspace).toBeUndefined();
    expect(result.packages.map((pkg) => pkg.path)).toEqual(['node_modules/a']);
  });

  it("follows a member's dependency on another that the project's manifest does not name", () => {
    const result = plan(
      { kind: 'members', dirs: ['packages/one'], includeRoot: false },
      [],
      workspaceLock({
        members: {
          'packages/one': member('one', { dependencies: { two: '1' } }),
          'packages/two': member('two', { dependencies: { b: '1' } }),
        },
        packages: { 'node_modules/b': registry('b', '1.0.0') },
      }),
    );
    expect(result.workspace?.layout.links.map((l) => l.path)).toEqual([
      'node_modules/one',
      'node_modules/two',
    ]);
    expect(paths(result)).toEqual(['node_modules/b']);
  });
});
