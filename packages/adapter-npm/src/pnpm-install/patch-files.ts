/**
 * The patch files a pnpm project declares, read and held to its lock (ADR
 * 0056).
 *
 * pnpm reads `patchedDependencies` from the root `package.json`
 * (`pnpm.patchedDependencies`) or `pnpm-workspace.yaml`, makes each path
 * absolute against the file that named it (the project root, for both), and
 * records `{ hash, path }` with the path relative to the lock's directory
 * (`calcPatchHashes`). A frozen install refuses a lock whose record is not what
 * the project's files give now (`getOutdatedLockfileSetting`,
 * `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`): a key added or removed, a path moved,
 * a file edited. Those are the stale differences here.
 *
 * What opm refuses that pnpm reads: a path that leaves the project, through
 * `..`, an absolute path or a link on the way (`UNSAFE_PATH`). A file that is
 * not there is `NOT_FOUND`, as it is for pnpm (`ENOENT`). Each file is parsed
 * here, so `opm ci --plan` refuses a patch pnpm cannot read and one that names
 * a path outside its package, before anything is fetched.
 */

import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { ProviderError, type FrozenPatch } from '@openpacker/adapter-core';
import { O_DIRECTORY, openChild } from '@openpacker/project-io';
import { insidePathProblem } from '../pnpm-lock/source.js';
import type { PnpmLock } from '../pnpm-lock/types.js';
import {
  patchHashLike,
  pnpm10PatchHash,
  readPatchText,
} from '../pnpm-patch/index.js';
import type { PnpmProjectConfig } from './config.js';
import { quote } from './quote.js';

/** The largest patch file read. */
export const MAXIMUM_PATCH_BYTES = 16 * 1024 * 1024;

const code = (error: unknown): string | undefined =>
  // SAFETY: Node file errors carry an optional string `code`.
  (error as NodeJS.ErrnoException).code;

/** `relative` below `root`, opened one directory at a time, following no link. */
async function readBelow(root: string, path: string): Promise<Buffer> {
  const parts = path.split('/');
  const unsafe = () =>
    new ProviderError(
      'UNSAFE_PATH',
      `the patch file ${quote(path)} is reached through a link or something that is not a directory; opm reads a patch only from a plain file inside the project`,
    );
  let handle: FileHandle = await open(root, constants.O_RDONLY | O_DIRECTORY);
  try {
    for (const [index, part] of parts.entries()) {
      const last = index === parts.length - 1;
      let next: FileHandle;
      try {
        next = await openChild(
          handle,
          part,
          constants.O_RDONLY |
            constants.O_NOFOLLOW |
            (last ? constants.O_NONBLOCK : O_DIRECTORY),
        );
      } catch (error) {
        if (code(error) === 'ENOENT')
          throw new ProviderError(
            'NOT_FOUND',
            `the patch file ${quote(path)} does not exist, and pnpm cannot install without it either (ENOENT)`,
          );
        if (code(error) === 'ELOOP' || code(error) === 'ENOTDIR')
          throw unsafe();
        throw error;
      }
      await handle.close();
      handle = next;
    }
    const info = await handle.stat();
    if (!info.isFile()) throw unsafe();
    if (info.size > MAXIMUM_PATCH_BYTES)
      throw new ProviderError(
        'INVALID_LOCKFILE',
        `the patch file ${quote(path)} is ${info.size} bytes, more than the ${MAXIMUM_PATCH_BYTES} opm reads`,
      );
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

/** The project's patches, by key, and how they differ from the lock's record. */
export interface ProjectPatches {
  readonly patches: ReadonlyMap<string, FrozenPatch>;
  readonly stale: readonly string[];
}

/** Read every patch the project declares and hold the lock's record to it. */
export async function readProjectPatches(
  root: string,
  config: PnpmProjectConfig,
  lock: PnpmLock,
): Promise<ProjectPatches> {
  const patches = new Map<string, FrozenPatch>();
  const stale: string[] = [];
  const declared = [...config.patches].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  for (const [key, value] of declared) {
    // pnpm: `path.join(dir, value)` unless absolute, then relative to the lock.
    const path = relative(root, isAbsolute(value) ? value : join(root, value))
      .split('\\')
      .join('/');
    const problem = insidePathProblem(path, false);
    if (problem !== undefined)
      throw new ProviderError(
        'UNSAFE_PATH',
        `${config.patchesFrom}[${quote(key)}] is ${quote(value)}, which ${problem}; opm reads a patch only from inside the project`,
      );
    const bytes = await readBelow(root, path);
    const recorded = lock.patchedDependencies.get(key);
    if (recorded === undefined) {
      stale.push(
        `the project declares a patch for ${quote(key)} (${quote(path)}) and pnpm-lock.yaml records none`,
      );
      continue;
    }
    if (recorded.path !== path)
      stale.push(
        `the patch for ${quote(key)} is ${quote(path)} in the project and ${quote(recorded.path)} in pnpm-lock.yaml`,
      );
    const hash = patchHashLike(recorded.hash, bytes);
    if (hash !== undefined && hash !== recorded.hash)
      stale.push(
        `the patch file ${quote(path)} for ${quote(key)} has changed: it hashes to ${quote(hash)} and pnpm-lock.yaml records ${quote(recorded.hash)}`,
      );
    const text = bytes.toString('utf8');
    readPatchText(text, path);
    patches.set(key, {
      key,
      file: path,
      hash: recorded.hash,
      digest: pnpm10PatchHash(bytes),
      text,
    });
  }
  for (const key of lock.patchedDependencies.keys())
    if (!config.patches.has(key))
      stale.push(
        `pnpm-lock.yaml records a patch for ${quote(key)}, which the project does not declare`,
      );
  return { patches, stale };
}
