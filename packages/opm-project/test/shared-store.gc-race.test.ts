/**
 * `opm install` (and add, update) while `opm gc --shared` runs: the collection
 * runs inside `materializeThroughSharedStore`, after the entry was found and
 * before its first file is linked, with no grace period.
 */

import { createHash } from 'node:crypto';
import { link, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { packTarGzip } from '@openpacker/project-io';
import {
  collectSharedStore,
  storeKeyFromDigest,
  type SharedStoreCollection,
} from '../src/index.js';
import { materializeThroughSharedStore } from '../src/shared-store.js';

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

const bytes = packTarGzip([
  {
    path: 'package/index.js',
    contents: new TextEncoder().encode('module.exports = 1;\n'),
  },
]);
const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const offline = async (): Promise<Uint8Array> => {
  throw new Error('offline: the archive cannot be fetched again');
};

describe('materializeThroughSharedStore and opm gc --shared at once', () => {
  it('links an entry it found, although a collection ran before the first link', async () => {
    const base = await mkdtemp(join(tmpdir(), 'opm-install-gc-'));
    temps.push(base);
    const env = { OPM_STORE_HOME: join(base, 'store') };
    const key = storeKeyFromDigest(digest);
    // An earlier project published the entry and is gone: nothing links it.
    await materializeThroughSharedStore({
      digest,
      projectStorePath: join(base, 'earlier', key),
      bytes,
      format: 'tar+gzip',
      env,
    });
    await rm(join(base, 'earlier'), { recursive: true });

    let collected: SharedStoreCollection | undefined;
    const result = await materializeThroughSharedStore({
      digest,
      projectStorePath: join(base, 'project', key),
      bytes: offline,
      format: 'tar+gzip',
      env,
      linkFile: async (from, to) => {
        collected ??= await collectSharedStore({ env, minimumAgeMs: 0 });
        await link(from, to);
      },
    });

    expect(result.shared).toBe(true);
    expect(collected).toMatchObject({ removed: [], held: 1 });
    expect(
      await readFile(join(base, 'project', key, 'package/index.js'), 'utf8'),
    ).toBe('module.exports = 1;\n');
    expect(await readdir(env.OPM_STORE_HOME)).toContain(key);
  });

  it('says which entry, when something that ignores claims removes it twice', async () => {
    const base = await mkdtemp(join(tmpdir(), 'opm-install-gc-'));
    temps.push(base);
    const env = { OPM_STORE_HOME: join(base, 'store') };
    const key = storeKeyFromDigest(digest);
    const entry = join(env.OPM_STORE_HOME, key);

    await expect(
      materializeThroughSharedStore({
        digest,
        projectStorePath: join(base, 'project', key),
        bytes,
        format: 'tar+gzip',
        env,
        linkFile: async (from, to) => {
          await rm(entry, { recursive: true, force: true });
          await link(from, to);
        },
      }),
    ).rejects.toMatchObject({
      code: 'STORE_ENTRY_VANISHED',
      message: expect.stringContaining(entry),
    });
  });
});
