import { randomUUID } from 'node:crypto';
import { constants, existsSync } from 'node:fs';
import { mkdir, type FileHandle } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  abandonedByOwnerAt,
  mkdirChild,
  O_DIRECTORY,
  openChild,
  openStablePath,
  readDirChildWithTypes,
  removeChild,
  renameChild,
  writeOwnerFileAt,
  type AbandonJudge,
  type ProcessOwner,
} from '@openpacker/project-io';
import { JailPathError } from './paths.js';

/**
 * The home a sandboxed process gets ($HOME, with $TMPDIR in it), one per run,
 * under the jail root (`defaultJailHomeRoot`), removed when the run ends.
 *
 * A run killed outright (SIGKILL, a crash, a second signal while opmx is
 * removing what it made) never removes it, and with whatever the tool wrote to
 * its home it stayed in the temporary directory for good. So each run's
 * directory `home-<uuid>` holds who made it, in `.owner`, written before
 * anything else (`writeOwnerFileAt`, ADR 0056's record, through a handle of
 * the directory, as `home` and its `tmp` are made), and the home itself in
 * `home`, which is all the sandbox binds of it: a tool never writes its owner,
 * and in the package-exec profile with the temporary directory under /tmp or
 * /var/tmp (which bwrap mounts empty) it does not see it either. Where the
 * whole file system is bound read-only (`legacy_fat_root`, host installers),
 * or the temporary directory is somewhere the run binds (inside its project,
 * say), the jail root is visible read-only, and with it every home's `.owner`,
 * as the homes themselves were before. Every run first removes the homes whose owner has ended, by the one
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

/** How a directory made here is opened again: as a directory, never through a link. */
const DIRECTORY =
  constants.O_RDONLY | O_DIRECTORY | (constants.O_NOFOLLOW ?? 0);

/** A tombstone: a home renamed away, to be removed. */
const TOMBSTONE = /^\.home-.+\.sweep-[0-9a-f-]{36}$/u;

/** A run's jail home: its directory, and the home inside it. */
export interface JailHome {
  /** `<root>/home-<uuid>`: `.owner` and `home`. */
  path: string;
  /** `<path>/home`, which holds `tmp`: the run's $HOME. */
  home: string;
}

/** The jail root, opened and checked: what every home is made, judged and removed through. */
export interface JailRoot {
  path: string;
  handle: FileHandle;
}

/**
 * Open the jail root `path`, making it (0700) when it is not there, and
 * refuse it unless it is a directory this process's user owns that others may
 * not write. It sits in the temporary directory, which every user can write: a
 * root another user made, or left writable by all, would let that user put a
 * home there whose owner this run then judges, or a link where a home goes. A
 * root of this user's that its group may read or write (an older opm made it
 * under umask 002, or 022) is made 0700. The checks, and that change, are made
 * on the handle every later step goes through, never on the path again.
 */
export async function openJailRoot(path: string): Promise<JailRoot> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  let handle: FileHandle;
  try {
    handle = await openStablePath(path);
  } catch (error) {
    throw new JailPathError(
      'root',
      `${path} must be a directory reached without a link (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  try {
    const info = await handle.stat();
    const uid = process.geteuid?.();
    if (!info.isDirectory())
      throw new JailPathError('root', `${path} is not a directory`);
    if (uid !== undefined && info.uid !== uid)
      throw new JailPathError(
        'root',
        `${path} is owned by uid ${info.uid}, not by this user (uid ${uid}); remove it, or set TMPDIR to a directory of your own`,
      );
    if (process.platform !== 'win32' && (info.mode & 0o002) !== 0)
      throw new JailPathError(
        'root',
        `${path} can be written by others (mode ${(info.mode & 0o777).toString(8)}); it must be writable by its owner alone`,
      );
    if (process.platform !== 'win32' && (info.mode & 0o077) !== 0)
      await handle.chmod(0o700);
    return { path, handle };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

/**
 * Make a jail home in `root` that this process owns (or `owner`, for a test).
 * Nothing is left behind when it cannot be made whole.
 */
export async function makeJailHome(
  root: JailRoot,
  owner?: ProcessOwner,
): Promise<JailHome> {
  const name = `${JAIL_HOME_PREFIX}${randomUUID()}`;
  await mkdirChild(root.handle, name);
  const path = join(root.path, name);
  const home = join(path, HOME);
  try {
    // Its own until it is removed, as a directory mkdtemp makes.
    const made = await openChild(
      root.handle,
      name,
      constants.O_RDONLY | O_DIRECTORY | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      await made.chmod(0o700);
      // The owner first, then the home and its tmp, each through the handle
      // of the directory it goes in, never by a path.
      await writeOwnerFileAt(made, owner);
      await mkdirChild(made, HOME);
      const homeDir = await openChild(made, HOME, DIRECTORY);
      try {
        await homeDir.chmod(0o700);
        await mkdirChild(homeDir, 'tmp');
        const tmp = await openChild(homeDir, 'tmp', DIRECTORY);
        await tmp.chmod(0o700).finally(() => tmp.close());
      } finally {
        await homeDir.close();
      }
    } finally {
      await made.close();
    }
  } catch (error) {
    await removeJailHome(root, { path, home });
    throw error;
  }
  return { path, home };
}

/**
 * Remove a run's own jail home when it ends, through the root's handle and
 * without following a link: the root's path may name something else by now.
 */
export async function removeJailHome(
  root: JailRoot,
  jail: JailHome,
): Promise<void> {
  await removeChild(root.handle, basename(jail.path), {
    recursive: true,
    force: true,
  }).catch(() => undefined);
}

/**
 * Remove, under the jail root at `path`, the homes whose owner has ended and
 * the tombstones left by a run killed while it removed one. A root that fails
 * {@link openJailRoot}'s checks, or is not there, is left alone.
 */
export async function sweepJailHomes(
  path: string,
  judge: AbandonJudge = {},
  seams: SweepSeams = {},
): Promise<void> {
  if (!existsSync(path)) return;
  const root = await openJailRoot(path).catch(() => undefined);
  if (root === undefined) return;
  try {
    await sweepJailHomesIn(root, judge, seams);
  } finally {
    await root.handle.close().catch(() => undefined);
  }
}

/** Test seam: called with each home's name before it is judged. */
export interface SweepSeams {
  beforeJudging?: (name: string) => Promise<void>;
}

/**
 * {@link sweepJailHomes} in a root already opened. Nothing that cannot be
 * judged is touched, and a failure removes nothing more: a run does not
 * depend on it.
 */
export async function sweepJailHomesIn(
  root: JailRoot,
  judge: AbandonJudge = {},
  seams: SweepSeams = {},
): Promise<void> {
  const parent = root.handle;
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
  }
}
