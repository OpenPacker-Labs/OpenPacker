/**
 * Materialise a directory from the content-addressed store.
 *
 * Hardlink where the filesystem allows it, copy where it does not, and never
 * symlink. A symlinked layout needs developer mode or elevation on Windows and
 * silently breaks tools that resolve realpath, so the same lockfile would
 * install differently depending on where it ran — the same reason opm ships
 * bin shims rather than symlinks.
 *
 * Hardlinks are safe here because the store is immutable: a store path is
 * named by the digest of its contents, so nothing ever writes to one in place.
 */

import { cp, link, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { ProjectIoError } from './index.js';

export interface MaterialiseResult {
  /** Files linked or copied. */
  files: number;
  /** True when at least one file had to be copied rather than linked. */
  copied: boolean;
}

/**
 * Replace `destination` with the contents of `source`.
 *
 * Replace, not merge: a layout that accumulates files from a previous
 * resolution is a layout nobody can reason about.
 */
export async function materialiseTree(
  source: string,
  destination: string,
  root: string,
): Promise<MaterialiseResult> {
  assertContained(root, destination);
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  const result: MaterialiseResult = { files: 0, copied: false };
  await walk(source, destination, result);
  return result;
}

async function walk(
  source: string,
  destination: string,
  result: MaterialiseResult,
): Promise<void> {
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory()) {
      await mkdir(to, { recursive: true });
      await walk(from, to, result);
      continue;
    }
    if (!entry.isFile()) {
      // The store is built by the materializer, which already refuses
      // symlinks, devices and sockets. Anything else here is not something to
      // reproduce into a project directory on a guess.
      continue;
    }
    try {
      await link(from, to);
    } catch {
      // Cross-device, a filesystem without hardlinks, or a link-count limit.
      await cp(from, to);
      result.copied = true;
    }
    result.files += 1;
  }
}

/**
 * Refuse a destination outside its root.
 *
 * The path is built from a package name that came off a registry, and what
 * happens next is a recursive delete followed by a write. `@evil/../../..` has
 * to stop here.
 */
function assertContained(root: string, destination: string): void {
  const base = resolve(root);
  const target = resolve(destination);
  if (target !== base && !target.startsWith(base + sep))
    throw new ProjectIoError(
      'UNSAFE_PATH',
      destination,
      `Layout destination escapes ${base}: ${destination}`,
    );
}

/** Remove a layout directory if it exists. */
export async function removeTree(path: string): Promise<void> {
  try {
    await stat(path);
  } catch {
    return;
  }
  await rm(path, { recursive: true, force: true });
}

/** Every file under `root`, as archive entries with forward-slash paths. */
export async function collectFiles(
  root: string,
  prefix = '',
): Promise<{ path: string; contents: Uint8Array; executable: boolean }[]> {
  const out: {
    path: string;
    contents: Uint8Array;
    executable: boolean;
  }[] = [];
  const { readFile } = await import('node:fs/promises');
  const walkOne = async (directory: string, at: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const from = join(directory, entry.name);
      const path = at === '' ? entry.name : `${at}/${entry.name}`;
      if (entry.isDirectory()) {
        await walkOne(from, path);
        continue;
      }
      if (!entry.isFile()) continue;
      const info = await stat(from);
      out.push({
        path: prefix === '' ? path : `${prefix}/${path}`,
        contents: new Uint8Array(await readFile(from)),
        executable: (info.mode & 0o111) !== 0,
      });
    }
  };
  await walkOne(root, '');
  return out;
}
