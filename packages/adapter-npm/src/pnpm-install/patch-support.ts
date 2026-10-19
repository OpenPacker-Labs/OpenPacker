/**
 * A lock with patched packages and the patch files it names, for the suites of
 * `patches.ts` and `patch-files.ts`: `a@1.0.0` patched and `b@1.0.0` not.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pnpm10PatchHash, pnpm9PatchHash } from '../pnpm-patch/index.js';
import { dependency, LOCK, pkg } from './lock-support.js';

/** A patch of `index.js` that `a@1.0.0`'s archive would carry. */
export const PATCH_TEXT = [
  'diff --git a/index.js b/index.js',
  '--- a/index.js',
  '+++ b/index.js',
  '@@ -1 +1 @@',
  "-module.exports = 'a';",
  "+module.exports = 'patched';",
  '',
].join('\n');

export const PATCH_FILE = 'patches/a@1.0.0.patch';

export const hashes = (text = PATCH_TEXT) => ({
  pnpm10: pnpm10PatchHash(Buffer.from(text)),
  pnpm9: pnpm9PatchHash(Buffer.from(text)),
});

/**
 * A lock that patches the packages of `patched` (a key, its hash and path) and
 * installs `a@1.0.0` (patched with `hash`) and `b@1.0.0`.
 */
export function patchedLock(
  hash: string,
  declared: Record<string, { hash: string; path: string }> = {
    'a@1.0.0': { hash, path: PATCH_FILE },
  },
  /** The hash the snapshot of `a` carries; null for none. */
  snapshotHash: string | null = hash,
): string {
  const suffix = snapshotHash === null ? '' : `(patch_hash=${snapshotHash})`;
  const entries = Object.entries(declared)
    .map(
      ([key, item]) =>
        `  '${key}':\n    hash: ${item.hash}\n    path: ${item.path}\n`,
    )
    .join('');
  return LOCK(`${entries === '' ? '' : `patchedDependencies:\n${entries}\n`}importers:

  .:
    dependencies:
${dependency('a', '1.0.0', `1.0.0${suffix}`)}${dependency('b', '1.0.0', '1.0.0')}
packages:

${pkg('a@1.0.0')}
${pkg('b@1.0.0')}
snapshots:

  a@1.0.0${suffix}: {}

  b@1.0.0: {}
`);
}

/** Write `text` at `path` below `root`. */
export async function writeBelow(
  root: string,
  path: string,
  text: string | Uint8Array,
): Promise<void> {
  const where = join(root, ...path.split('/'));
  await mkdir(dirname(where), { recursive: true });
  await writeFile(where, text);
}
