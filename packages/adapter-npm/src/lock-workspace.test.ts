import { describe, expect, it } from 'vitest';
import { resolveFromChain } from './lock-tree.js';
import {
  link,
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

describe('what the lock may ask for', () => {
  const refusals = (lock: Record<string, unknown>) =>
    treeOf(lock).workspace?.refused.map((r) => [r.path, r.reason]);

  it('does not authorise a link to a place outside the project', () => {
    const lock = workspaceLock({
      members: { 'packages/one': member('one') },
      packages: { 'node_modules/evil': link('../outside') },
    });
    expect(refusals(lock)).toEqual([
      [
        'node_modules/evil',
        expect.stringMatching(
          /leaves the project root.*only a workspace member may be linked/su,
        ),
      ],
    ]);
  });

  it.each([
    ['an absolute path', '/etc'],
    ['a drive path', 'C:/x'],
    ['the project itself', '.'],
    ['an empty target', ''],
    ['a path that is not normal', 'packages/./one'],
    ['a path with a backslash', 'packages\\one'],
  ])('does not authorise a link that points at %s', (_label, target) => {
    const lock = workspaceLock({
      members: { 'packages/one': member('one') },
      packages: { 'node_modules/evil': link(target) },
    });
    const reasons = refusals(lock)!.filter(
      ([path]) => path === 'node_modules/evil',
    );
    expect(reasons).toHaveLength(1);
    expect(reasons[0]![1]).toMatch(/only a workspace member may be linked/u);
  });

  it('does not authorise a link to a directory that is not a member', () => {
    const lock = workspaceLock({
      members: { 'packages/one': member('one') },
      packages: {
        'node_modules/vendored': link('vendor/vendored'),
        'vendor/vendored': { name: 'vendored', version: '1.0.0' },
      },
    });
    expect(refusals(lock)).toEqual([
      [
        'vendor/vendored',
        expect.stringMatching(
          /not a workspace member \(the lock's workspaces select packages\/\*\)/u,
        ),
      ],
      [
        'node_modules/vendored',
        expect.stringMatching(
          /a link to vendor\/vendored, which is not a workspace member/u,
        ),
      ],
    ]);
  });

  it('does not take a bare path for a member because the directory exists', () => {
    const lock = workspaceLock({
      workspaces: ['apps/*'],
      members: {},
      packages: {
        'node_modules/tool': link('packages/tool'),
        'packages/tool': member('tool'),
      },
    });
    expect(refusals(lock)?.map(([path]) => path)).toEqual([
      'packages/tool',
      'node_modules/tool',
    ]);
  });

  it("does not authorise a link the layout's own rules would refuse", () => {
    // A member in a directory the link rules keep out of reach (opm\'s own state).
    const lock = workspaceLock({
      workspaces: ['.opm/tools'],
      members: { '.opm/tools': member('tools') },
    });
    expect(refusals(lock)).toEqual([
      [
        'node_modules/tools',
        expect.stringMatching(
          /a link to \.opm\/tools that the layout's link rules refuse \(.*inside \.opm/su,
        ),
      ],
    ]);
  });

  it('does not link a member under another name', () => {
    const lock = workspaceLock({
      members: { 'packages/one': member('one') },
      linked: { 'packages/one': 'alias' },
    });
    expect(refusals(lock)).toEqual([
      [
        'node_modules/alias',
        expect.stringMatching(
          /a link named alias to the member one \(packages\/one\); a member is linked under its own name only/u,
        ),
      ],
    ]);
  });

  it('does not make a link inside a package', () => {
    const lock = workspaceLock({
      members: { 'packages/one': member('one') },
      packages: {
        'node_modules/a': registry('a', '1.0.0'),
        'node_modules/a/node_modules/one': link('packages/one'),
        'packages/one/node_modules/two': link('packages/one'),
      },
    });
    expect(refusals(lock)).toEqual([
      [
        'packages/one/node_modules/two',
        expect.stringMatching(
          /a link inside the workspace member packages\/one/u,
        ),
      ],
      [
        'node_modules/a/node_modules/one',
        expect.stringMatching(/a link inside a package/u),
      ],
    ]);
  });

  it('does not install into a directory that is not a member', () => {
    const lock = workspaceLock({
      members: { 'packages/one': member('one') },
      packages: { 'vendor/lib/node_modules/x': registry('x', '1.0.0') },
    });
    expect(refusals(lock)).toEqual([
      [
        'vendor/lib/node_modules/x',
        expect.stringMatching(
          /inside vendor\/lib, which is not a workspace member/u,
        ),
      ],
    ]);
  });

  it('refuses a package bundled in a member, which has no archive to bundle it in', () => {
    const lock = workspaceLock({
      members: { 'packages/one': member('one', { bundleDependencies: ['b'] }) },
      packages: {
        'packages/one/node_modules/b': registry('b', '1.0.0', {
          inBundle: true,
        }),
        'packages/one/node_modules/c': registry('c', '1.0.0'),
        'packages/one/node_modules/c/node_modules/d': registry('d', '1.0.0', {
          inBundle: true,
        }),
      },
    });
    expect(refusals(lock)).toEqual([
      [
        'packages/one/node_modules/b',
        expect.stringMatching(
          /b@1\.0\.0 is bundled in the workspace member packages\/one, a directory with no archive/u,
        ),
      ],
    ]);
    // One bundled in a registry package's archive is the ordinary case.
    expect(treeOf(lock).workspace?.entries.map((entry) => entry.path)).toEqual([
      'packages/one/node_modules/c',
      'packages/one/node_modules/c/node_modules/d',
    ]);
  });

  it('does not take a member recorded as a link for a member', () => {
    const lock = workspaceLock({
      members: { 'packages/one': { ...link('elsewhere') } },
      linked: { 'packages/one': null },
    });
    expect(refusals(lock)).toEqual([
      [
        'packages/one',
        expect.stringMatching(/recorded as a link; a member is a directory/u),
      ],
    ]);
  });

  it('reads nothing as a member from a directory a pattern could never reach', () => {
    const lock = workspaceLock({
      members: { 'packages/one': member('one') },
      packages: { 'packages/one/node_modules/x/../../../escape': member('x') },
    });
    expect(() => treeOf(lock)).toThrow(
      /not a relative path inside the project/u,
    );
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
