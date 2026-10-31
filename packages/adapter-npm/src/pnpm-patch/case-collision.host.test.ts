/**
 * On a case-insensitive or normalizing host (macOS by default, Windows, ext4
 * with casefold) `lstat` of `lib/X.js` finds `lib/x.js`, so the tree a patch is
 * applied to says the file it creates is there already, and pnpm's rule (a new
 * file whose path exists replaces it) would write over the twin, silently,
 * where extracting an archive that held both fails on its exclusive create
 * (ADR 0057 §13). Two guards close it: a file the patch creates over one the
 * tree found must be listed under exactly that name in its directory, or it is
 * the twin of another; and a file the tree found absent is created
 * exclusively, so a twin that is there after all is a refusal and not a write.
 *
 * Linux, where these run, does not fold: the host's answer is given to the
 * check as the tree's `before`, and the twin is planted between reading the
 * tree and writing it. No macOS or Windows runner is available here.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyEffects, PatchBudget } from './apply.js';
import { caseCollision } from './case-collision.js';
import {
  apply,
  create,
  packageWith,
  patchOf,
  removePackages,
} from './case-collision-fixture.js';
import { applyPnpmPatch, readPatchText } from './index.js';
import { commitPatchTree, loadPatchTree, type PatchNode } from './tree.js';

afterEach(removePackages);

const file = (text: string): PatchNode => ({
  kind: 'file',
  bytes: Buffer.from(text),
  mode: 0o644,
});

describe('a file a patch creates over one the tree found', () => {
  it('is the twin of another when its directory does not list it by that name, as a case-insensitive host answers', async () => {
    const root = await packageWith({ 'lib/x.js': 'old\n' });
    const outcome = await caseCollision(
      root,
      // What lstat("lib/X.js") gives where the file system folds case.
      new Map([['lib/X.js', file('old\n')]]),
      new Map([['lib/X.js', file('new\n')]]),
      new PatchBudget(),
      ['lib/X.js'],
    );
    expect(outcome).toEqual({ path: 'lib/X.js', other: 'lib/x.js' });
  });

  it('is not, and is replaced as pnpm replaces it, when the directory lists it by that name', async () => {
    const root = await packageWith({ 'lib/x.js': 'old\n' });
    expect(
      await caseCollision(
        root,
        new Map([['lib/x.js', file('old\n')]]),
        new Map([['lib/x.js', file('new\n')]]),
        new PatchBudget(),
        ['lib/x.js'],
      ),
    ).toBeUndefined();
    expect(await apply(root, create('lib/x.js'))).toBe('applied');
    expect(await readFile(join(root, 'lib/x.js'), 'utf8')).toBe('new\n');
  });
});

describe('applying a patch that creates a file over one the package has', () => {
  /** The budget spent replacing big/f0 in a big/ of `count` names. */
  async function spent(count: number): Promise<number> {
    const files: Record<string, string> = { 'big/f0': 'old\n' };
    for (let index = 1; index < count; index += 1) files[`big/f${index}`] = '';
    const budget = new PatchBudget();
    await applyPnpmPatch(
      await packageWith(files),
      patchOf(create('big/f0')),
      'x@1.0.0',
      budget,
    );
    return budget.spent;
  }

  it('lists the directory of the file to see the name as the patch spells it: 5,000 names cost that many characters more than 10', async () => {
    // About 5,000 names of 2 to 5 characters, and one each: 28,888.
    expect((await spent(5_000)) - (await spent(10))).toBeGreaterThan(25_000);
  });
});

describe('a file the tree found absent', () => {
  it('is created exclusively: a twin there after all is a CASE_COLLISION, and is not written over', async () => {
    const root = await packageWith({ 'lib/a.js': 'a\n' });
    const effects = readPatchText(create('lib/X.js'), 'p.patch');
    const budget = new PatchBudget();
    const tree = await loadPatchTree(root, effects, budget);
    const before = new Map(tree.nodes);
    expect(applyEffects(effects, tree, budget)).toBe(true);
    // Where the host folds, lib/x.js is lib/X.js; here it is planted by that name.
    await writeFile(join(root, 'lib', 'X.js'), 'planted\n');
    await expect(commitPatchTree(root, before, tree)).rejects.toMatchObject({
      code: 'CASE_COLLISION',
      message: expect.stringContaining('"lib/X.js"'),
    });
    expect(await readFile(join(root, 'lib', 'X.js'), 'utf8')).toBe('planted\n');
  });
});
