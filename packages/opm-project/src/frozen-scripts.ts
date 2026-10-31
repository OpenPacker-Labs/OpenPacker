/**
 * Which installed packages declare an install script.
 *
 * An npm lock says (`hasInstallScript`). A pnpm lock does not, so the host
 * reads it from the archive it has extracted, the way npm does when it writes
 * the lock: a `preinstall`, `install` or `postinstall` script, or a
 * `binding.gyp` with no install script of its own (which npm builds with
 * `node-gyp rebuild`). Nothing here runs one (ADR 0046 §9).
 */

import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { FrozenLockPackage } from '@openpacker/adapter-core';

const MAXIMUM_MANIFEST_BYTES = 4 * 1024 * 1024;

/** The directory the package's own files are in: archives wrap them in one directory. */
export async function packageDirectory(extracted: string): Promise<string> {
  const children = await readdir(extracted, { withFileTypes: true });
  const only = children.length === 1 ? children[0] : undefined;
  return only?.isDirectory() === true ? join(extracted, only.name) : extracted;
}

/** The fields of an archive's `package.json` the host reads. */
export interface ArchiveManifest {
  readonly name?: unknown;
  readonly version?: unknown;
  readonly scripts?: Record<string, unknown> | null;
  readonly gypfile?: unknown;
  readonly os?: unknown;
  readonly cpu?: unknown;
  readonly libc?: unknown;
}

/**
 * The `package.json` of the package extracted at `extracted`, read without
 * following a link and bounded; undefined when it is not a regular file of at
 * most 4 MiB or not a JSON object.
 */
export async function readArchiveManifest(
  extracted: string,
): Promise<ArchiveManifest | undefined> {
  const directory = await packageDirectory(extracted);
  const handle = await open(
    join(directory, 'package.json'),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAXIMUM_MANIFEST_BYTES) return undefined;
    const parsed: unknown = JSON.parse(await handle.readFile('utf8'));
    return typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? parsed
      : undefined;
  } finally {
    await handle.close();
  }
}

/** Whether the package extracted at `extracted` declares an install script. */
export async function declaresInstallScript(
  extracted: string,
): Promise<boolean> {
  try {
    const manifest = await readArchiveManifest(extracted);
    const has = (name: string): boolean => {
      const command = manifest?.scripts?.[name];
      return typeof command === 'string' && command !== '';
    };
    if (has('preinstall') || has('install') || has('postinstall')) return true;
    if (manifest?.gypfile === false) return false;
    const directory = await packageDirectory(extracted);
    return (await lstat(join(directory, 'binding.gyp'))).isFile();
  } catch {
    return false;
  }
}

/**
 * For each package, by path, whether it declares an install script: the lock's
 * word when it has one, the archive's when the lock does not say.
 */
export async function installScriptFlags(
  packages: readonly FrozenLockPackage[],
  archives: ReadonlyMap<string, { readonly path: string }>,
): Promise<Map<string, boolean>> {
  const byArchive = new Map<string, boolean>();
  const flags = new Map<string, boolean>();
  for (const pkg of packages) {
    if (pkg.scriptsFromArchive !== true) {
      flags.set(pkg.path, pkg.hasInstallScript);
      continue;
    }
    const extracted = archives.get(pkg.path)!.path;
    if (!byArchive.has(extracted))
      byArchive.set(extracted, await declaresInstallScript(extracted));
    flags.set(pkg.path, byArchive.get(extracted)!);
  }
  return flags;
}

/**
 * The packages that declare an install script, each once: a package placed in
 * several places (a pnpm instance with several dependents, or several peer
 * variants of one archive) is one package with one script, so it is listed at
 * its first place.
 */
export function scriptedPackages(
  packages: readonly FrozenLockPackage[],
  declares: ReadonlyMap<string, boolean>,
  archives: ReadonlyMap<string, { readonly path: string }>,
): { name: string; version: string; path: string }[] {
  const listed = new Set<string>();
  const out: { name: string; version: string; path: string }[] = [];
  for (const pkg of packages) {
    if (declares.get(pkg.path) !== true) continue;
    const key = `${archives.get(pkg.path)?.path ?? pkg.path}\0${pkg.packageName}@${pkg.version}`;
    if (listed.has(key)) continue;
    listed.add(key);
    out.push({ name: pkg.packageName, version: pkg.version, path: pkg.path });
  }
  return out;
}
