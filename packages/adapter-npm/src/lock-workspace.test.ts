import { describe, expect, it } from 'vitest';
import { resolveFromChain } from './lock-tree.js';
import {
  member,
  registry,
  treeOf,
  workspaceLock,
} from './workspace-fixture.js';

const two = {
  'packages/one': member('@app/one', {
    dependencies: { left: '^1.0.0', '@app/two': '^1.0.0' },
    bin: { one: 'bin/one.js' },
  }),
  'packages/two': member('@app/two', {
    version: '2.1.0',
    devDependencies: { right: '1' },
    bin: 'cli.js',
  }),
};

describe('reading a workspace out of package-lock.json', () => {
  const lock = workspaceLock({
    members: two,
    packages: {
      'node_modules/left': registry('left', '1.2.0'),
      'node_modules/right': registry('right', '1.0.0', { dev: true }),
      'packages/one/node_modules/left': registry('left', '0.9.0'),
      'packages/one/node_modules/left/node_modules/deep': registry(
        'deep',
        '1.0.0',
      ),
    },
  });
  const { workspace } = treeOf(lock);

  it('has no workspace to read in a lock that holds none', () => {
    expect(
      treeOf({
        lockfileVersion: 3,
        packages: {
          '': { name: 'a' },
          'node_modules/x': registry('x', '1.0.0'),
        },
      }).workspace,
    ).toBeUndefined();
  });

  it('finds each member by the directories its root selects, with what it declares', () => {
    expect(workspace?.patterns).toEqual(['packages/*']);
    expect(workspace?.members.map((m) => [m.dir, m.name, m.version])).toEqual([
      ['packages/one', '@app/one', '1.0.0'],
      ['packages/two', '@app/two', '2.1.0'],
    ]);
    const [one, other] = workspace!.members;
    expect(one?.dependencies).toEqual({ left: '^1.0.0', '@app/two': '^1.0.0' });
    expect(other?.devDependencies).toEqual({ right: '1' });
  });

  it("reads a member's executables the way npm normalizes them", () => {
    const [one, other] = workspace!.members;
    expect(one?.bin).toEqual({ one: 'bin/one.js' });
    // A bare string is named for the package, without its scope.
    expect(other?.bin).toEqual({ two: 'cli.js' });
  });

  it('names a member after its directory when its entry carries no name', () => {
    const nameless = treeOf(
      workspaceLock({
        members: { 'packages/plain': { version: '1.0.0' } },
        linked: { 'packages/plain': 'plain' },
      }),
    );
    expect(nameless.workspace?.members[0]?.name).toBe('plain');
  });

  it("turns the lock's link for a member into the text of a link", () => {
    expect(workspace?.links).toEqual([
      {
        path: 'node_modules/@app/one',
        name: '@app/one',
        dir: 'packages/one',
        target: '../../packages/one',
      },
      {
        path: 'node_modules/@app/two',
        name: '@app/two',
        dir: 'packages/two',
        target: '../../packages/two',
      },
    ]);
  });

  it("keeps the packages inside a member apart from the project's own", () => {
    const tree = treeOf(lock);
    expect(tree.entries.map((entry) => entry.path)).toEqual([
      'node_modules/left',
      'node_modules/right',
    ]);
    expect(
      tree.workspace?.entries.map((e) => [e.path, e.member, e.chain]),
    ).toEqual([
      ['packages/one/node_modules/left', 'packages/one', ['left']],
      [
        'packages/one/node_modules/left/node_modules/deep',
        'packages/one',
        ['left', 'deep'],
      ],
    ]);
  });

  it('keeps entries, links and foreign as the readers that predate it saw them', () => {
    const tree = treeOf(lock);
    expect(tree.links.map((l) => l.path)).toEqual([
      'node_modules/@app/one',
      'node_modules/@app/two',
    ]);
    expect(tree.foreign.map((f) => f.path)).toEqual([
      'packages/one',
      'packages/one/node_modules/left',
      'packages/one/node_modules/left/node_modules/deep',
      'packages/two',
    ]);
  });

  it("looks for a member's dependency in the member first and then in the project", () => {
    const tree = treeOf(lock);
    const byPath = new Map(
      [...tree.entries, ...tree.workspace!.entries].map((e) => [e.path, e]),
    );
    expect(resolveFromChain(byPath, [], 'left', 'packages/one')?.version).toBe(
      '0.9.0',
    );
    expect(resolveFromChain(byPath, [], 'right', 'packages/one')?.path).toBe(
      'node_modules/right',
    );
    expect(
      resolveFromChain(byPath, ['left'], 'deep', 'packages/one')?.path,
    ).toBe('packages/one/node_modules/left/node_modules/deep');
    expect(resolveFromChain(byPath, [], 'left')?.version).toBe('1.2.0');
  });
});

describe('a lock that contradicts itself', () => {
  it('has no two members with one name', () => {
    expect(() =>
      treeOf(
        workspaceLock({
          workspaces: ['packages/*', 'tools/*'],
          members: {
            'packages/a': member('same'),
            'tools/b': member('same'),
          },
          linked: { 'packages/a': 'same', 'tools/b': null },
        }),
      ),
    ).toThrow(/Two workspace members are named "same": packages\/a, tools\/b/u);
  });

  it('links every member', () => {
    expect(() =>
      treeOf(
        workspaceLock({
          members: { 'packages/one': member('one') },
          linked: { 'packages/one': null },
        }),
      ),
    ).toThrow(
      /member one \(packages\/one\) has no node_modules\/one link in the lock/u,
    );
  });

  it('declares patterns it can read', () => {
    expect(() =>
      treeOf(workspaceLock({ root: { workspaces: 5 }, members: {} })),
    ).toThrow(/workspaces must be an array/u);
    expect(() =>
      treeOf(workspaceLock({ workspaces: ['.'], members: {} })),
    ).toThrow(/names the root itself/u);
  });

  it('names its members by names a directory can hold', () => {
    expect(() =>
      treeOf(
        workspaceLock({
          members: { 'packages/one': member('../../x') },
          linked: { 'packages/one': null },
        }),
      ),
    ).toThrow(/packages\["packages\/one"\]/u);
  });

  it('gives a member dependency lists of the right type', () => {
    expect(() =>
      treeOf(
        workspaceLock({
          members: { 'packages/one': member('one', { dependencies: [] }) },
        }),
      ),
    ).toThrow(/dependencies must be an object/u);
  });
});
