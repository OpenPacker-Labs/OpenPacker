/**
 * Hard-linking one file into a tree being materialised, and proving the link is
 * the inode that was inspected.
 *
 * Kept apart from `layout.ts`, which copies; this is the half that shares an
 * inode with the store, where a name swapped between the inspection and the
 * link would otherwise be kept.
 */

import type { BigIntStats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import {
  StableHandleError,
  linkChild,
  lstatChild,
  removeChild,
} from './handle-path.js';
import { unsafe } from './stable-open.js';
import { snapshot, type TreeEntrySnapshot } from './tree-snapshot.js';

/** Why a link attempt means "copy instead" and not "something is wrong". */
const LINK_FALLBACK = new Set([
  'EXDEV',
  'EPERM',
  'ENOTSUP',
  'EOPNOTSUPP',
  'ENOSYS',
  'EMLINK',
]);

export interface LinkState {
  /** Set once the filesystem has said it cannot link; later files just copy. */
  unavailable: boolean;
}

/**
 * Link one file and prove the link is the inode that was inspected.
 *
 * Returns false when the filesystem cannot link, so the caller copies. Any
 * other outcome that is not exactly "the entry I opened, now with one more
 * name" removes the new name and fails closed.
 */
export async function linkVerified(input: {
  source: FileHandle;
  destination: FileHandle;
  name: string;
  file: FileHandle;
  before: BigIntStats;
  relativePath: string;
  link: LinkState;
  sourceSnapshot: Map<string, TreeEntrySnapshot>;
  destinationSnapshot: Map<string, TreeEntrySnapshot>;
}): Promise<boolean> {
  const { destination, name, file, before, relativePath } = input;
  try {
    await linkChild(input.source, name, destination, name);
  } catch (error) {
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const code = (error as NodeJS.ErrnoException).code ?? '';
    if (error instanceof StableHandleError || LINK_FALLBACK.has(code)) {
      // One inode out of links is that file's problem; every other reason
      // means this filesystem will not link at all.
      if (code !== 'EMLINK') input.link.unavailable = true;
      return false;
    }
    throw error;
  }
  const refuse = async (): Promise<never> => {
    await removeChild(destination, name, { force: true }).catch(
      () => undefined,
    );
    throw unsafe(relativePath);
  };
  const placed = await lstatChild(destination, name);
  if (
    !placed.isFile() ||
    BigInt(placed.dev) !== BigInt(before.dev) ||
    BigInt(placed.ino) !== BigInt(before.ino)
  )
    return refuse();
  const after = await file.stat({ bigint: true });
  if (
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    after.size !== before.size ||
    after.mtimeNs !== before.mtimeNs
  )
    return refuse();
  input.sourceSnapshot.set(relativePath, snapshot('file', after, true));
  input.destinationSnapshot.set(relativePath, snapshot('file', placed, true));
  return true;
}
