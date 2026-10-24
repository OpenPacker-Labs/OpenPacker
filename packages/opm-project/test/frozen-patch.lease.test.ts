/**
 * A patched copy is a shared store entry like an archive's (ADR 0057), so
 * `opm gc --shared` and an install meet over it as they meet over an archive's
 * (ADR 0048, amendment 2026-10-17): the install claims the copy before it
 * looks it up, and keeps the claim until node_modules links it; and when the
 * copy is gone after all (removed by something that does not honour claims),
 * the install puts it back, patched again, and writes node_modules again.
 */

import { readdir, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { installFrozenWith } from '../src/frozen-install.js';
import {
  collectSharedStore,
  type SharedStoreCollection,
} from '../src/index.js';
import { cleanStores, patchedWorld } from './frozen-patch-fixture.js';
import { cleanup, type PnpmWorld } from './frozen-pnpm-fixture.js';
import { onPosix } from './frozen-workspace-fixture.js';

afterEach(async () => {
  await cleanup();
  await cleanStores();
});

const PATCH = [
  'diff --git a/lib.js b/lib.js',
  '--- a/lib.js',
  '+++ b/lib.js',
  '@@ -1 +1 @@',
  "-module.exports = 'original';",
  "+module.exports = 'patched';",
  '',
].join('\n');

const storeOf = (w: PnpmWorld) => join(w.dir, '..', `${basename(w.dir)}-store`);

function install(w: PnpmWorld, beforeLayout: () => Promise<void>) {
  return installFrozenWith(
    {
      root: w.dir,
      transport: w.registry,
      env: { OPM_STORE_HOME: storeOf(w) },
      now: () => '2026-10-12T12:00:00.000Z',
      target: { os: 'linux', architecture: 'x64', libc: 'glibc' },
    },
    { beforeLayout },
  );
}

const patchedEntries = async (w: PnpmWorld) =>
  (await readdir(storeOf(w))).filter((name) =>
    /^sha256-[0-9a-f]{64}-patch-[0-9a-f]{64}$/u.test(name),
  );

describe.runIf(onPosix)('opm ci, a patched copy and opm gc --shared', () => {
  it('keeps the patched copy and its archive while the install that made them has not linked them yet', async () => {
    const w = await patchedWorld(PATCH);
    let collected: SharedStoreCollection | undefined;
    const result = await install(w, async () => {
      collected = await collectSharedStore({
        env: { OPM_STORE_HOME: storeOf(w) },
        minimumAgeMs: 0,
      });
    });
    expect(result.patched).toEqual({ packages: 1, patches: 1 });
    // The patched copy is claimed, so it is held; the archive's entry it was
    // made from is kept with it, as a kept copy's archive always is.
    expect(collected).toMatchObject({ removed: [], held: 1, referenced: 1 });
    expect(await w.read('node_modules/x/lib.js')).toBe(
      "module.exports = 'patched';\n",
    );
    expect(await patchedEntries(w)).toHaveLength(1);
  }, 120_000);

  it('puts back, patched again, a copy that something removed before it was linked', async () => {
    const w = await patchedWorld(PATCH);
    const result = await install(w, async () => {
      // What does not honour claims: a person, or an older opm's collection.
      for (const name of await patchedEntries(w))
        await rm(join(storeOf(w), name), { recursive: true, force: true });
    });
    expect(result.patched).toEqual({ packages: 1, patches: 1 });
    expect(await w.read('node_modules/x/lib.js')).toBe(
      "module.exports = 'patched';\n",
    );
    expect(await patchedEntries(w)).toHaveLength(1);
  }, 120_000);

  it('puts back the archive and the copy when both were removed', async () => {
    const w = await patchedWorld(PATCH);
    const result = await install(w, async () => {
      for (const name of await readdir(storeOf(w)))
        if (name.startsWith('sha256-'))
          await rm(join(storeOf(w), name), { recursive: true, force: true });
    });
    expect(result.patched).toEqual({ packages: 1, patches: 1 });
    expect(await w.read('node_modules/x/lib.js')).toBe(
      "module.exports = 'patched';\n",
    );
    expect(await patchedEntries(w)).toHaveLength(1);
  }, 120_000);
});
