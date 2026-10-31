/**
 * The files a patch creates are held to the archive's CASE_COLLISION rule
 * against the files of the package (ADR 0057 §13). A patch that created
 * `lib/X.js` beside the package's `lib/x.js` applied, and the entry it made
 * held a pair that an archive refuses and one case-insensitive file system
 * would make one file (the second written over the first). The key is the
 * archive's own (`collisionKey` in adapter-core, which the materializer's
 * `validateEntries` uses): the whole path lowercased. Two names that differ
 * only in Unicode normalization (NFC beside NFD) have two keys, in an archive
 * and so here; the test says what the archive does and holds the patch to it.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { collisionKey } from '@openpacker/adapter-core';
import { inspectArchive } from '@openpacker/materializer';
import { afterEach, describe, expect, it } from 'vitest';
import { PatchBudget } from './apply.js';
import {
  apply,
  collision,
  create,
  packageWith,
  patchOf,
  remove,
  removePackages,
  rename,
} from './case-collision-fixture.js';
import { applyPnpmPatch } from './index.js';
import { readTree } from './tree-fixture.js';
import { LSTAT_UNITS } from './tree.js';

afterEach(removePackages);

const NFC = 'lib/é.js';
const NFD = 'lib/é.js';

/** A tar of the named files, to ask the archive rule. */
function tar(names: readonly string[]): Uint8Array {
  const blocks: Buffer[] = [];
  for (const name of names) {
    const header = Buffer.alloc(512);
    header.write(name, 0, 'utf8');
    header.write('0000644\0', 100);
    header.write('0000000\0', 108);
    header.write('0000000\0', 116);
    header.write('00000000001\0', 124);
    header.write('00000000000\0', 136);
    header.write('        ', 148);
    header.write('0', 156);
    header.write('ustar\0', 257);
    header.write('00', 263);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    blocks.push(header, Buffer.concat([Buffer.from('x'), Buffer.alloc(511)]));
  }
  blocks.push(Buffer.alloc(1024));
  return new Uint8Array(Buffer.concat(blocks));
}
const archiveRefuses = (...names: string[]) =>
  inspectArchive(tar(names.map((name) => `package/${name}`)), 'tar').then(
    () => undefined,
    (error: { code?: string }) => error.code,
  );

describe('the archive rule these tests hold the patch to', () => {
  it('refuses two entries that differ in case, and takes two that differ in normalization or in a directory', async () => {
    expect(await archiveRefuses('lib/x.js', 'lib/X.js')).toBe('CASE_COLLISION');
    expect(await archiveRefuses('lib/x.js', 'Lib/x.js')).toBe('CASE_COLLISION');
    expect(await archiveRefuses(NFC, NFD)).toBeUndefined();
    expect(await archiveRefuses('lib/a.js', 'Lib/b.js')).toBeUndefined();
  });
});

describe('the key the archive and the patch share', () => {
  it.each([
    ['lib/x.js', 'lib/X.js'],
    ['lib/straße.js', 'lib/STRASSE.js'],
    ['lib/\u0130.js', 'lib/i\u0307.js'],
    ['lib/\u03a3.js', 'lib/\u03c3.js'],
    ['lib/\u03c2.js', 'lib/\u03c3.js'],
    [NFC, NFD],
    ['a/B', 'A/b'],
  ])(
    'gives %j and %j one key exactly when the archive refuses the pair',
    async (a, b) => {
      const refused = (await archiveRefuses(a, b)) === 'CASE_COLLISION';
      expect(collisionKey(a) === collisionKey(b)).toBe(refused);
    },
  );
});

describe('a patch that creates a file beside one that differs in case', () => {
  it('is refused as CASE_COLLISION, naming both, and the package is left as it was', async () => {
    const dir = await packageWith({ 'lib/x.js': 'old\n', 'lib/y.js': 'y\n' });
    const before = await readTree(dir);
    expect(await apply(dir, create('lib/X.js'))).toMatchObject(
      collision('lib/X.js', 'lib/x.js'),
    );
    expect(await readTree(dir)).toEqual(before);
  });

  it('is refused when the directory differs in case: Lib/x.js beside lib/x.js', async () => {
    const dir = await packageWith({ 'lib/x.js': 'old\n' });
    expect(await apply(dir, create('Lib/x.js'))).toMatchObject(
      collision('Lib/x.js', 'lib/x.js'),
    );
    expect(await readdir(dir)).toEqual(['lib']);
  });

  it('is refused for a file beside a directory of another case', async () => {
    const dir = await packageWith({ 'lib/x.js': 'old\n' });
    expect(await apply(dir, create('LIB'))).toMatchObject(
      collision('LIB', 'lib'),
    );
  });

  it('is refused when the patch creates both spellings', async () => {
    const dir = await packageWith({ 'package.json': '{}' });
    expect(
      await apply(dir, create('lib/A.js') + create('lib/a.js')),
    ).toMatchObject(expect.objectContaining({ code: 'CASE_COLLISION' }));
    expect(await readdir(dir)).toEqual(['package.json']);
  });

  it('is refused when a rename lands on the case variant of a file that stays', async () => {
    const dir = await packageWith({ 'lib/x.js': 'old\n', 'lib/b.js': 'b\n' });
    expect(await apply(dir, rename('lib/b.js', 'lib/X.js'))).toMatchObject(
      collision('lib/X.js', 'lib/x.js'),
    );
    expect(await readFile(join(dir, 'lib/b.js'), 'utf8')).toBe('b\n');
  });

  it('is taken when the file it differs from is deleted by the same patch, in either order', async () => {
    for (const text of [
      remove('lib/x.js') + create('lib/X.js'),
      create('lib/X.js') + remove('lib/x.js'),
    ]) {
      const dir = await packageWith({ 'lib/x.js': 'old\n' });
      expect(await apply(dir, text)).toBe('applied');
      expect(await readdir(join(dir, 'lib'))).toEqual(['X.js']);
    }
  });

  it('is taken as a rename that only changes case', async () => {
    const dir = await packageWith({ 'lib/a.js': 'old\n' });
    expect(await apply(dir, rename('lib/a.js', 'lib/A.js'))).toBe('applied');
    expect(await readdir(join(dir, 'lib'))).toEqual(['A.js']);
  });

  it('is taken when the patch creates a file and deletes the same path: nothing is left to collide', async () => {
    const dir = await packageWith({ 'lib/N.js': 'old\n' });
    expect(await apply(dir, create('lib/n.js') + remove('lib/n.js'))).toBe(
      'applied',
    );
    expect(await readdir(join(dir, 'lib'))).toEqual(['N.js']);
  });
});

describe('a patch that creates a file that no archive would refuse beside the package', () => {
  it('takes a name that merely starts like another, and a case variant in another directory name', async () => {
    const dir = await packageWith({
      'lib/y.js': 'y\n',
      'Lib/q.js': 'q\n',
      'lib/xx.js': 'xx\n',
    });
    expect(await apply(dir, create('lib/z.js') + create('lib/x.js'))).toBe(
      'applied',
    );
  });

  it('takes a file in a directory the package does not have', async () => {
    const dir = await packageWith({ 'package.json': '{}' });
    expect(await apply(dir, create('fresh/deep/A.js'))).toBe('applied');
    expect(await readFile(join(dir, 'fresh/deep/A.js'), 'utf8')).toBe('new\n');
  });

  it('takes an NFD name beside an NFC one, as an archive does', async () => {
    const dir = await packageWith({ [NFC]: 'old\n' });
    expect(await apply(dir, create(NFD))).toBe('applied');
    expect((await readdir(join(dir, 'lib'))).sort()).toEqual(
      ['é.js', 'é.js'].sort(),
    );
  });
});

describe('the directories read to look', () => {
  /** A package with `big/` of `count` names, and the work budget a patch spends there. */
  async function spent(count: number, text: string): Promise<number> {
    const files: Record<string, string> = { 'big/f0': 'old\n' };
    for (let index = 1; index < count; index += 1) files[`big/f${index}`] = '';
    const budget = new PatchBudget();
    await applyPnpmPatch(
      await packageWith(files),
      patchOf(text),
      'x@1.0.0',
      budget,
    );
    return budget.spent;
  }
  const change = [
    'diff --git a/big/f0 b/big/f0',
    '--- a/big/f0',
    '+++ b/big/f0',
    '@@ -1 +1 @@',
    '-old',
    '+new',
    '',
  ].join('\n');

  it('are charged by their names: a file created in a directory of 5,000 costs that many characters more than in one of 10', async () => {
    const small = await spent(10, create('big/new.js'));
    const big = await spent(5_000, create('big/new.js'));
    // About 5,000 names of 2 to 5 characters, and one each: 28,888.
    expect(big - small).toBeGreaterThan(25_000);
  });

  it('cost a system call each, for the root and for big/, besides their names', async () => {
    const files = { 'big/f0': 'old\n', 'big/new.js': 'old\n' };
    const measure = async (text: string) => {
      const budget = new PatchBudget();
      await applyPnpmPatch(
        await packageWith(files),
        patchOf(text),
        'x@1.0.0',
        budget,
      );
      return budget.spent;
    };
    // `big/new.js` exists: the patch replaces it, so only big/ is listed, to
    // see the name is there as the patch spells it (a host that folds case
    // finds a twin by another name); the same file created where there is
    // none lists the root and big/ and merges what big/ holds.
    const replaces = await measure(create('big/new.js'));
    const created = await (async () => {
      const budget = new PatchBudget();
      await applyPnpmPatch(
        await packageWith({ 'big/f0': 'old\n', 'big/new.jx': 'old\n' }),
        patchOf(create('big/new.js')),
        'x@1.0.0',
        budget,
      );
      return budget.spent;
    })();
    expect(created - replaces).toBeGreaterThanOrEqual(LSTAT_UNITS);
  });

  it('are not read for a file the patch only changes', async () => {
    const small = await spent(10, change);
    const big = await spent(5_000, change);
    // The tree reads the one file and its directory; nothing lists the directory.
    expect(big - small).toBeLessThan(100);
  });

  it('are refused as too costly when the listing is what overruns the budget', async () => {
    const dir = await packageWith(
      Object.fromEntries(
        Array.from({ length: 5_000 }, (_, index) => [`big/f${index}`, '']),
      ),
    );
    const outcome = await applyPnpmPatch(
      dir,
      patchOf(create('big/new.js')),
      'x@1.0.0',
      new PatchBudget(8_000),
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
