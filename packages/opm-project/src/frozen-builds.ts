/**
 * The install scripts a project approved, run where npm runs them.
 *
 * `opm ci` runs no install script by default (ADR 0046 §9). A project that
 * needs one approves it by name in a declaration package managers already
 * read (the lock's `approvedBuilds`: pnpm's `onlyBuiltDependencies` and
 * `allowBuilds`, Bun's `trustedDependencies`), and only that package's
 * `preinstall`, `install` and `postinstall` run (ADR 0060):
 *
 * - in the package's own directory under `node_modules`, after the layout, so
 *   the script finds its dependencies the way it does under npm;
 * - inside the package-exec jail, with that directory writable, the project
 *   read-only and no network;
 * - on the package's own copies of its files: they are hard links into the
 *   shared store until then, and the store is never written through them;
 * - and a symbolic link the script leaves inside its directory, to a file of
 *   its own, becomes a hard link to that file (`node_modules` holds no symlink
 *   but a workspace member's, ADR 0048). Any other link fails the install.
 */

import { randomUUID } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { realpath, type FileHandle } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import type { FrozenLock, FrozenLockPackage } from '@openpacker/adapter-core';
import type { PolicyInput } from '@openpacker/contracts';
import {
  lstatChild,
  readlinkChild,
  readDirChildWithTypes,
} from '@openpacker/project-io';
import {
  detectNpmLifecycleScripts,
  runDeclaredLifecycleScripts,
} from './lifecycle.js';
import { openStableDirectory, removeChild, renameChild } from './paths.js';
import { isolateProjectStoreFromSharedLinks } from './shared-store-tree.js';
import { linkVerified } from './stable-ops.js';
import { OpmError } from './types.js';

/** A package whose approved scripts ran. */
export interface BuiltPackage {
  name: string;
  version: string;
  path: string;
}

/** Whether the project approved this package's install scripts, by name or `name@version`. */
export function buildApproved(
  approved: FrozenLock['approvedBuilds'],
  pkg: Pick<FrozenLockPackage, 'packageName' | 'version'>,
): boolean {
  return (
    approved !== undefined &&
    (approved.entries.includes(pkg.packageName) ||
      approved.entries.includes(`${pkg.packageName}@${pkg.version}`))
  );
}

/** The jail's policy for one approved package: its scripts, and nothing else. */
function approvalPolicy(purl: string): PolicyInput {
  // SAFETY: the fields the lifecycle funnel reads; the rest keep their defaults.
  return {
    allowYanked: false,
    allowQuarantined: false,
    semanticLossMaximum: 'warning',
    requiredEvidence: [],
    allowLifecycleScripts: false,
    allowedLifecycleScriptPackages: [purl],
    sandboxMode: 'fail-closed',
    sandboxRequired: true,
  } as PolicyInput;
}

/** As many links one name is followed through, as Linux follows. */
const MAXIMUM_LINKS = 40;

/** A regular file of the package's own, open where it lies. */
interface PackageFile {
  readonly parent: FileHandle;
  readonly name: string;
  readonly info: BigIntStats;
}

/**
 * The regular file the link `path` (saying `text`) leads to inside `top`,
 * followed link by link, each directory on the way opened no-follow from the
 * base it lies under; undefined when it leaves `top`, passes through a link to
 * a directory, or ends at anything but a regular file.
 */
async function fileOfPackage(
  top: string,
  path: string,
  text: string,
  followed = 0,
): Promise<PackageFile | undefined> {
  const target = resolve(dirname(path), text);
  if (followed >= MAXIMUM_LINKS || !target.startsWith(`${top}${sep}`))
    return undefined;
  const parent = await openStableDirectory(dirname(target)).catch(
    () => undefined,
  );
  if (parent === undefined) return undefined;
  const name = basename(target);
  try {
    const info = await lstatChild(parent, name).catch(() => undefined);
    if (info?.isFile() === true) return { parent, name, info };
    const next = info?.isSymbolicLink()
      ? await readlinkChild(parent, name)
      : undefined;
    await parent.close();
    return next === undefined
      ? undefined
      : await fileOfPackage(top, target, next, followed + 1);
  } catch (error) {
    await parent.close().catch(() => undefined);
    throw error;
  }
}

/**
 * Make each symbolic link under `dir` that names a file under `dir` a hard
 * link to that file, and refuse any other. Every directory is opened no-follow
 * from the base it lies under, and the link is read, the file linked and the
 * new name given through their directories' handles (ADR 0034): a directory
 * swapped for a link since the script ran is refused, and nothing is linked,
 * renamed or removed where it points. Exported for its tests.
 */
export async function linksToFiles(
  dir: string,
  label: string,
  top = dir,
): Promise<void> {
  const handle = await openStableDirectory(dir);
  try {
    for (const entry of await readDirChildWithTypes(handle)) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await linksToFiles(path, label, top);
        continue;
      }
      if (!entry.isSymbolicLink()) continue;
      const text = await readlinkChild(handle, entry.name);
      const file = await fileOfPackage(top, path, text);
      if (file === undefined)
        throw new OpmError(
          'UNSAFE_PATH',
          `The install script of ${label} left the link ${relative(top, path)} -> ${text}, which is not a file of the package's own; node_modules holds no symlink but a workspace member's`,
        );
      const temporary = `.${entry.name}.opm-link-${randomUUID()}`;
      try {
        // A hard link proved to be the file that was judged, under a name of
        // its own, then put in the link's place in one rename.
        await linkVerified(
          file.parent,
          file.name,
          file.info,
          handle,
          temporary,
          path,
        );
        await renameChild(handle, temporary, entry.name);
      } finally {
        await file.parent.close();
        await removeChild(handle, temporary, { force: true }).catch(
          () => undefined,
        );
      }
    }
  } finally {
    await handle.close();
  }
}

/**
 * Run the approved install scripts of the packages `lock` places under
 * `root`, each in place, and say which ran. A script that fails stops the
 * install, as it stops npm's.
 */
export async function runApprovedBuilds(input: {
  root: string;
  lock: Pick<FrozenLock, 'packages' | 'approvedBuilds'>;
  /** Whether each package declares an install script, by path. */
  declares: ReadonlyMap<string, boolean>;
}): Promise<BuiltPackage[]> {
  const built: BuiltPackage[] = [];
  if (input.lock.approvedBuilds === undefined) return built;
  const root = await realpath(input.root);
  for (const pkg of input.lock.packages) {
    if (input.declares.get(pkg.path) !== true) continue;
    if (!buildApproved(input.lock.approvedBuilds, pkg)) continue;
    const dir = join(root, ...pkg.path.split('/'));
    await isolateProjectStoreFromSharedLinks(dir);
    const declared = await detectNpmLifecycleScripts(dir);
    await runDeclaredLifecycleScripts({
      declared,
      packageDir: dir,
      packageId: pkg.purl,
      policy: approvalPolicy(pkg.purl),
      readonlyPaths: [root],
      pathPrefix: [
        join(dir, 'node_modules', '.bin'),
        join(root, 'node_modules', '.bin'),
        dirname(process.execPath),
      ],
    });
    await linksToFiles(dir, `${pkg.packageName}@${pkg.version} (${pkg.path})`);
    built.push({ name: pkg.packageName, version: pkg.version, path: pkg.path });
  }
  return built;
}
