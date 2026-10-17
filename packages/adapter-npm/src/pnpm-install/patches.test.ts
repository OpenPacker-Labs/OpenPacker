/**
 * Which patch each package of a pnpm lock takes, by pnpm 10.28's rules for the
 * keys of `patchedDependencies` (ADR 0056), and what the lock says of its
 * patches that is refused before any file is read.
 */

import { describe, expect, it } from 'vitest';
import { worldOf } from './frozen-support.js';
import {
  hashes,
  PATCH_FILE,
  PATCH_TEXT,
  patchedLock,
  writeBelow,
} from './patch-support.js';

const { pnpm10: HASH } = hashes();
const at = (key: string) => ({ [key]: { hash: HASH, path: PATCH_FILE } });

/** The lock read with the project declaring exactly what it records. */
async function read(
  declared: Record<string, { hash: string; path: string }>,
  snapshotHash: string | null = HASH,
) {
  const world = await worldOf(patchedLock(HASH, declared, snapshotHash), {
    root: {
      pnpm: {
        patchedDependencies: Object.fromEntries(
          Object.entries(declared).map(([key, item]) => [key, item.path]),
        ),
      },
    },
  });
  await writeBelow(world.project.root, PATCH_FILE, PATCH_TEXT);
  return world.read();
}

const patchOfA = async (
  declared: Record<string, { hash: string; path: string }>,
) =>
  (await read(declared)).packages.find((item) => item.packageName === 'a')
    ?.patch?.key;

describe('the patch a package takes', () => {
  it('is the one its exact version, a range it satisfies, "*" or its bare name declares', async () => {
    expect(await patchOfA(at('a@1.0.0'))).toBe('a@1.0.0');
    expect(await patchOfA(at('a@^1.0.0'))).toBe('a@^1.0.0');
    expect(await patchOfA(at('a@*'))).toBe('a@*');
    expect(await patchOfA(at('a'))).toBe('a');
  });

  it('is the exact version over a range, and a range over every version', async () => {
    const exact = await read({ ...at('a@1.0.0'), ...at('a@^1.0.0') });
    expect(exact.refused).toEqual([
      {
        path: 'patchedDependencies["a@^1.0.0"]',
        reason:
          'applies to no package pnpm-lock.yaml holds, as pnpm refuses an unused patch when it resolves (ERR_PNPM_UNUSED_PATCH)',
      },
    ]);
    const range = await read({ ...at('a@~1.0.0'), ...at('a') });
    expect(range.refused.map((item) => item.path)).toEqual([
      'patchedDependencies["a"]',
    ]);
  });

  it('refuses two ranges the version satisfies, as pnpm cannot choose', async () => {
    const both = await read({ ...at('a@^1.0.0'), ...at('a@>=1.0.0 <2') });
    expect(both.refused).toEqual([
      {
        path: 'snapshots["a@1.0.0(patch_hash=' + HASH + ')"]',
        reason:
          'satisfies the ranges of "a@>=1.0.0 <2", "a@^1.0.0", and pnpm cannot choose between them (ERR_PNPM_PATCH_KEY_CONFLICT)',
      },
      expect.objectContaining({ path: 'patchedDependencies["a@>=1.0.0 <2"]' }),
      expect.objectContaining({ path: 'patchedDependencies["a@^1.0.0"]' }),
    ]);
  });

  it('refuses a key that is neither a version nor a range', async () => {
    const odd = await read({ ...at('a@1.0.0'), ...at('a@not a range') });
    expect(odd.refused).toEqual([
      {
        path: 'patchedDependencies["a@not a range"]',
        reason:
          '"not a range" is not a version or a range, as pnpm refuses it (ERR_PNPM_PATCH_NON_SEMVER_RANGE)',
      },
    ]);
  });

  it('refuses a snapshot that does not carry the hash of the patch that applies to it', async () => {
    const bare = await read(at('a@1.0.0'), null);
    expect(bare.refused).toEqual([
      {
        path: 'snapshots["a@1.0.0"]',
        reason:
          'carries no patch_hash, although patchedDependencies["a@1.0.0"] applies to it',
      },
    ]);
    const other = await read(at('a@^2.0.0'));
    expect(other.refused).toEqual([
      {
        path: `snapshots["a@1.0.0(patch_hash=${HASH})"]`,
        reason: `carries patch_hash "${HASH}", and no patch in patchedDependencies applies to "a@1.0.0"`,
      },
      expect.objectContaining({ path: 'patchedDependencies["a@^2.0.0"]' }),
    ]);
  });

  it('refuses a hash that is neither pnpm 10 nor pnpm 9 wrote', async () => {
    const world = await worldOf(
      patchedLock('abc123', {
        'a@1.0.0': { hash: 'abc123', path: PATCH_FILE },
      }),
    );
    expect((await world.read()).refused).toEqual([
      expect.objectContaining({
        path: 'patchedDependencies["a@1.0.0"].hash',
        reason: expect.stringContaining(
          'is "abc123", which is neither pnpm 10\'s hash',
        ),
      }),
    ]);
  });
});
