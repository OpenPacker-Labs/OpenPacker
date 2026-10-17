import { describe, expect, it } from 'vitest';
import {
  link,
  member,
  registry,
  treeOf,
  workspaceLock,
} from './workspace-fixture.js';

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

describe("a member's own link is the thing the lock gets wrong", () => {
  // The link npm writes for `one` is `node_modules/one`; the lock below
  // replaces it, so the refusal has to name that link and no other.
  const lockWith = (target: string) =>
    workspaceLock({
      members: { 'packages/one': member('one') },
      packages: {
        'node_modules/one': link(target),
        'vendor/one': { name: 'one', version: '1.0.0' },
      },
    });

  it.each([
    ['leaves the project root', '../../outside', /leaves the project root/u],
    ['leaves it by one more step', '../../..', /leaves the project root/u],
    ['is `..`', '..', /leaves the project root/u],
    ['is an absolute path', '/etc', /an absolute path/u],
    ['is a drive path', 'C:/x', /an absolute path/u],
    ['is the project itself', '.', /the project root itself/u],
    ['is empty', '', /has no target/u],
    ['is not in normal form', './packages/one', /not in normal form/u],
    ['ends in a slash', 'packages/one/', /not in normal form/u],
    ['doubles a slash', 'packages//one', /not in normal form/u],
    ['has a backslash', 'packages\\one', /not a path inside the project/u],
    ['has a NUL', 'packages/one\0', /not a path inside the project/u],
    [
      'is a directory no pattern selects',
      'vendor/one',
      /not a workspace member/u,
    ],
    ['is the name of a layout directory', '.opm/x', /not a workspace member/u],
    ['is under node_modules', 'node_modules/two', /not a workspace member/u],
    ['is a glob', 'packages/*', /not a workspace member/u],
  ])('names it when its target %s', (_label, target, reason) => {
    const tree = treeOf(lockWith(target));
    expect(tree.workspace?.links).toEqual([]);
    expect(
      tree.workspace?.refused.filter(
        (entry) => entry.path === 'node_modules/one',
      ),
    ).toEqual([
      {
        path: 'node_modules/one',
        reason: expect.stringMatching(reason),
      },
    ]);
  });

  it('does not point the link at the member that has its name when its target is elsewhere', () => {
    const tree = treeOf(lockWith('vendor/one'));
    // The member `one` exists and is called `one`; the lock pointing its link
    // at another directory does not make that directory `one`, and the link is
    // not quietly repointed at packages/one.
    expect(tree.workspace?.members.map((m) => m.dir)).toEqual(['packages/one']);
    expect(tree.workspace?.links).toEqual([]);
    expect(
      tree.workspace?.refused.some(
        (entry) =>
          entry.path === 'node_modules/one' &&
          /a link to vendor\/one, which is not a workspace member/u.test(
            entry.reason,
          ),
      ),
    ).toBe(true);
  });

  it('names a link for one member that points at another member', () => {
    const tree = treeOf(
      workspaceLock({
        members: {
          'packages/one': member('one'),
          'packages/two': member('two'),
        },
        packages: { 'node_modules/one': link('packages/two') },
      }),
    );
    expect(tree.workspace?.links.map((l) => l.path)).toEqual([
      'node_modules/two',
    ]);
    expect(
      tree.workspace?.refused.map((entry) => [entry.path, entry.reason]),
    ).toEqual([
      [
        'node_modules/one',
        expect.stringMatching(
          /a link named one to the member two \(packages\/two\)/u,
        ),
      ],
    ]);
  });

  it('still says a member has no link when the lock has no link of that name at all', () => {
    expect(() =>
      treeOf(
        workspaceLock({
          members: { 'packages/one': member('one') },
          linked: { 'packages/one': null },
          packages: { 'node_modules/evil': link('../../outside') },
        }),
      ),
    ).toThrow(/member one \(packages\/one\) has no node_modules\/one link/u);
  });
});
