/**
 * Which lock `opm ci` installs when a project has more than one (ADR 0055 §22).
 *
 * One of `pnpm-lock.yaml` and `package-lock.json`: that one. Both: the root
 * `package.json`'s `packageManager` field says which tool the project is
 * installed with (`pnpm@10.28.0` is the pnpm lock, `npm@10.9.4` the npm lock);
 * with the field absent, or naming another manager, the install is refused and
 * names both files, because a project two tools have installed is one where
 * guessing installs the wrong tree. `yarn.lock` is not read.
 */

import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { ProviderError, type DetectedProject } from '@openpacker/adapter-core';
import { MAXIMUM_MANIFEST_BYTES, readBounded } from './frozen-read.js';

export type LockKind = 'npm' | 'pnpm';

export interface LockChoice {
  kind: LockKind;
  /** The lock file, absolute. */
  path: string;
}

export const NPM_LOCK = 'package-lock.json';
export const PNPM_LOCK = 'pnpm-lock.yaml';

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    // SAFETY: Node file errors carry a string `code`.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** The manager a `packageManager` field names (`pnpm@10.28.0+sha512.…` is `pnpm`), or undefined. */
export function managerOf(field: string | undefined): string | undefined {
  if (field === undefined) return undefined;
  const at = field.indexOf('@', 1);
  const name = (at === -1 ? field : field.slice(0, at)).trim();
  return name === '' ? undefined : name;
}

/**
 * Choose the lock of the project in `root`. `packageManager` reads the root
 * manifest's field of that name, and is asked only when both locks are there.
 */
export async function chooseLock(
  root: string,
  packageManager: () => Promise<string | undefined>,
): Promise<LockChoice> {
  const npm = join(root, NPM_LOCK);
  const pnpm = join(root, PNPM_LOCK);
  const [hasNpm, hasPnpm] = [await exists(npm), await exists(pnpm)];
  if (hasPnpm && !hasNpm) return { kind: 'pnpm', path: pnpm };
  if (hasNpm && !hasPnpm) return { kind: 'npm', path: npm };
  if (!hasNpm && !hasPnpm)
    throw new ProviderError(
      'NOT_FOUND',
      `No package-lock.json or pnpm-lock.yaml in ${root}. A frozen install installs exactly what a lock says; create one with npm install --package-lock-only or pnpm install --lockfile-only`,
    );
  const manager = managerOf(await packageManager());
  if (manager === 'pnpm') return { kind: 'pnpm', path: pnpm };
  if (manager === 'npm') return { kind: 'npm', path: npm };
  throw new ProviderError(
    'INVALID_LOCKFILE',
    `${root} has both ${NPM_LOCK} and ${PNPM_LOCK}, and its package.json ${manager === undefined ? 'has no packageManager field' : `names ${manager} as its packageManager`} to say which tool installs it. Remove the lock that is not used, or set packageManager to pnpm@<version> or npm@<version>`,
  );
}

/** The `packageManager` field of a manifest, when it is text; undefined when the file or the field is not there or is not. */
export async function packageManagerOf(
  manifestPath: string,
): Promise<string | undefined> {
  try {
    const parsed: { packageManager?: unknown } | null = JSON.parse(
      await readBounded(manifestPath, MAXIMUM_MANIFEST_BYTES),
    );
    const field = parsed?.packageManager;
    return typeof field === 'string' ? field : undefined;
  } catch {
    return undefined;
  }
}

/** The lock `opm ci` installs this project from: the one it has, else `packageManager` decides. */
export function chooseProjectLock(
  project: DetectedProject,
): Promise<LockChoice> {
  return chooseLock(project.root, () => packageManagerOf(project.manifestPath));
}
