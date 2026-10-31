/**
 * A `patchedDependencies` key read exactly as pnpm 10.28 reads it
 * (`groupPatchedDependencies` through `dp.parse` of `@pnpm/dependency-path`,
 * and node-semver's strict `valid`), case by case where opm's first reading
 * differed (review 184, finding 9). Each expectation is what pnpm's own
 * functions, loaded from the 10.28.0 bundle, gave for the same key on
 * 2026-10-17.
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

/** The lock read with the project declaring `keys`, each for the one patch file. */
async function read(...keys: string[]) {
  const declared = Object.fromEntries(
    keys.map((key) => [key, { hash: HASH, path: PATCH_FILE }]),
  );
  const world = await worldOf(patchedLock(HASH, declared), {
    root: {
      pnpm: {
        patchedDependencies: Object.fromEntries(
          keys.map((key) => [key, PATCH_FILE]),
        ),
      },
    },
  });
  await writeBelow(world.project.root, PATCH_FILE, PATCH_TEXT);
  return world.read();
}

const patchOfA = async (key: string) =>
  (await read(key)).packages.find((item) => item.packageName === 'a')?.patch
    ?.key;

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/** The refusal of `key`, whose version part is `version` (both cut short when long). */
const nonSemver = (key: string, version: string) => ({
  path: expect.stringContaining(
    `patchedDependencies[${JSON.stringify(key).slice(0, 60)}`,
  ),
  reason: expect.stringMatching(
    new RegExp(
      `^${escape(JSON.stringify(version).slice(0, 60))}.* is not a version or a range, as pnpm refuses it \\(ERR_PNPM_PATCH_NON_SEMVER_RANGE\\)$`,
      'u',
    ),
  ),
});

describe("a patchedDependencies key, as pnpm's dp.parse and semver.valid read it", () => {
  it.each([
    ['a@1.0.0(peer@1.0.0)', 'a peer suffix'],
    ['a@1.0.0(patch_hash=abc)', 'a patch_hash suffix'],
    ['a@^1(peer@1.0.0)', 'a range with a peer suffix'],
  ])('reads %j without its (...) suffix (%s)', async (key) => {
    expect(await patchOfA(key)).toBe(key);
  });

  it.each([
    ['a@1.0.0-01', '1.0.0-01', 'a numeric prerelease with a leading zero'],
    [
      'a@99999999999999999.0.0',
      '99999999999999999.0.0',
      'a number past Number.MAX_SAFE_INTEGER',
    ],
    [
      `a@1.0.0-${'p'.repeat(260)}`,
      `1.0.0-${'p'.repeat(260)}`,
      'a version longer than 256',
    ],
    ['a@1.0.0)', '1.0.0)', 'a ")" with no "("'],
  ])(
    'refuses %j as neither a version nor a range (%s)',
    async (key, version) => {
      // a@1.0.0 is declared as well, so a@1.0.0's snapshot has its patch.
      expect((await read('a@1.0.0', key)).refused).toEqual([
        nonSemver(key, version),
      ]);
    },
  );
});
