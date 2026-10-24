/**
 * The check `opm ci` makes once its layout is written: every shared store
 * entry it linked from must still be there. One that vanished is put back
 * and the layout written again, once.
 */

import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProjectionResult } from '@openpacker/adapter-core';
import { layOutFromStore } from '../src/frozen-layout.js';
import { cleanupWorlds, scratch } from './gc-race-fixture.js';

afterEach(cleanupWorlds);

// SAFETY: the layout's result passes through untouched; its shape is not read.
const LAYOUT = { written: true } as unknown as ProjectionResult;

/** One entry the layout links from, and what removes it while it is written. */
async function oneEntry() {
  const entry = join(await scratch('opm-layout-'), 'sha256-entry');
  await mkdir(entry);
  return {
    entry,
    sources: [{ storePath: entry, label: 'a@1.0.0 (node_modules/a)' }],
  };
}

describe('the layout check after opm ci links from the store', () => {
  it('puts back an entry removed during the layout and writes the layout again', async () => {
    const { entry, sources } = await oneEntry();
    let writes = 0;
    let restores = 0;

    const layout = await layOutFromStore({
      sources,
      write: async () => {
        writes += 1;
        if (writes === 1) await rm(entry, { recursive: true });
        return LAYOUT;
      },
      restore: async () => {
        restores += 1;
        await mkdir(entry);
      },
    });

    expect(layout).toBe(LAYOUT);
    expect({ writes, restores }).toEqual({ writes: 2, restores: 1 });
  });

  it('puts it back once: an entry removed again fails, naming it, and is not put back a second time', async () => {
    const { entry, sources } = await oneEntry();
    let writes = 0;
    let restores = 0;

    const laying = layOutFromStore({
      sources,
      write: async () => {
        writes += 1;
        if (writes <= 2) await rm(entry, { recursive: true });
        return LAYOUT;
      },
      restore: async () => {
        restores += 1;
        await mkdir(entry);
      },
    });

    await expect(laying).rejects.toMatchObject({
      code: 'STORE_ENTRY_VANISHED',
      message: expect.stringMatching(
        /sha256-entry \(a@1\.0\.0 \(node_modules\/a\)\) was removed again/u,
      ),
    });
    expect({ writes, restores }).toEqual({ writes: 2, restores: 1 });
  });
  it.each(['EROFS', 'EACCES', 'EPERM'])(
    'says the store cannot be written when that (%s) is why an entry cannot be put back',
    async (code) => {
      const { entry, sources } = await oneEntry();

      const laying = layOutFromStore({
        sources,
        write: async () => {
          await rm(entry, { recursive: true, force: true });
          return LAYOUT;
        },
        restore: async () => {
          throw Object.assign(new Error(`${code}: operation refused, mkdir`), {
            code,
          });
        },
      });

      await expect(laying).rejects.toMatchObject({
        code: 'STORE_ENTRY_VANISHED',
        message: expect.stringMatching(
          new RegExp(
            `could not be put back: this install cannot write the store \\(${code}: operation refused`,
            'u',
          ),
        ),
      });
    },
  );

  it('gives any other reason as it is', async () => {
    const { entry, sources } = await oneEntry();

    const laying = layOutFromStore({
      sources,
      write: async () => {
        await rm(entry, { recursive: true, force: true });
        return LAYOUT;
      },
      restore: async () => {
        throw Object.assign(new Error('EIO: input/output error, mkdir'), {
          code: 'EIO',
        });
      },
    });

    await expect(laying).rejects.toMatchObject({
      code: 'STORE_ENTRY_VANISHED',
      message: expect.stringMatching(
        /could not be put back: EIO: input\/output error, mkdir$/u,
      ),
    });
  });
});
