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

import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { ProviderError, type FrozenPatch } from '@openpacker/adapter-core';
import { O_DIRECTORY, openChild } from '@openpacker/project-io';
import { insidePathProblem } from '../pnpm-lock/source.js';
import type { PnpmLock } from '../pnpm-lock/types.js';
import { patchHashLike, readPatchText } from '../pnpm-patch/index.js';
import type { PnpmProjectConfig } from './config.js';
import { quote } from './quote.js';

/**
 * The most opm reads of the patch files a lock declares: one file, and all of
 * them together. Each is read whole, as bytes and as text, when the lock is
 * read; pnpm reads whatever is there.
 */
export const PATCH_FILE_LIMITS = {
  file: 16 * 1024 * 1024,
  total: 64 * 1024 * 1024,
} as const;

const MiB = 1024 * 1024;

const code = (error: unknown): string | undefined =>
  // SAFETY: Node file errors carry an optional string `code`.
  (error as NodeJS.ErrnoException).code;

/**
 * `use` of the patch file `path` below `root`, opened one directory at a
 * time, following no link, and no larger than one patch file may be.
 */
async function withFileBelow<T>(
  root: string,
  path: string,
  use: (handle: FileHandle, size: number) => Promise<T>,
): Promise<T> {
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
    tooLarge(path, info.size);
    return await use(handle, info.size);
  } finally {
    await handle.close();
  }
}

/**
 * Refuse one patch file past `PATCH_FILE_LIMITS.file`. `atLeast` is for a file
 * read to one byte past the bound, whose size is not known.
 */
function tooLarge(path: string, size: number, atLeast = false): void {
  if (size > PATCH_FILE_LIMITS.file)
    throw new ProviderError(
      'SIZE_LIMIT',
      `the patch file ${quote(path)} is ${atLeast ? 'at least ' : ''}${size} bytes, more than the ${PATCH_FILE_LIMITS.file} opm reads of one patch file`,
    );
}

/**
 * At most one byte more than a patch file may be, from the start of `handle`:
 * a file that grew since it was sized is never held whole, and the byte past
 * the bound is what says it is over it.
 */
async function readBounded(handle: FileHandle): Promise<Buffer> {
  const limit = PATCH_FILE_LIMITS.file + 1;
  const chunks: Buffer[] = [];
  let total = 0;
  while (total < limit) {
    const chunk = Buffer.allocUnsafe(Math.min(MiB, limit - total));
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, total);
    if (bytesRead === 0) break;
    chunks.push(chunk.subarray(0, bytesRead));
    total += bytesRead;
  }
  return Buffer.concat(chunks, total);
}

/** Refuse patch files that come to more than `PATCH_FILE_LIMITS.total`. */
function tooLargeTogether(files: number, size: number): void {
  if (size > PATCH_FILE_LIMITS.total)
    throw new ProviderError(
      'SIZE_LIMIT',
      `the ${files} patch files the project declares come to ${size} bytes, more than the ${PATCH_FILE_LIMITS.total} opm reads of patches for one lock`,
    );
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
  const paths = declared.map(([key, value]) => {
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
    return path;
  });
  // Every file is sized before any is read, so patches past the total are
  // refused without holding them.
  let size = 0;
  for (const path of paths)
    size += await withFileBelow(root, path, async (_, bytes) => bytes);
  tooLargeTogether(paths.length, size);
  let read = 0;
  for (const [index, [key]] of declared.entries()) {
    const path = paths[index]!;
    const bytes = await withFileBelow(root, path, readBounded);
    // A file that grew since it was sized is held to the bounds again.
    tooLarge(path, bytes.length, bytes.length > PATCH_FILE_LIMITS.file);
    read += bytes.length;
    tooLargeTogether(paths.length, read);
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
      // The bytes applied, not pnpm's hash of them with CRLF made LF: an LF
      // and a CRLF checkout of one patch install different files.
      digest: createHash('sha256').update(bytes).digest('hex'),
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
