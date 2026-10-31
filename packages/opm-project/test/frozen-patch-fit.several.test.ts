/**
 * `assertPatchesFit` checks every distinct patch of a lock, not the first
 * (ADR 0057 §13): a lock patches several packages, and the one whose patch
 * names the too long path may be any of them.
 */

import type { FrozenPatch } from '@openpacker/adapter-core';
import { describe, expect, it } from 'vitest';
import {
  assertPatchesFit,
  patchedPackageDirectoryBytes,
} from '../src/frozen-patch-fit.js';

const ENV = { OPM_STORE_HOME: '/s' };
const ROOT = '/home/u/project';

/** A patch whose longest path is `bytes` bytes (the text says so; the format reads it). */
const patch = (name: string, bytes: number): FrozenPatch => ({
  key: `${name}@1.0.0`,
  file: `patches/${name}.patch`,
  hash: '',
  digest: name.repeat(64).slice(0, 64),
  text: String(bytes),
});

function checker() {
  const calls: string[] = [];
  const format = {
    frozenPatchPathBytes(one: FrozenPatch): number {
      calls.push(one.key);
      return Number(one.text);
    },
  };
  return { calls, format };
}

const lockOf = (...patches: FrozenPatch[]) =>
  patches.map((one) => ({ patch: one }));

describe('assertPatchesFit over a lock that patches several packages', () => {
  it('refuses the one whose path is too long when it is not the first', async () => {
    const directory = await patchedPackageDirectoryBytes(ROOT, ENV);
    const fits = 4_095 - directory - 1;
    const { format } = checker();
    const outcome = await assertPatchesFit(
      lockOf(patch('a', 10), patch('b', fits + 1), patch('c', 10)),
      format,
      ROOT,
      ENV,
    ).then(
      () => 'fits',
      (error: unknown) => error,
    );
    expect(outcome).toMatchObject({
      code: 'UNSAFE_PATH',
      message: expect.stringContaining(
        'the patch "patches/b.patch" (patchedDependencies "b@1.0.0")',
      ),
    });
  });

  it('accepts a lock whose longest path fits exactly, whichever package holds it', async () => {
    const directory = await patchedPackageDirectoryBytes(ROOT, ENV);
    const fits = 4_095 - directory - 1;
    await expect(
      assertPatchesFit(
        lockOf(patch('a', 10), patch('b', fits), patch('c', fits - 1)),
        checker().format,
        ROOT,
        ENV,
      ),
    ).resolves.toBeUndefined();
  });

  it('says the first of two that are too long, and reads each distinct patch once', async () => {
    const directory = await patchedPackageDirectoryBytes(ROOT, ENV);
    const { calls, format } = checker();
    const one = patch('a', 10);
    const outcome = await assertPatchesFit(
      lockOf(
        one,
        one,
        patch('b', 4_095 - directory),
        patch('c', 4_095 - directory),
      ),
      format,
      ROOT,
      ENV,
    ).then(
      () => 'fits',
      (error: unknown) => error,
    );
    expect(outcome).toMatchObject({
      message: expect.stringContaining('patches/b.patch'),
    });
    expect(calls).toEqual(['a@1.0.0', 'b@1.0.0']);
  });
});
