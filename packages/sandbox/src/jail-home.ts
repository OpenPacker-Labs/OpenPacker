import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  abandonedByOwnerAt,
  openStablePath,
  readDirChildWithTypes,
  removeChild,
  renameChild,
  writeOwnerFile,
  type AbandonJudge,
  type ProcessOwner,
} from '@openpacker/project-io';

/**
 * The home a sandboxed process gets ($HOME, with $TMPDIR in it), one per run,
 * under the jail root (`defaultJailHomeRoot`), removed when the run ends.
 *
 * A run killed outright (SIGKILL, a crash, a second signal while opmx is
 * removing what it made) never removes it, and with whatever the tool wrote to
 * its home it stayed in the temporary directory for good. So each run's
 * directory `home-<uuid>` holds who made it, in `.owner`, written before
 * anything else (`writeOwnerFile`, ADR 0056's record), and the home itself in
 * `home`, which is all the sandbox binds: a tool never sees or writes its
 * owner. Every run first removes the homes whose owner has ended, by the one
 * rule every holder opm records is judged by (`abandonedByOwner`, the owner
 * rule of `process-owner.ts`): a home whose owner may still be running, runs
 * elsewhere, or cannot be read is never touched.
 *
 * A home with no `.owner` was made by an opm from before this (its home was the
 * directory itself) or by a run cut short between making the directory and
 * writing the file. Nothing says whose it is, so it is removed only once it has
 * not changed for {@link UNOWNED_JAIL_HOME_MS}.
 *
 * A home is removed by renaming it first to a name no run uses
 * (`.home-<uuid>.sweep-<uuid>`), as the shared store unpublishes an entry it
 * collects: of two runs that judge one home together, one renames it and the
 * other finds it gone, and nothing is removed under a name a run may hold. A
 * tombstone a run was killed before removing is removed by the next.
 */

/** The name every run's directory starts with. */
export const JAIL_HOME_PREFIX = 'home-';

/**
 * How long a home with no owner is kept: a week. An opm from before owners
 * were recorded gave its run nothing else, and a tool it still runs (a server
 * left up) keeps writing there; a week is longer than such a run is likely to
 * go without, and a home left by a killed one costs only its disk meanwhile.
 */
export const UNOWNED_JAIL_HOME_MS = 7 * 24 * 60 * 60 * 1000;

/** The directory inside a run's directory that is the jail's home. */
const HOME = 'home';

/** A tombstone: a home renamed away, to be removed. */
const TOMBSTONE = /^\.home-.+\.sweep-[0-9a-f-]{36}$/u;

/** A run's jail home: its directory, and the home inside it. */
export interface JailHome {
  /** `<root>/home-<uuid>`: `.owner` and `home`. */
  path: string;
  /** `<path>/home`, which holds `tmp`: the run's $HOME. */
  home: string;
}

/**
 * Make a jail home under `root` that this process owns (or `owner`, for a
 * test). Nothing is left behind when it cannot be made whole.
 */
export async function makeJailHome(
  root: string,
  owner?: ProcessOwner,
): Promise<JailHome> {
  const path = join(root, `${JAIL_HOME_PREFIX}${randomUUID()}`);
  await mkdir(path, { mode: 0o700 });
  const home = join(path, HOME);
  try {
    await writeOwnerFile(path, owner);
    await mkdir(join(home, 'tmp'), { recursive: true, mode: 0o700 });
  } catch (error) {
    await removeJailHome({ path, home });
    throw error;
  }
  return { path, home };
}

/** Remove a run's own jail home when it ends. */
export async function removeJailHome(jail: JailHome): Promise<void> {
  await rm(jail.path, { recursive: true, force: true }).catch(() => undefined);
}

/**
 * Remove, under `root`, the homes whose owner has ended and the tombstones
 * left by a run killed while it removed one. Nothing that cannot be judged is
 * touched, and a failure removes nothing more: a run does not depend on it.
 */
export async function sweepJailHomes(
  root: string,
  judge: AbandonJudge = {},
  /** Test seam: called with each home's name before it is judged. */
  seams: { beforeJudging?: (name: string) => Promise<void> } = {},
): Promise<void> {
  const parent = await openStablePath(root).catch(() => undefined);
  if (parent === undefined) return;
  try {
    for (const entry of await readDirChildWithTypes(parent)) {
      if (!entry.isDirectory()) continue;
      const name = entry.name;
      if (TOMBSTONE.test(name)) {
        await removeChild(parent, name, { recursive: true, force: true }).catch(
          () => undefined,
        );
        continue;
      }
      if (!name.startsWith(JAIL_HOME_PREFIX)) continue;
      await seams.beforeJudging?.(name);
      // Judged through a handle of it, opened without following a link.
      const abandoned = await abandonedByOwnerAt(
        parent,
        name,
        UNOWNED_JAIL_HOME_MS,
        judge,
      ).catch(() => false);
      if (!abandoned) continue;
      // Renamed away first: of two runs that judged it, one removes it.
      const tombstone = `.${name}.sweep-${randomUUID()}`;
      const taken = await renameChild(parent, name, tombstone).then(
        () => true,
        () => false,
      );
      if (!taken) continue;
      await removeChild(parent, tombstone, {
        recursive: true,
        force: true,
      }).catch(() => undefined);
    }
  } catch {
    // An unreadable root sweeps nothing; the run goes on.
  } finally {
    await parent.close().catch(() => undefined);
  }
}
