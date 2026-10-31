import {
  link,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { collectSharedStore } from '../src/index.js';

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

const RECORD = `sha256:${'c'.repeat(64)}\n`;
const ARCHIVE = `sha256-${'a'.repeat(64)}`;
const PATCHED = `${ARCHIVE}-patch-${'b'.repeat(64)}`;
const YOUNG = `sha256-${'e'.repeat(64)}`;
const LINKED = `sha256-${'f'.repeat(64)}`;

/**
 * `opm gc --shared` and a `<key>.tree` record left without its entry: an
 * install or a collection that stopped between the two writes leaves one,
 * and nothing else ever removes it. Once old it is removed, an archive's and
 * a patched copy's alike; a young one may be a publish about to rename its
 * entry into place, and is left alone.
 */
describe('a tree record whose entry is gone', () => {
  it('is removed once old, for an archive and a patched copy, and kept while young', async () => {
    const shared = await mkdtemp(join(tmpdir(), 'opm-shared-'));
    const project = await mkdtemp(join(tmpdir(), 'opm-linker-'));
    temps.push(shared, project);
    const old = new Date(Date.now() - 3_600_000);
    for (const key of [ARCHIVE, PATCHED, YOUNG, LINKED]) {
      await writeFile(join(shared, `${key}.tree`), RECORD);
      if (key !== YOUNG) await utimes(join(shared, `${key}.tree`), old, old);
    }
    await mkdir(join(shared, LINKED, 'package'), { recursive: true });
    await writeFile(join(shared, LINKED, 'package', 'index.js'), 'x');
    await link(
      join(shared, LINKED, 'package', 'index.js'),
      join(project, 'index.js'),
    );
    const env = { OPM_STORE_HOME: shared };
    const orphans = [ARCHIVE, PATCHED].map((key) =>
      join(shared, `${key}.tree`),
    );

    const dry = await collectSharedStore({ env, dryRun: true });
    expect(dry.removed.sort()).toEqual(orphans.sort());
    expect((await readdir(shared)).sort()).toEqual(
      [ARCHIVE, PATCHED, YOUNG, LINKED]
        .map((key) => `${key}.tree`)
        .concat(LINKED)
        .sort(),
    );

    const done = await collectSharedStore({ env });
    expect(done.removed.sort()).toEqual(orphans.sort());
    expect(done.referenced).toBe(1);
    expect((await readdir(shared)).sort()).toEqual(
      [LINKED, `${LINKED}.tree`, `${YOUNG}.tree`].sort(),
    );
  });
});
