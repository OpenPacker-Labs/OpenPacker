/** Paths of a given length, and a store behind a symlink, for the tests of ADR 0056 §13's whole-path rule. */

import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const temps: string[] = [];

/** Remove what the helpers below made since the last call. */
export async function cleanLong(): Promise<void> {
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
}

/** A new directory under the real temporary directory, to be removed by `cleanLong`. */
export async function scratch(): Promise<string> {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'opm-long-')));
  temps.push(base);
  return base;
}

/** `base` with directories added until its path is `bytes` bytes long (each of at most 99). */
export async function deepen(base: string, bytes: number): Promise<string> {
  let dir = base;
  while (Buffer.byteLength(dir) < bytes) {
    const room = bytes - Buffer.byteLength(dir) - 1;
    dir = join(dir, 'd'.repeat(Math.max(Math.min(room, 99), 1)));
  }
  await mkdir(dir, { recursive: true });
  return dir;
}

/** A directory whose path is `bytes` bytes long, to stand for a store under a deep home. */
export async function directoryOfBytes(bytes: number): Promise<string> {
  return deepen(await scratch(), bytes);
}

/** A path of exactly `bytes` bytes in segments of at most 50. */
export function pathOfBytes(bytes: number): string {
  let path = '';
  while (path.length < bytes) {
    const room = bytes - path.length;
    path +=
      (path === '' ? '' : '/') +
      's'.repeat(Math.min(room - (path === '' ? 0 : 1), 50));
  }
  return path;
}

/** A patch that creates `path`. */
export const createPatch = (path: string): string =>
  [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${path}`,
    '@@ -0,0 +1 @@',
    '+x',
    '',
  ].join('\n');

/**
 * A store `store` whose path goes through a symlink `ln` to a directory
 * `extra` bytes longer than the link: the host works on the canonical path,
 * `canonical`, and a string count of `store` is short by `extra`.
 */
export async function symlinkedStore(extra: number): Promise<{
  store: string;
  canonical: string;
}> {
  const top = await scratch();
  const link = join(top, 'ln');
  const real = await deepen(join(top, 'real'), Buffer.byteLength(link) + extra);
  await symlink(real, link);
  await mkdir(join(real, 'store'));
  return { store: join(link, 'store'), canonical: join(real, 'store') };
}

/**
 * A store `store` behind a symlink whose name is `extra` bytes longer than its
 * target's: as written the path is the longer one, and `canonical` the shorter.
 */
export async function shortcutStore(extra: number): Promise<{
  store: string;
  canonical: string;
}> {
  const top = await scratch();
  const real = join(top, 'r');
  await mkdir(join(real, 'store'), { recursive: true });
  const link = join(top, 'l'.repeat(extra + 1));
  await symlink(real, link);
  return { store: join(link, 'store'), canonical: join(real, 'store') };
}
