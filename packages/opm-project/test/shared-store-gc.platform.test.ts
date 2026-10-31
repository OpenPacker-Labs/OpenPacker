/**
 * `opm gc --shared` and the platform records of the integrity index
 * (`by-integrity/<key>.platform`: what an archive declared it runs on, kept for
 * a build an install left out and never stored, ADR 0059). Nothing links such
 * a record, so a collection removes it once it is older than the minimum age,
 * as it removes an entry nothing links; a malformed one names nothing and goes
 * at once. The next install fetches that archive again, once.
 */

import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { collectSharedStore } from '../src/index.js';
import {
  INTEGRITY_INDEX,
  lookupArchivePlatform,
  recordArchivePlatform,
} from '../src/shared-store-index.js';
import { cleanupWorlds, world } from './gc-race-fixture.js';

afterEach(cleanupWorlds);

const KEY = `sha512-${'ab'.repeat(64)}`;
const OTHER = `sha512-${'cd'.repeat(64)}`;

async function records(store: string): Promise<string[]> {
  return (await readdir(join(store, INTEGRITY_INDEX)).catch(() => [])).sort();
}

describe('opm gc --shared and platform records', () => {
  it('keeps a young record, and removes it once it is old, saying so on a dry run first', async () => {
    const w = await world(1);
    await w.install(0);
    await recordArchivePlatform(w.store, KEY, {
      os: ['linux'],
      cpu: ['x64'],
      libc: ['musl'],
    });
    expect(await lookupArchivePlatform(w.store, KEY)).toEqual({
      os: ['linux'],
      cpu: ['x64'],
      libc: ['musl'],
    });

    const young = await collectSharedStore({ env: w.env });
    expect(young.platformRecords).toEqual([]);
    expect(await records(w.store)).toContain(`${KEY}.platform`);

    const path = join(w.store, INTEGRITY_INDEX, `${KEY}.platform`);
    const dry = await collectSharedStore({
      env: w.env,
      minimumAgeMs: 0,
      dryRun: true,
      now: () => Date.now() + 1000,
    });
    expect(dry.platformRecords).toEqual([path]);
    expect(await records(w.store)).toContain(`${KEY}.platform`);

    const done = await collectSharedStore({
      env: w.env,
      minimumAgeMs: 0,
      now: () => Date.now() + 1000,
    });
    expect(done.platformRecords).toEqual([path]);
    expect(await records(w.store)).not.toContain(`${KEY}.platform`);
    // The entries the project links, and their records, stay.
    expect(done.removed).toEqual([]);
    expect(done.records).toEqual([]);
  });

  it('removes a malformed record whatever its age, and reads one as a miss', async () => {
    const w = await world(1);
    await w.install(0);
    await recordArchivePlatform(w.store, KEY, { os: ['linux'] });
    await writeFile(
      join(w.store, INTEGRITY_INDEX, `${OTHER}.platform`),
      '{"os": "linux"}\n',
    );
    expect(await lookupArchivePlatform(w.store, OTHER)).toBeUndefined();

    const done = await collectSharedStore({ env: w.env });
    expect(done.platformRecords).toEqual([
      join(w.store, INTEGRITY_INDEX, `${OTHER}.platform`),
    ]);
    expect(await records(w.store)).toContain(`${KEY}.platform`);
    expect(await records(w.store)).not.toContain(`${OTHER}.platform`);
  });
});
