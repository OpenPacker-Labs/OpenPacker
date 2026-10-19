/**
 * A patch that creates a name an archive refuses is refused where the lock is
 * read, so `opm ci --plan` says so before anything is fetched (ADR 0056 §13).
 */

import { describe, expect, it } from 'vitest';
import { worldOf } from './frozen-support.js';
import {
  hashes,
  PATCH_FILE,
  patchedLock,
  writeBelow,
} from './patch-support.js';

const create = (path: string) =>
  [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${path}`,
    '@@ -0,0 +1 @@',
    '+x',
    '',
  ].join('\n');

describe('a patch file that creates a name an archive refuses', () => {
  it.each([
    'lib/aux.js',
    'lib/CON',
    'lib/nul.txt',
    'lib/a:b',
    'lib/trailing.',
    'lib/com1.json',
  ])('refuses the lock at --plan: %j', async (path) => {
    const text = create(path);
    const world = await worldOf(patchedLock(hashes(text).pnpm10), {
      root: { pnpm: { patchedDependencies: { 'a@1.0.0': PATCH_FILE } } },
    });
    await writeBelow(world.project.root, PATCH_FILE, text);
    await expect(world.read()).rejects.toMatchObject({
      code: 'UNSAFE_PATH',
      message: expect.stringContaining(
        'an archive refuses it on every platform',
      ),
    });
  });
});
