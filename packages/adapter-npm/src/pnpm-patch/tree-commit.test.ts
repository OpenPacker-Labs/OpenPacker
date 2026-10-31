/**
 * A patched copy is written in the store, beside the entry it was copied
 * from, and what the patch changed is written through the handle of each
 * file's directory (ADR 0034, ADR 0057): a directory of the copy swapped for
 * a link between the read and the write is refused, and nothing is removed or
 * written where the link points.
 */

import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PatchEffect } from './parse.js';
import { commitPatchTree, loadPatchTree } from './tree.js';

const POSIX = process.platform === 'linux' || process.platform === 'darwin';
const REFUSED = /^(ENOTDIR|ELOOP|UNSAFE_PATH)$/u;

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

/** What a patch says of `path` for the tree to read it: a change. */
const patched = (path: string): PatchEffect => ({
  type: 'patch',
  path,
  hunks: [],
  beforeHash: null,
  afterHash: null,
});

/** What a patch says of `path` for the tree to read it: a removal, or a new file. */
const deleted = (
  path: string,
  type: 'file deletion' | 'file creation' = 'file deletion',
): PatchEffect => ({ type, path, mode: 0o644, hash: null, hunk: null });
const created = (path: string): PatchEffect => deleted(path, 'file creation');

describe.runIf(POSIX)('a patched copy written back', () => {
  it('removes and writes nothing through a directory swapped for a link after it was read', async () => {
    const base = await mkdtemp(join(await realpath(tmpdir()), 'patch-commit-'));
    temps.push(base);
    const root = join(base, 'package');
    await mkdir(join(root, 'lib'), { recursive: true });
    await writeFile(join(root, 'lib', 'a.js'), 'a');
    await writeFile(join(root, 'lib', 'b.js'), 'b');
    const victim = join(base, 'victim');
    await mkdir(victim);
    await writeFile(join(victim, 'a.js'), 'theirs');
    await writeFile(join(victim, 'b.js'), 'theirs');
    const effects: PatchEffect[] = [patched('lib/a.js'), deleted('lib/b.js')];

    const tree = await loadPatchTree(root, effects);
    const before = new Map(tree.nodes);
    tree.write('lib/a.js', 'patched', 0o644);
    tree.unlink('lib/b.js');
    // The copy's directory replaced by a link while the patch was applied.
    await rename(join(root, 'lib'), join(base, 'lib-was'));
    await symlink(victim, join(root, 'lib'));

    await expect(commitPatchTree(root, before, tree)).rejects.toMatchObject({
      code: expect.stringMatching(REFUSED),
    });
    expect((await readdir(victim)).sort()).toEqual(['a.js', 'b.js']);
    expect(await readFile(join(victim, 'a.js'), 'utf8')).toBe('theirs');
  });

  it('writes the change through the handles when nothing was swapped', async () => {
    const base = await mkdtemp(join(await realpath(tmpdir()), 'patch-commit-'));
    temps.push(base);
    const root = join(base, 'package');
    await mkdir(join(root, 'lib'), { recursive: true });
    await writeFile(join(root, 'lib', 'a.js'), 'a');
    await writeFile(join(root, 'lib', 'b.js'), 'b');
    const effects: PatchEffect[] = [
      patched('lib/a.js'),
      deleted('lib/b.js'),
      created('lib/new/c.js'),
    ];

    const tree = await loadPatchTree(root, effects);
    const before = new Map(tree.nodes);
    tree.write('lib/a.js', 'patched', 0o644);
    tree.unlink('lib/b.js');
    tree.write('lib/new/c.js', 'c', 0o755);
    await commitPatchTree(root, before, tree);

    expect((await readdir(join(root, 'lib'))).sort()).toEqual(['a.js', 'new']);
    expect(await readFile(join(root, 'lib', 'a.js'), 'utf8')).toBe('patched');
    expect(await readFile(join(root, 'lib', 'new', 'c.js'), 'utf8')).toBe('c');
  });
});
