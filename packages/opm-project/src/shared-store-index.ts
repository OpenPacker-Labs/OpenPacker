/**
 * Which shared store entry holds the archive a lock's integrity names.
 *
 * Entries are keyed by the sha256 of their archive, but a package-lock pins
 * with sha512 (or sha1), so a frozen install cannot go from "the lock says
 * this digest" to "the store has it" without downloading the archive to hash
 * it. This index is that step: `by-integrity/<algorithm>-<hex>` holds the
 * entry's sha256 digest, written only after the bytes were verified against
 * that integrity value.
 *
 * The index names where to look, nothing more. The entry it points at is
 * adopted the usual way (its tree is re-hashed against the digest recorded
 * when it was published), so a stale or edited index file can cost a download
 * and cannot cost a wrong package.
 */

import { join } from 'node:path';
import { OpmError } from './types.js';
import {
  assertDigest,
  ensureStableDirectory,
  readStableFile,
  writeStableFile,
} from './paths.js';

export const INTEGRITY_INDEX = 'by-integrity';

const KEY = /^(?:sha512|sha384|sha256|sha1)-[0-9a-f]{40,128}$/u;

function indexPath(sharedRoot: string, key: string): string {
  if (!KEY.test(key))
    throw new OpmError('INVALID_DIGEST', `Invalid integrity key ${key}`);
  return join(sharedRoot, INTEGRITY_INDEX, key);
}

/** The archive digest recorded for an integrity key, or undefined. */
export async function lookupArchiveDigest(
  sharedRoot: string,
  key: string,
): Promise<string | undefined> {
  let text: string;
  try {
    text = await readStableFile(indexPath(sharedRoot, key));
  } catch (error) {
    // SAFETY: Node file errors carry a string `code`.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    return assertDigest(text.trim());
  } catch {
    // A malformed record is as good as none: the archive is fetched again.
    return undefined;
  }
}

/** Record which archive digest an integrity key names. */
export async function recordArchiveDigest(
  sharedRoot: string,
  key: string,
  digest: string,
): Promise<void> {
  await ensureStableDirectory(join(sharedRoot, INTEGRITY_INDEX));
  const record = `${assertDigest(digest)}\n`;
  const path = indexPath(sharedRoot, key);
  try {
    await writeStableFile(path, record);
  } catch (error) {
    // Two installs recording the same bytes replace each other's file; the same
    // content is not a conflict.
    if (
      !(error instanceof OpmError && error.code === 'INPUT_CHANGED') ||
      (await readStableFile(path).catch(() => '')) !== record
    )
      throw error;
  }
}
