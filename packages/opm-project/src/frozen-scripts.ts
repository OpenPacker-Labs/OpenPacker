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
async function packageDirectory(extracted: string): Promise<string> {
  const children = await readdir(extracted, { withFileTypes: true });
  const only = children.length === 1 ? children[0] : undefined;
  return only?.isDirectory() === true ? join(extracted, only.name) : extracted;
}

/** The two things of a manifest that decide whether an install has anything to run. */
interface InstallFacts {
  /** `preinstall`, `install` and `postinstall`, by whether each is a non-empty command. */
  scripts: Record<'preinstall' | 'install' | 'postinstall', boolean>;
  /** `gypfile: false`, which tells npm not to build `binding.gyp`. */
  gypOff: boolean;
}

async function readInstallFacts(directory: string): Promise<InstallFacts> {
  const handle = await open(
    join(directory, 'package.json'),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAXIMUM_MANIFEST_BYTES)
      return {
        scripts: { preinstall: false, install: false, postinstall: false },
        gypOff: false,
      };
    const parsed: {
      scripts?: Record<string, unknown> | null;
      gypfile?: unknown;
    } | null = JSON.parse(await handle.readFile('utf8'));
    const has = (name: string): boolean => {
      const command = parsed?.scripts?.[name];
      return typeof command === 'string' && command !== '';
    };
    return {
      scripts: {
        preinstall: has('preinstall'),
        install: has('install'),
        postinstall: has('postinstall'),
      },
      gypOff: parsed?.gypfile === false,
    };
  } finally {
    await handle.close();
  }
}

/** Whether the package extracted at `extracted` declares an install script. */
export async function declaresInstallScript(
  extracted: string,
): Promise<boolean> {
  try {
    const directory = await packageDirectory(extracted);
    const { scripts, gypOff } = await readInstallFacts(directory);
    if (scripts.preinstall || scripts.install || scripts.postinstall)
      return true;
    if (gypOff) return false;
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
