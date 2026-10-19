/**
 * The twin search follows each case variant of a directory once per parent and
 * charges every step (ADR 0056 §9): a hostile package that holds a directory
 * in every case of one name cannot make a patch's creations cost more CPU than
 * the budget counts.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PatchBudget } from './apply.js';
import { FOLLOW_UNITS } from './case-collision.js';
import {
  apply,
  create,
  packageWith,
  patchOf,
  removePackages,
} from './case-collision-fixture.js';
import { applyPnpmPatch } from './index.js';
import { LSTAT_UNITS } from './tree.js';

afterEach(removePackages);

describe('a package that holds a directory in every case of one name', () => {
  /** `count` spellings of `abcdef` by case. */
  const spellings = (count: number) =>
    Array.from({ length: count }, (_, k) =>
      [...'abcdef']
        .map((c, i) => ((k >> i) & 1 ? c.toUpperCase() : c))
        .join(''),
    );
  const files = (count: number, variants: boolean) => {
    const out: Record<string, string> = {};
    for (const a of variants ? spellings(count) : ['abcdef'])
      for (const b of variants ? spellings(count) : ['abcdef'])
        out[`${a}/${b}/f.js`] = 'x\n';
    return out;
  };
  const spentCreating = async (variants: boolean, created: number) => {
    const text = Array.from({ length: created }, (_, i) =>
      create(`ABCDEF/ABCDEF/new${i}.js`),
    ).join('');
    const budget = new PatchBudget();
    await applyPnpmPatch(
      await packageWith(files(20, variants)),
      patchOf(text),
      'x@1.0.0',
      budget,
    );
    return budget.spent;
  };

  it('is followed once, however many files are created below it: the cost of each file is the same with 400 directories as with one', async () => {
    // 20 spellings at two levels: 400 leaf directories. Walking them for each
    // file created would add a few thousand units to every file; followed
    // once, each file costs what it costs beside one directory.
    const slope = async (variants: boolean) =>
      ((await spentCreating(variants, 1_000)) -
        (await spentCreating(variants, 10))) /
      990;
    const fanned = await slope(true);
    const plain = await slope(false);
    expect(Math.abs(fanned - plain)).toBeLessThan(plain / 10);
    // And the 400 are followed, once, and every step is charged. Against one
    // directory at each level: 418 more listings, 4,921 more characters of
    // names (the root's 20, 20 listings of 20 and 400 of `f.js`, less 19), 19
    // more directories followed (each the segment, 6, and 64) and 399 more
    // names merged (`f.js`, 4, and 64).
    const once =
      (await spentCreating(true, 10)) - (await spentCreating(false, 10));
    expect(once).toBe(
      418 * LSTAT_UNITS +
        4_921 +
        19 * (FOLLOW_UNITS + 6) +
        399 * (FOLLOW_UNITS + 4),
    );
  }, 120_000);

  it('is refused as too costly when following it is what overruns the budget', async () => {
    const dir = await packageWith(files(20, true));
    const outcome = await applyPnpmPatch(
      dir,
      patchOf(create('ABCDEF/ABCDEF/new.js')),
      'x@1.0.0',
      new PatchBudget(400_000),
    ).then(
      () => 'applied',
      (error: unknown) => error,
    );
    expect(outcome).toMatchObject({
      code: 'PATCH_FAILED',
      message: expect.stringContaining('too costly'),
    });
  });
});

describe('a path whose first segment folds to a file of the package', () => {
  it('is taken: a file is not a directory to look in', async () => {
    const dir = await packageWith({ lib: 'a file\n' });
    expect(await apply(dir, create('LIB/x.js'))).toBe('applied');
    expect(await readFile(join(dir, 'LIB/x.js'), 'utf8')).toBe('new\n');
  });
});
