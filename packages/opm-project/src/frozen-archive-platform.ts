/**
 * What an optional package's archive says it runs on, read before the archive
 * is extracted.
 *
 * A lock restricts a native build by `os` and `cpu` and often says nothing of
 * the C library: registry metadata long lacked `libc`, and npm and pnpm wrote
 * their locks from it. So a musl build is listed as for linux/x64, and an
 * install on a glibc machine would put it in the store and in `node_modules`,
 * where it cannot run (OpenSesame's lock: seven of them, 322 MiB). The archive's
 * own `package.json` says musl. The format marks the packages whose lock entry
 * leaves the C library unsaid (`platformFromArchive`); the host reads those
 * archives' lists here, from the store's copy or from the fetched bytes, and
 * the format decides with them (`archiveRuns`, then `archivePlatforms`).
 */

import type { ArchivePlatform } from '@openpacker/adapter-core';
import {
  inspectArchive,
  type ArchiveFormat,
  type MaterializationLimits,
} from '@openpacker/materializer';
import { readArchiveManifest, type ArchiveManifest } from './frozen-scripts.js';

const LISTS = ['os', 'cpu', 'libc'] as const;
const MAXIMUM_MANIFEST_BYTES = 4 * 1024 * 1024;

/** The lists a manifest declares: a string is a list of one, as npm reads it; anything else is no list. */
export function platformOfManifest(
  manifest: ArchiveManifest | undefined,
): ArchivePlatform {
  const platform: { os?: string[]; cpu?: string[]; libc?: string[] } = {};
  for (const field of LISTS) {
    const value = manifest?.[field];
    const list =
      typeof value === 'string'
        ? [value]
        : Array.isArray(value) &&
            value.every((item): item is string => typeof item === 'string')
          ? value
          : undefined;
    if (list !== undefined && list.length > 0) platform[field] = list;
  }
  return platform;
}

/** Whether a manifest declared any list at all. */
export function declaresPlatform(platform: ArchivePlatform): boolean {
  return LISTS.some((field) => platform[field] !== undefined);
}

/** The lists of a package already extracted (a store entry). */
export async function platformOfTree(
  extracted: string,
): Promise<ArchivePlatform> {
  try {
    return platformOfManifest(await readArchiveManifest(extracted));
  } catch {
    return {};
  }
}

/**
 * The lists of an archive that is not extracted: its `package.json`, in the
 * one directory the archive wraps its files in (as `packageDirectory` finds
 * it in an extracted tree), else at its top. The archive is read under the
 * limits its extraction would be, so nothing larger is expanded than would be.
 */
export async function platformOfBytes(
  bytes: Uint8Array,
  format: ArchiveFormat,
  limits: MaterializationLimits,
): Promise<ArchivePlatform> {
  const entries = await inspectArchive(bytes, format, limits);
  const tops = new Set(entries.map((entry) => entry.path.split('/')[0]!));
  const only = tops.size === 1 ? [...tops][0]! : undefined;
  const wrapped =
    only !== undefined &&
    entries.some(
      (entry) => entry.path !== only && entry.path.startsWith(`${only}/`),
    );
  const path = wrapped ? `${only}/package.json` : 'package.json';
  const file = entries.find(
    (entry) => entry.type === 'file' && entry.path === path,
  );
  if (file === undefined || file.data.byteLength > MAXIMUM_MANIFEST_BYTES)
    return {};
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(file.data));
    return typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? platformOfManifest(parsed)
      : {};
  } catch {
    return {};
  }
}
