import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { patchedStoreKey } from '../src/frozen-patch.js';
import { stableStoreTreeDigest } from '../src/generations.js';
import { adoptExistingEntry } from '../src/shared-store.js';
import {
  cleanStores,
  DIGEST,
  numbered,
  PATCH,
  publish,
  store,
} from './frozen-patch-fixture.js';

/**
 * Publishing a patched entry (ADR 0056 §11) when two installs make the same
 * one at once: whichever tree wins the rename into place is the one its
 * `<key>.tree` record names, so the entry always verifies afterwards. Here the
 * format makes a different tree each time it is called, which a real patch
 * never does (its entry is named by the bytes it applies), so that a record
 * written for the losing tree would show.
 */

afterEach(cleanStores);

describe('a patched entry two installs publish at once', () => {
  it('is recorded as the tree that won the rename, when the loser finishes last', async () => {
    const root = await store();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const made = numbered((call) => (call === 1 ? gate : Promise.resolve()));
    // The first install makes its tree and waits; the second makes, records
    // and renames its own into place; then the first finishes.
    const first = publish(root, made.format);
    await vi.waitFor(() => expect(made.calls()).toBe(1));
    const second = await publish(root, made.format);
    release();
    const entry = join(root, patchedStoreKey(DIGEST, PATCH.digest));
    expect((await first).byPath.get('node_modules/x')!.path).toBe(entry);
    expect(second.byPath.get('node_modules/x')!.path).toBe(entry);
    expect(await readFile(join(entry, 'package', 'index.js'), 'utf8')).toBe(
      'tree 2\n',
    );
    expect(await adoptExistingEntry(entry, 'x')).toBe(
      await stableStoreTreeDigest(entry),
    );
  });

  it('adopts an entry whose publisher has renamed it into place and not yet recorded it', async () => {
    const root = await store();
    const entry = join(root, patchedStoreKey(DIGEST, PATCH.digest));
    await mkdir(join(entry, 'package'), { recursive: true });
    await writeFile(join(entry, 'package', 'index.js'), 'published\n');
    const made = numbered(() => Promise.resolve());
    const adopting = publish(root, made.format);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await writeFile(`${entry}.tree`, `${await stableStoreTreeDigest(entry)}\n`);
    expect((await adopting).byPath.get('node_modules/x')!.path).toBe(entry);
    expect(made.calls()).toBe(0);
  });

  it('leaves an entry that verifies after twelve rounds of two installs racing', async () => {
    for (let round = 0; round < 12; round += 1) {
      const root = await store();
      const made = numbered(
        () => new Promise((resolve) => setTimeout(resolve, round % 3)),
      );
      const settled = await Promise.allSettled([
        publish(root, made.format),
        publish(root, made.format),
      ]);
      expect(settled.map((result) => result.status)).toEqual([
        'fulfilled',
        'fulfilled',
      ]);
      const entry = join(root, patchedStoreKey(DIGEST, PATCH.digest));
      await expect(adoptExistingEntry(entry, 'x')).resolves.toMatch(
        /^sha256:/u,
      );
    }
  });
});
