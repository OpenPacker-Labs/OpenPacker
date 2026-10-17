import { mkdir, mkdtemp, readdir, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { materialiseTree } from '@openpacker/project-io';
import { storeViews } from '../src/store-view.js';

/**
 * A view is made in its store, by path, and bound through a handle. The handle
 * must be of the directory the entries were linked into: were the view swapped
 * for another directory meanwhile (by a process that can write the store), the
 * handle opened afterwards would bind that one, with whatever it holds.
 */

/** Run in turn, one before each entry is linked into a view. */
const swaps: ((view: string) => Promise<void>)[] = [];

/** The layout's own tree copy, after whatever swap is next. */
const linkTree: typeof materialiseTree = async (...args) => {
  await swaps.shift()?.(args[2]);
  return await materialiseTree(...args);
};

const temps: string[] = [];
afterEach(async () => {
  swaps.splice(0);
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function store() {
  const base = await mkdtemp(join(tmpdir(), 'opm-view-swap-'));
  temps.push(base);
  const root = join(base, 'store');
  const entries = [1, 2, 3].map((i) =>
    join(root, `sha256-${i.toString(16).padStart(64, '0')}`),
  );
  for (const entry of entries)
    await mkdir(join(entry, 'package'), { recursive: true });
  return { root, entries };
}

const views = async (root: string) =>
  (await readdir(root)).filter((name) => name.startsWith('.view-')).sort();

describe('a view swapped for another directory while it is made', () => {
  it('is refused, not bound', async () => {
    const { root, entries } = await store();
    swaps.push(async (view) => {
      await rename(view, `${view}-moved`);
      await mkdir(join(view, `sha256-${'f'.repeat(64)}`), { recursive: true });
    });
    // One handle for three entries: they are bound through a view.
    await expect(storeViews(entries, 1, linkTree)).rejects.toThrow(
      'changed while it was made',
    );
    // The run removes what holds its view's name; what the swap moved away
    // stays where the swap put it.
    expect(await views(root)).toEqual([
      expect.stringMatching(/^\.view-.*-moved$/u),
    ]);
  });

  it('is refused when it was swapped back before the end', async () => {
    const { root, entries } = await store();
    swaps.push(
      async (view) => {
        await rename(view, `${view}-moved`);
        await mkdir(view);
      },
      async (view) => {
        await rename(view, `${view}-other`);
        await rename(`${view}-moved`, view);
      },
    );
    await expect(storeViews(entries, 1, linkTree)).rejects.toThrow(
      'changed while it was made',
    );
    expect(await views(root)).toEqual([
      expect.stringMatching(/^\.view-.*-other$/u),
    ]);
  });
});
