import {
  installFromLock,
  readProjectState,
  uninstallPackages,
} from './install.js';
import { serializeLockfile } from './lock.js';
import { projectNativeFormats, type NativeProjectionReport } from './native.js';
import { projectPaths, writeStableFile } from './paths.js';
import { snapshotProject, type ProjectSnapshot } from './project-rollback.js';
import { serializeManifest } from './toml.js';
import type { OpmLockfile, OpmManifest, ProjectState } from './types.js';

/**
 * Install a lock that was just resolved, and write it, as one step: `opm add`,
 * `opm sync` and `opm update` either finish or leave the project as it was.
 *
 * Nothing outside the store changes until every package of the lock is in it,
 * so a package that cannot be fetched, verified or extracted stops the step
 * with opm.toml, the lock and node_modules untouched (`beforeLinking`). From
 * there the project is kept (`project-rollback.ts`) before opm.toml and the
 * lock are written, and a failure while linking or laying out node_modules (a
 * bin or a place in the layout that cannot be written) puts all of it back.
 */
export async function commitInstall(input: {
  root: string;
  manifest: OpmManifest;
  lock: OpmLockfile;
  offline: boolean;
  /** Write opm.toml too: add and update --latest change it, sync does not. */
  writeManifest: boolean;
}): Promise<{ state: ProjectState; native: NativeProjectionReport }> {
  const paths = projectPaths(input.root);
  const { manifest, lock } = input;
  let snapshot: ProjectSnapshot | undefined;
  try {
    const state = await installFromLock({
      root: input.root,
      lock,
      offline: input.offline,
      ...(!(manifest.policy === undefined) && { policy: manifest.policy }),
      beforeLinking: async () => {
        const manifestText = input.writeManifest
          ? serializeManifest(manifest)
          : undefined;
        const lockText = serializeLockfile(lock);
        // opm.toml is the step's to undo only if the step wrote it; one that
        // leaves it alone (sync) records it as it is, so that a hand edit
        // after a kill is not put back over.
        snapshot = await snapshotProject(input.root, {
          manifest: manifestText ?? 'unchanged',
          lock: lockText,
        });
        if (manifestText !== undefined)
          await writeStableFile(paths.manifest, manifestText);
        await writeStableFile(paths.lock, lockText);
        // What is installed under a key the lock no longer has: adding the
        // package that makes a name two versions re-keys the first
        // (`ansi-regex` is `ansi-regex.5.0.1` and `ansi-regex.6.4.0` now),
        // and the old record would go on being listed as installed.
        const stale = Object.keys(
          (await readProjectState(paths.projectState))?.packages ?? {},
        ).filter((key) => !lock.packages[key]);
        if (stale.length > 0)
          await uninstallPackages({ root: input.root, aliases: stale });
      },
    });
    // Last, and only after the store is real: a native manifest that names a
    // package the resolve never produced would send the native tool looking
    // for something opm does not have.
    const native = await projectNativeFormats({
      root: input.root,
      manifest,
      lock,
    });
    await snapshot?.discard();
    return { state, native };
  } catch (error) {
    if (snapshot !== undefined)
      await undoStep(
        error instanceof Error ? error : new Error(String(error)),
        snapshot,
      );
    throw error;
  }
}

/**
 * Put the project back after the step failed with `error`. When that fails
 * too, both are reported: the step's error says why the step stopped, the
 * other why the project is not as it was. The copy stays, `ready`, for the
 * next step to put back.
 */
export async function undoStep(
  error: Error,
  snapshot: ProjectSnapshot,
): Promise<void> {
  try {
    await snapshot.restore();
  } catch (failed) {
    const reason = failed instanceof Error ? failed.message : String(failed);
    throw new AggregateError(
      [error, failed],
      `${error.message}; putting the project back failed too (${reason}), and the next opm step that changes the project puts it back`,
    );
  }
}
