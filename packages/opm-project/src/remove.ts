import { digestOf, uninstallPackages } from './install.js';
import { reachableKeys } from './lock-edges.js';
import { applyKeys, rekeyTransitive } from './lock-rekey.js';
import { emptyLockfile, readLockfile, writeLockfile } from './lock.js';
import type { NativeProjectionReport } from './native.js';
import { projectNativeFormats } from './native.js';
import { MANIFEST_NAME, projectPaths } from './paths.js';
import { readManifestFile, writeManifestFile } from './project.js';
import { renameInstalled } from './rename-installed.js';
import { serializeManifest } from './toml.js';
import type { OpmLockfile, OpmManifest, ProjectState } from './types.js';
import { OpmError } from './types.js';
import { recoverInterruptedSteps } from './rollback-recovery.js';
import { manifestAliasNamed } from './why.js';

/**
 * Take a requirement out of the project, and everything only it needed.
 *
 * What is left is the lock a fresh resolve would write for the smaller
 * manifest: a package that stays because something else needs it is a
 * dependency now (it has no install name of its own to keep), and a name the
 * removal left at one version takes the key a name held once has
 * (`rekeyTransitive`), since `opm install` compares the lock with a fresh
 * resolve. ADR 0054.
 */
export async function removePackage(input: {
  root: string;
  /** The requirement's alias, or a PURL that names exactly one requirement. */
  alias: string;
  offline?: boolean;
}): Promise<{
  /** The alias that was removed. */
  alias: string;
  manifest: OpmManifest;
  lock: OpmLockfile;
  state: ProjectState;
  native?: NativeProjectionReport;
}> {
  const paths = projectPaths(input.root);
  // A step a killed process left half way is finished first.
  await recoverInterruptedSteps(input.root);
  const manifest = await readManifestFile(paths.manifest);
  const alias = manifestAliasNamed(manifest, input.alias);
  if (alias === undefined) {
    throw new OpmError(
      'NOT_FOUND',
      `Package "${input.alias}" is not in ${MANIFEST_NAME}`,
    );
  }
  delete manifest.packages[alias];
  await writeManifestFile(paths.manifest, manifest);

  const lock = (await readLockfile(paths.lock)) ?? emptyLockfile();
  const previousAliases = Object.keys(lock.packages);
  const removed = lock.packages[alias];
  if (removed) {
    removed.reason = 'transitive';
    // Whatever still needs it finds it under its own name; nothing asks for
    // the install name the project gave it.
    delete removed.installName;
  }
  const reachable = reachableKeys(
    lock.packages,
    Object.keys(manifest.packages),
  );
  const pruned = previousAliases.filter((alias) => !reachable.has(alias));
  for (const alias of pruned) delete lock.packages[alias];
  const renamed = rekeyTransitive(lock);
  applyKeys(lock, renamed);
  lock.manifestDigest = digestOf(
    new TextEncoder().encode(serializeManifest(manifest)),
  );
  await writeLockfile(paths.lock, lock);

  const afterRemoval = await uninstallPackages({
    root: input.root,
    aliases: pruned,
  });
  // A package that took another key keeps what is installed: its record and
  // link move to the key it has now.
  const state =
    renamed.size === 0
      ? afterRemoval
      : await renameInstalled({ root: input.root, renamed });

  // Removing from opm.toml and leaving the entry in package.json would let the
  // native tool reinstall what opm just took out.
  const native = await projectNativeFormats({
    root: input.root,
    manifest,
    lock,
  });

  return { alias, manifest, lock, state, native };
}
