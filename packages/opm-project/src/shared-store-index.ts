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
import type { ArchivePlatform } from '@openpacker/adapter-core';
import { OpmError } from './types.js';
import {
  assertDigest,
  ensureStableDirectory,
  readStableFile,
  writeStableFile,
} from './paths.js';

export const INTEGRITY_INDEX = 'by-integrity';

const KEY = /^(?:sha512|sha384|sha256|sha1)-[0-9a-f]{40,128}$/u;

/** Whether `name` is an integrity key, so a file of that name in the index is a record. */
export function isIntegrityKey(name: string): boolean {
  return KEY.test(name);
}

/** A record that is not there, or not there to read, is a miss. */
function isIndexMiss(error: unknown): boolean {
  // SAFETY: Node file errors carry a string `code`.
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

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
    if (isIndexMiss(error)) return undefined;
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

/**
 * What an archive declared it runs on, recorded against its integrity when an
 * install read it (ADR 0059): `by-integrity/<key>.platform`, the lists as
 * JSON. A build left out for another C library is never stored, so this is
 * what lets a later install, online or offline, leave it out without fetching
 * it again. The bytes behind an integrity never change, so neither does what
 * they declare; `opm gc --shared` removes these records as it removes entries
 * nothing links (`shared-store-gc.ts`).
 */
const PLATFORM = '.platform';
const PLATFORM_LISTS = ['os', 'cpu', 'libc'] as const;
const MAXIMUM_PLATFORM_BYTES = 16 * 1024;

/** Whether `name` is a platform record of the index. */
export function isPlatformRecord(name: string): boolean {
  return name.endsWith(PLATFORM) && KEY.test(name.slice(0, -PLATFORM.length));
}

/** The lists a record holds, or undefined when it is not one. */
export function parsePlatformRecord(text: string): ArchivePlatform | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    return undefined;
  const platform: { os?: string[]; cpu?: string[]; libc?: string[] } = {};
  for (const [field, value] of Object.entries(parsed)) {
    if (
      !PLATFORM_LISTS.some((list) => list === field) ||
      !Array.isArray(value) ||
      value.length === 0 ||
      !value.every((item): item is string => typeof item === 'string')
    )
      return undefined;
    // SAFETY: `field` is one of PLATFORM_LISTS, checked just above.
    platform[field as (typeof PLATFORM_LISTS)[number]] = value;
  }
  return platform;
}

/** What the archive an integrity key names declared, when an install recorded it. */
export async function lookupArchivePlatform(
  sharedRoot: string,
  key: string,
): Promise<ArchivePlatform | undefined> {
  let text: string;
  try {
    text = await readStableFile(
      `${indexPath(sharedRoot, key)}${PLATFORM}`,
      MAXIMUM_PLATFORM_BYTES,
    );
  } catch (error) {
    if (isIndexMiss(error)) return undefined;
    throw error;
  }
  // A malformed record is as good as none: the archive is fetched again.
  return parsePlatformRecord(text);
}

/** Record what the archive an integrity key names declared; written whole, atomically. */
export async function recordArchivePlatform(
  sharedRoot: string,
  key: string,
  platform: ArchivePlatform,
): Promise<void> {
  await ensureStableDirectory(join(sharedRoot, INTEGRITY_INDEX));
  const lists: Record<string, readonly string[]> = {};
  for (const field of PLATFORM_LISTS)
    if (platform[field] !== undefined) lists[field] = platform[field];
  const record = `${JSON.stringify(lists)}\n`;
  const path = `${indexPath(sharedRoot, key)}${PLATFORM}`;
  try {
    await writeStableFile(path, record);
  } catch (error) {
    // Two installs recording what one archive declared write the same text.
    if (
      !(error instanceof OpmError && error.code === 'INPUT_CHANGED') ||
      (await readStableFile(path).catch(() => '')) !== record
    )
      throw error;
  }
}
