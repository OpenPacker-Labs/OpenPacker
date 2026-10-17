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
import { patchedStoreKey } from '../src/frozen-patch.js';

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

const DIGEST = `sha256:${'a'.repeat(64)}`;
const PATCH = 'b'.repeat(64);

/**
 * `opm gc --shared` treats a patched entry (ADR 0056) as it treats an
 * archive's: kept while a project links one of its files, kept while it is
 * younger than the age rule, removed with its tree record otherwise, and its
 * half-written temporary cleared once it is old.
 */
describe('a patched entry in the shared store, collected', () => {
  it('is named by the archive and the sha256 of the patch, and nothing else', () => {
    expect(patchedStoreKey(DIGEST, PATCH)).toBe(
      `sha256-${'a'.repeat(64)}-patch-${PATCH}`,
    );
    expect(() => patchedStoreKey(DIGEST, 'wbmb7dwhiv66et2i6bbymnlkhi')).toThrow(
      /Invalid patch digest/u,
    );
  });

  it('is kept while linked or young, then removed with its record, and its leftovers too', async () => {
    const shared = await mkdtemp(join(tmpdir(), 'opm-shared-'));
    const project = await mkdtemp(join(tmpdir(), 'opm-linker-'));
    temps.push(shared, project);
    const key = patchedStoreKey(DIGEST, PATCH);
    const entry = join(shared, key);
    await mkdir(join(entry, 'package'), { recursive: true });
    await writeFile(join(entry, 'package', 'index.js'), 'patched');
    await writeFile(`${entry}.tree`, `sha256:${'c'.repeat(64)}\n`);
    const stray = join(shared, `.${key}.materialize-0000`);
    await mkdir(stray);
    const env = { OPM_STORE_HOME: shared };
    const old = new Date(Date.now() - 3_600_000);

    await link(join(entry, 'package', 'index.js'), join(project, 'index.js'));
    await utimes(`${entry}.tree`, old, old);
    expect(await collectSharedStore({ env })).toMatchObject({
      removed: [],
      referenced: 1,
    });

    await rm(join(project, 'index.js'));
    await utimes(`${entry}.tree`, new Date(), new Date());
    expect(await collectSharedStore({ env })).toMatchObject({
      removed: [],
      tooNew: 1,
    });

    await utimes(`${entry}.tree`, old, old);
    await utimes(stray, old, old);
    expect((await collectSharedStore({ env })).removed).toEqual([stray, entry]);
    expect(await readdir(shared)).toEqual([]);
  });
});
