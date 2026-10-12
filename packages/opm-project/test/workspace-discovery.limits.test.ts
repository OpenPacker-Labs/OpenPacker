import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverWorkspace } from '../src/index.js';
import {
  cleanup,
  dirsOf,
  link,
  npm,
  pnpm,
  refusal,
  scratch,
  type Files,
} from './workspace-tree.js';

afterEach(cleanup);

describe('links', () => {
  it('refuses a member directory that is a symbolic link', async () => {
    const root = await scratch(
      npm(['p/*'], { 'real/package.json': { name: 'a' } }),
    );
    await link(root, 'p/a', '../real');
    await expect(discoverWorkspace(root)).rejects.toMatchObject({
      code: 'WORKSPACE_SYMLINK',
    });
    await expect(discoverWorkspace(root)).rejects.toThrowError(
      /p\/a is a symbolic link/u,
    );
  });

  it('refuses a link a pattern passes through by name, even to somewhere that holds members', async () => {
    const root = await scratch({
      ...npm(['p/*']),
      'elsewhere/a/package.json': { name: 'a' },
    });
    await link(root, 'p', 'elsewhere');
    await expect(discoverWorkspace(root)).rejects.toMatchObject({
      code: 'WORKSPACE_SYMLINK',
    });
  });

  it('does not follow a link to a directory outside the root', async () => {
    const outside = await scratch({ 'a/package.json': { name: 'escaped' } });
    const root = await scratch(npm(['p/*']));
    await link(root, 'p', outside);
    await expect(discoverWorkspace(root)).rejects.toMatchObject({
      code: 'WORKSPACE_SYMLINK',
    });
  });

  it('may be left out with a ! pattern', async () => {
    const root = await scratch(
      npm(['p/*', '!p/a'], {
        'real/package.json': { name: 'a' },
        'p/b/package.json': { name: 'b' },
      }),
    );
    await link(root, 'p/a', '../real');
    expect((await discoverWorkspace(root))?.members.map((m) => m.dir)).toEqual([
      '',
      'p/b',
    ]);
  });

  it('passes over a link met while a ** searches, and says so', async () => {
    const root = await scratch(
      npm(['p/**'], {
        'real/package.json': { name: 'a' },
        'p/b/package.json': { name: 'b' },
      }),
    );
    await link(root, 'p/deep/a', '../../real');
    const found = await discoverWorkspace(root);
    expect(found?.members.map((m) => m.dir)).toEqual(['', 'p/b']);
    expect(found?.skippedLinks).toEqual(['p/deep/a']);
  });

  it('refuses a package.json that is a link', async () => {
    const root = await scratch(npm(['p/*'], { 'real.json': { name: 'a' } }));
    await mkdir(join(root, 'p/a'), { recursive: true });
    await link(root, 'p/a/package.json', '../../real.json');
    await expect(discoverWorkspace(root)).rejects.toMatchObject({
      code: 'WORKSPACE_SYMLINK',
    });
    await expect(discoverWorkspace(root)).rejects.toThrowError(
      /p\/a\/package\.json is a symbolic link/u,
    );
  });

  it('refuses a root package.json that is a link', async () => {
    const root = await scratch({
      'real.json': { name: 'r', workspaces: ['p'] },
    });
    await link(root, 'package.json', 'real.json');
    await expect(discoverWorkspace(root)).rejects.toMatchObject({
      code: 'WORKSPACE_SYMLINK',
    });
  });

  it('refuses a link to a file where a pattern names a member', async () => {
    for (const workspaces of [['p/*'], ['p/a']]) {
      const root = await scratch(npm(workspaces, { 'notes.txt': 'x' }));
      await link(root, 'p/a', '../notes.txt');
      await expect(discoverWorkspace(root)).rejects.toMatchObject({
        code: 'WORKSPACE_SYMLINK',
        subjects: ['p/a'],
      });
      await expect(discoverWorkspace(root)).rejects.toThrowError(
        /p\/a is a symbolic link/u,
      );
    }
  });

  it('ignores a link to a file where it is not a pattern match', async () => {
    const root = await scratch(
      npm(['p/*'], { 'p/a/package.json': { name: 'a' }, 'notes.txt': 'x' }),
    );
    await link(root, 'README', 'notes.txt');
    expect((await discoverWorkspace(root))?.members.map((m) => m.dir)).toEqual([
      '',
      'p/a',
    ]);
  });
});

describe('a directory name no handle can take', () => {
  // Windows does not allow a backslash in a name; there it is a separator.
  it.skipIf(process.platform === 'win32')(
    'is refused as a typed workspace error that names the directory',
    async () => {
      const root = await scratch(
        npm(['p/*'], { 'p/a\\b/package.json': { name: 'a' } }),
      );
      await expect(discoverWorkspace(root)).rejects.toMatchObject({
        name: 'WorkspaceError',
        code: 'WORKSPACE_PATH_UNSAFE',
        subjects: ['p/a\\b'],
      });
    },
  );
});

describe('bounds', () => {
  const many = (count: number): Files => {
    const files: Files = {};
    for (let at = 0; at < count; at += 1)
      files[`p/m${at}/package.json`] = { name: `m${at}` };
    return files;
  };

  it('refuses more members than the limit', async () => {
    const error = await refusal(npm(['p/*'], many(5)), {
      limits: { maxMembers: 4 },
    });
    expect(error.code).toBe('WORKSPACE_LIMIT_EXCEEDED');
    expect(error.message).toMatch(/more than 4 members/u);
    expect(
      await dirsOf(npm(['p/*'], many(5)), { limits: { maxMembers: 6 } }),
    ).toHaveLength(6);
  });

  it('refuses reading more directory entries than the limit', async () => {
    const error = await refusal(npm(['p/*'], many(30)), {
      limits: { maxDirectoryEntries: 20 },
    });
    expect(error.code).toBe('WORKSPACE_LIMIT_EXCEEDED');
    expect(error.message).toMatch(/more than 20 directory entries/u);
  });

  it('refuses a directory deeper than the limit', async () => {
    const files = npm(['**'], { 'a/b/c/d/package.json': { name: 'deep' } });
    const error = await refusal(files, { limits: { maxDepth: 3 } });
    expect(error.code).toBe('WORKSPACE_LIMIT_EXCEEDED');
    expect(error.message).toMatch(
      /a\/b\/c\/d is 4 directories below the workspace root, more than the limit of 3/u,
    );
    expect(await dirsOf(files, { limits: { maxDepth: 4 } })).toEqual([
      '',
      'a/b/c/d',
    ]);
  });

  it('refuses a package.json larger than the limit, without reading it whole', async () => {
    const huge = JSON.stringify({ name: 'a', description: 'x'.repeat(2000) });
    const error = await refusal(npm(['p/*'], { 'p/a/package.json': huge }), {
      limits: { maxManifestBytes: 1000 },
    });
    expect(error.code).toBe('WORKSPACE_LIMIT_EXCEEDED');
    expect(error.message).toMatch(
      /p\/a\/package\.json is \d+ bytes, more than the limit of 1000/u,
    );
  });

  it('refuses manifests that together hold more than the limit', async () => {
    const error = await refusal(npm(['p/*'], many(6)), {
      limits: { maxTotalManifestBytes: 40 },
    });
    expect(error.code).toBe('WORKSPACE_LIMIT_EXCEEDED');
    expect(error.message).toMatch(/add up to more than 40 bytes/u);
  });

  it('refuses a YAML file that expands through aliases into something huge', async () => {
    const lines = ['l0: &l0 [x, x, x, x, x, x, x, x, x, x]'];
    for (let level = 1; level < 12; level += 1)
      lines.push(
        `l${level}: &l${level} [${Array.from({ length: 10 }, () => `*l${level - 1}`).join(', ')}]`,
      );
    const error = await refusal({
      'package.json': { name: 'r' },
      'pnpm-workspace.yaml': `${lines.join('\n')}\n`,
    });
    expect(error.code).toBe('WORKSPACE_DECLARATION_INVALID');
  });

  it('refuses a pnpm-workspace.yaml larger than the limit', async () => {
    const error = await refusal(
      {
        'package.json': { name: 'r' },
        'pnpm-workspace.yaml': `packages: []\n# ${'x'.repeat(500)}\n`,
      },
      { limits: { maxDeclarationBytes: 100 } },
    );
    expect(error.code).toBe('WORKSPACE_LIMIT_EXCEEDED');
  });

  it('refuses more patterns than the limit', async () => {
    const patterns = Array.from({ length: 5 }, (_, at) => `p${at}`);
    expect(
      (await refusal(npm(patterns), { limits: { maxPatterns: 4 } })).code,
    ).toBe('WORKSPACE_LIMIT_EXCEEDED');
    const yaml = `packages:\n${patterns.map((p) => `  - ${p}\n`).join('')}`;
    expect(
      (await refusal(pnpm(yaml.slice(10)), { limits: { maxPatterns: 4 } }))
        .code,
    ).toBe('WORKSPACE_LIMIT_EXCEEDED');
  });

  it('refuses a dependency list longer than the limit', async () => {
    const dependencies = Object.fromEntries(
      Array.from({ length: 6 }, (_, at) => [`d${at}`, '1']),
    );
    const error = await refusal(
      npm(['p/*'], { 'p/a/package.json': { name: 'a', dependencies } }),
      {
        limits: { maxDependencyEntries: 5 },
      },
    );
    expect(error.code).toBe('WORKSPACE_LIMIT_EXCEEDED');
  });

  it('refuses a limit that is not sensible', async () => {
    await expect(
      discoverWorkspace(await scratch(npm([])), { limits: { maxMembers: 0 } }),
    ).rejects.toMatchObject({
      code: 'WORKSPACE_LIMIT_EXCEEDED',
    });
  });

  it('counts the directories and entries it read', async () => {
    const found = await discoverWorkspace(await scratch(npm(['p/*'], many(3))));
    expect(found?.stats.directoriesRead).toBe(2);
    expect(found?.stats.entriesRead).toBeGreaterThanOrEqual(5);
  });
});
