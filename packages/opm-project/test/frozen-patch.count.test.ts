import { readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { patchedStoreKey } from '../src/frozen-patch.js';
import {
  cleanStores,
  DIGEST,
  PATCH,
  publish,
  store,
} from './frozen-patch-fixture.js';

afterEach(cleanStores);

/**
 * The files of a patched entry are held to the files an archive may hold, as
 * the files of the archive it was made from were (ADR 0056 §13): the patch's
 * own paths and their directories are counted at --plan, and this counts the
 * entry once the patch is applied, because a package at the limit and a patch
 * that adds files to it came to twice the limit. The unpatched entry here has
 * two files (package.json, index.js).
 */

/** A format that adds `added` files and removes `removed` of the entry's own. */
function changing(added: number, removed = 0) {
  return {
    async applyFrozenPatch(dir: string): Promise<void> {
      for (let index = 0; index < added; index += 1)
        await writeFile(join(dir, `added${index}.js`), 'new\n');
      if (removed > 0) await rm(join(dir, 'index.js'));
    },
  };
}

const entryOf = (root: string) =>
  join(root, patchedStoreKey(DIGEST, PATCH.digest));

describe('the files of a patched entry', () => {
  it('may come to the limit: two files and three added are five', async () => {
    const root = await store();
    await publish(root, changing(3), undefined, 5);
    expect(await readdir(join(entryOf(root), 'package'))).toHaveLength(5);
  });

  it('may not come to one past it, and nothing is published or left behind', async () => {
    const root = await store();
    const outcome = await publish(root, changing(4), undefined, 5).then(
      () => 'published',
      (error: unknown) => error,
    );
    expect(outcome).toMatchObject({
      code: 'SIZE_LIMIT',
      message: expect.stringContaining(
        'would hold more than the 5 files a package may hold',
      ),
    });
    expect(
      (await readdir(root)).filter((name) => name.includes('-patch-')),
    ).toEqual([]);
    expect(
      (await readdir(root)).filter((name) => name.includes('.materialize-')),
    ).toEqual([]);
  });

  it('count the files the patch removes: one removed, four added, is five', async () => {
    const root = await store();
    await publish(root, changing(4, 1), undefined, 5);
    expect(await readdir(join(entryOf(root), 'package'))).toHaveLength(5);
  });

  it('count the files below a directory, not only the top', async () => {
    const root = await store();
    const deep = {
      async applyFrozenPatch(dir: string): Promise<void> {
        const { mkdir } = await import('node:fs/promises');
        await mkdir(join(dir, 'a/b'), { recursive: true });
        await writeFile(join(dir, 'a/b/one.js'), '1');
        await writeFile(join(dir, 'a/two.js'), '2');
        await writeFile(join(dir, 'three.js'), '3');
      },
    };
    await expect(publish(root, deep, undefined, 4)).rejects.toMatchObject({
      code: 'SIZE_LIMIT',
      message: expect.stringContaining('more than the 4 files'),
    });
  });
});
