import { afterEach, describe, expect, it } from 'vitest';
import {
  discoverWorkspace,
  graphOfWorkspace,
  linkPolicyOf,
} from '../src/index.js';
import { cleanup, dirsOf, npm, pnpm, scratch } from './workspace-tree.js';

afterEach(cleanup);

describe('which workspace a directory is', () => {
  it('is none when nothing declares one', async () => {
    expect(await dirsOf({ 'package.json': { name: 'solo' } })).toBeUndefined();
    expect(
      await dirsOf(
        { 'package.json': { name: 'solo', workspaces: ['a'] } },
        { tool: 'pnpm' },
      ),
    ).toBeUndefined();
    expect(
      await dirsOf(
        {
          'package.json': { name: 'solo' },
          'pnpm-workspace.yaml': 'packages: [a]\n',
        },
        { tool: 'npm' },
      ),
    ).toBeUndefined();
    expect(await dirsOf({})).toBeUndefined();
  });

  it('reads package.json workspaces as npm does, the root a member that is not matched by a pattern', async () => {
    const found = await dirsOf(
      npm(['packages/*'], {
        'packages/a/package.json': { name: 'a' },
        'packages/b/package.json': { name: 'b' },
        'other/c/package.json': { name: 'c' },
      }),
    );
    expect(found).toEqual(['', 'packages/a', 'packages/b']);
  });

  it('reads the object form of workspaces', async () => {
    expect(
      await dirsOf({
        'package.json': {
          name: 'r',
          workspaces: { packages: ['p/*'], nohoist: ['**'] },
        },
        'p/a/package.json': { name: 'a' },
      }),
    ).toEqual(['', 'p/a']);
  });

  it('reads pnpm-workspace.yaml as pnpm does, and prefers it when both are there', async () => {
    const root = await scratch({
      'package.json': { name: 'r', workspaces: ['npm/*'] },
      'pnpm-workspace.yaml': 'packages:\n  - "pn/*"\n',
      'pn/a/package.json': { name: 'a' },
      'npm/b/package.json': { name: 'b' },
    });
    const found = await discoverWorkspace(root);
    expect(found?.tool).toBe('pnpm');
    expect(found?.declaredIn).toBe('pnpm-workspace.yaml');
    expect(found?.members.map((m) => m.dir)).toEqual(['', 'pn/a']);
    expect(found?.notes.join()).toMatch(
      /package\.json also declares workspaces/u,
    );
    const asNpm = await discoverWorkspace(root, { tool: 'npm' });
    expect(asNpm?.members.map((m) => m.dir)).toEqual(['', 'npm/b']);
  });

  it('is the root alone for a pnpm file with no packages, as pnpm defaults it', async () => {
    expect(
      await dirsOf({
        'package.json': { name: 'r' },
        'pnpm-workspace.yaml': 'allowBuilds:\n  esbuild: true\n',
      }),
    ).toEqual(['']);
    expect(
      await dirsOf({
        'package.json': { name: 'r' },
        'pnpm-workspace.yaml': '',
      }),
    ).toEqual(['']);
  });

  it('has no root member when a pnpm root has no package.json', async () => {
    expect(
      await dirsOf({
        'pnpm-workspace.yaml': 'packages: ["p/*"]\n',
        'p/a/package.json': { name: 'a' },
      }),
    ).toEqual(['p/a']);
  });

  it('reads linkWorkspacePackages and derives the policy from the tool', async () => {
    const root = await scratch({
      'package.json': { name: 'r' },
      'pnpm-workspace.yaml': 'packages: []\nlinkWorkspacePackages: true\n',
    });
    const on = await discoverWorkspace(root);
    expect(on?.linkWorkspacePackages).toBe(true);
    expect(linkPolicyOf(on!)).toBe('satisfied-range');
    const off = await discoverWorkspace(
      await scratch({
        'package.json': { name: 'r' },
        'pnpm-workspace.yaml': 'packages: []\n',
      }),
    );
    expect(linkPolicyOf(off!)).toBe('workspace-protocol');
    const viaNpm = await discoverWorkspace(await scratch(npm([])));
    expect(linkPolicyOf(viaNpm!)).toBe('satisfied-range');
    expect(graphOfWorkspace(off!).linkPolicy).toBe('workspace-protocol');
    expect(graphOfWorkspace(off!, 'satisfied-range').linkPolicy).toBe(
      'satisfied-range',
    );
  });
});

describe('what it skips and what it finds', () => {
  it('skips node_modules whatever the pattern, and names without a manifest', async () => {
    expect(
      await dirsOf(
        npm(['**'], {
          'a/package.json': { name: 'a' },
          'node_modules/x/package.json': { name: 'x' },
          'a/node_modules/y/package.json': { name: 'y' },
          'empty/inner/package.json': { name: 'inner' },
          'bare/readme.md': 'text',
        }),
      ),
    ).toEqual(['', 'a', 'empty/inner']);
  });

  it('does not let a wildcard match a hidden directory, but a literal one can', async () => {
    const files = {
      '.hid/package.json': { name: 'hid' },
      'a/package.json': { name: 'a' },
    };
    expect(await dirsOf(npm(['*'], files))).toEqual(['', 'a']);
    expect(await dirsOf(npm(['.hid', 'a'], files))).toEqual(['', '.hid', 'a']);
  });

  it('applies ! after the patterns it removes from, the way each tool does', async () => {
    const files = {
      'p/a/package.json': { name: 'a' },
      'p/b/package.json': { name: 'b' },
      'p/b/sub/package.json': { name: 'sub' },
    };
    expect(await dirsOf(npm(['p/**', '!p/b'], files))).toEqual([
      '',
      'p/a',
      'p/b/sub',
    ]);
    expect(await dirsOf(pnpm('  - "p/**"\n  - "!p/b"\n', files))).toEqual([
      '',
      'p/a',
      'p/b/sub',
    ]);
    // npm lifts a ! when a later pattern is itself matched by it; pnpm never does.
    const lifted = ['p/**', '!p/b/**', 'p/b/sub'];
    expect(await dirsOf(npm(lifted, files))).toEqual([
      '',
      'p/a',
      'p/b',
      'p/b/sub',
    ]);
    expect(
      await dirsOf(pnpm('  - "p/**"\n  - "!p/b/**"\n  - "p/b/sub"\n', files)),
    ).toEqual(['', 'p/a']);
  });

  it('names a nameless member for its directory under npm, and leaves it nameless under pnpm', async () => {
    const files = { 'p/a/package.json': {}, 'p/@s/b/package.json': {} };
    const asNpm = await discoverWorkspace(await scratch(npm(['p/**'], files)));
    expect(asNpm?.members.map((m) => m.name)).toEqual(['root', '@s/b', 'a']);
    const asPnpm = await discoverWorkspace(
      await scratch(pnpm('  - "p/**"\n', files)),
    );
    expect(asPnpm?.members.map((m) => m.name)).toEqual([
      'root',
      undefined,
      undefined,
    ]);
  });

  it('lists members in one order whatever order the file system gives', async () => {
    const files: Files = {};
    for (const name of ['z', 'B', 'a', '10', '9', 'é'])
      files[`p/${name}/package.json`] = {
        name: `m${name === 'é' ? 'e' : name}`,
      };
    const found = await dirsOf(npm(['p/*'], files));
    expect(found).toEqual(['', 'p/10', 'p/9', 'p/B', 'p/a', 'p/z', 'p/é']);
  });

  it('is not troubled by a member that is itself a workspace root', async () => {
    const found = await dirsOf(
      pnpm('  - "ext"\n  - "ext/packages/*"\n', {
        'ext/package.json': { name: 'ext', workspaces: ['packages/*'] },
        'ext/packages/a/package.json': { name: 'ext-a' },
      }),
    );
    expect(found).toEqual(['', 'ext', 'ext/packages/a']);
  });
});
