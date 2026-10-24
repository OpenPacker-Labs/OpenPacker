/**
 * What the twin search reads and merges depends on a directory's path as it
 * folds, not as the patch spells it (ADR 0057 §9): `Big`, `BIG` and `big` lead
 * to the same directories of the package, so they are found and their names
 * merged once. Each spelling merged them again before, which a patch could
 * turn into memory: one 60,000-file directory reached in 60 spellings held
 * 670 MB (reviewer, round 4, finding 6). The cost is pinned exactly here,
 * by calling the check on the tree a patch leaves.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { PatchBudget } from './apply.js';
import { caseCollision, FOLLOW_UNITS } from './case-collision.js';
import { packageWith, removePackages } from './case-collision-fixture.js';
import { LSTAT_UNITS, type PatchNode } from './tree.js';

afterEach(removePackages);

const FILE: PatchNode = {
  kind: 'file',
  bytes: Buffer.from('new\n'),
  mode: 0o644,
};

/** The budget the check spends on a package of `files` when a patch creates `created`. */
async function spent(
  files: Record<string, string>,
  created: readonly string[],
): Promise<number> {
  const root = await packageWith(files);
  const budget = new PatchBudget();
  const outcome = await caseCollision(
    root,
    new Map(),
    new Map(created.map((path) => [path, FILE])),
    budget,
  );
  expect(outcome).toBeUndefined();
  return budget.spent;
}

describe('the directories a created file is looked for in', () => {
  const ten = Object.fromEntries(
    Array.from({ length: 10 }, (_, i) => [`big/f${i}.js`, 'x\n']),
  );

  it('are found and merged once for every spelling of one directory', async () => {
    // The root is listed once ("big", 4), big/ once (ten names of 5, 6 each),
    // big is followed once from the root (64 + 3), and its ten names merged
    // once (64 + 5 each), whichever of Big, BIG and big the patch spells.
    const once =
      LSTAT_UNITS +
      4 +
      LSTAT_UNITS +
      60 +
      (FOLLOW_UNITS + 3) +
      10 * (FOLLOW_UNITS + 5);
    expect(await spent(ten, ['big/c.js'])).toBe(once);
    expect(await spent(ten, ['BIG/a.js', 'Big/b.js', 'big/c.js'])).toBe(once);
  });

  it('are followed once for a parent two files share, below two directories of it', async () => {
    // lib/a/n.js and lib/b/m.js: the root, lib, lib/a and lib/b are listed
    // once each (names "lib" 4, "a" and "b" 2 each, "x.js" and "y.js" 5
    // each), lib is followed once (64 + 3), a and b once each (64 + 1), and
    // the one name below each is merged (64 + 4).
    const exact =
      4 * LSTAT_UNITS +
      (4 + 2 + 2 + 5 + 5) +
      (FOLLOW_UNITS + 3) +
      2 * (FOLLOW_UNITS + 1) +
      2 * (FOLLOW_UNITS + 4);
    expect(
      await spent({ 'lib/a/x.js': 'x\n', 'lib/b/y.js': 'y\n' }, [
        'lib/a/n.js',
        'lib/b/m.js',
      ]),
    ).toBe(exact);
  });

  it('are followed once for an ancestor the patch spells two ways, below two directories of it', async () => {
    // Big/x/a.js and BIG/y/b.js: big is followed once from the root (64 + 3)
    // although it is spelled two ways, x and y once each (64 + 1), and the
    // listings and merged names are those of the test above.
    const exact =
      4 * LSTAT_UNITS +
      (4 + 2 + 2 + 5 + 5) +
      (FOLLOW_UNITS + 3) +
      2 * (FOLLOW_UNITS + 1) +
      2 * (FOLLOW_UNITS + 4);
    expect(
      await spent({ 'big/x/f.js': 'x\n', 'big/y/g.js': 'y\n' }, [
        'Big/x/a.js',
        'BIG/y/b.js',
      ]),
    ).toBe(exact);
  });
});
