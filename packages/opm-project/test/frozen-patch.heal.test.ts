import {
  chmod,
  readdir,
  readFile,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { patchedStoreKey } from '../src/frozen-patch.js';
import { stableStoreTreeDigest } from '../src/generations.js';
import { adoptExistingEntry } from '../src/shared-store.js';
import {
  cleanStores,
  DIGEST,
  deterministic,
  PATCH,
  publish,
  store,
} from './frozen-patch-fixture.js';

/**
 * A patched entry whose publisher died between the rename that put it in
 * place and the write of its `<key>.tree` record (ADR 0056 §11). An archive's
 * record is written before its rename, so a publisher that dies leaves at most
 * an orphan record; a patched entry's follows the rename (so that it names the
 * tree that won), and a publisher killed in between left an entry that every
 * later install refused, after a 10 s wait each, until `opm gc --shared`
 * removed it once ten minutes old: 2 of 120 SIGKILLs at random moments left
 * one. The install that finds one now makes the tree again from the unpatched
 * entry it has proved, and writes the record only if the entry in place is
 * that tree.
 */

afterEach(cleanStores);

const WAIT = 50;

/** A store whose patched entry is published, then loses its record. */
async function unrecorded() {
  const root = await store();
  const made = deterministic();
  await publish(root, made.format, WAIT);
  const entry = join(root, patchedStoreKey(DIGEST, PATCH.digest));
  const digest = await stableStoreTreeDigest(entry);
  await unlink(`${entry}.tree`);
  return { root, entry, digest, made };
}

describe('a patched entry whose publisher died before recording it', () => {
  it('is adopted by the next install, which records the tree it made again, after the wait and no longer', async () => {
    const { root, entry, digest, made } = await unrecorded();
    expect(made.calls()).toBe(1);
    const inode = (await stat(entry)).ino;
    const started = performance.now();
    const again = await publish(root, made.format, WAIT);
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(again.byPath.get('node_modules/x')!.path).toBe(entry);
    // The tree was made once more, to compare; the entry in place is the one it was.
    expect(made.calls()).toBe(2);
    expect((await stat(entry)).ino).toBe(inode);
    expect(await readFile(`${entry}.tree`, 'utf8')).toBe(`${digest}\n`);
    expect(await adoptExistingEntry(entry, 'x')).toBe(digest);
    // And the next install has nothing to heal.
    await publish(root, made.format, WAIT);
    expect(made.calls()).toBe(2);
  });

  it('is not trusted when its files are not the tree the patch gives: no record is written, and the error names the two paths to remove', async () => {
    const { root, entry, made } = await unrecorded();
    const file = join(entry, 'package', 'index.js');
    await chmod(file, 0o644);
    await writeFile(file, 'tampered\n');
    await expect(publish(root, made.format, WAIT)).rejects.toMatchObject({
      code: 'VERIFICATION_FAILED',
      message: expect.stringContaining(
        `remove ${entry} and ${entry}.tree and run the command again`,
      ),
    });
    expect(await readdir(root)).not.toContain(
      `${patchedStoreKey(DIGEST, PATCH.digest)}.tree`,
    );
    // The tampered entry was not changed, and the temporary tree is gone.
    expect(await readFile(file, 'utf8')).toBe('tampered\n');
    expect(
      (await readdir(root)).filter((name) => name.includes('.materialize-')),
    ).toEqual([]);
  });

  it('waits for a record its live publisher is about to write, and does not make the tree again', async () => {
    const { root, entry, digest, made } = await unrecorded();
    const adopting = publish(root, made.format, 5_000);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await writeFile(`${entry}.tree`, `${digest}\n`);
    expect((await adopting).byPath.get('node_modules/x')!.path).toBe(entry);
    expect(made.calls()).toBe(1);
  });
});
