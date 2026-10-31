/**
 * Writes and removals of a project or store path, each made relative to its
 * directory, which is opened one no-follow component at a time from the base
 * the path lies under (`openStableDirectory`, ADR 0034). A component swapped
 * for a link since an earlier step of the same operation redirects none of
 * them: it is refused when the directory is opened, and what is done in the
 * directory is done through its handle.
 *
 * Node has no handle-relative call for three of them: a rename between two
 * directories, a symbolic link and a hard link. Linux names a child of an open
 * directory by path (`/proc/self/fd/N/name`), so there they are relative to
 * the handles too. macOS and Windows have no such path (ADR 0045): there these
 * three go by the directories' real paths, as their bases were taken, and a
 * concurrent swap below the base could still redirect them. Every other
 * operation here is handle-relative on every platform.
 */

import { constants } from 'node:fs';
import { link, open, rename, symlink, type FileHandle } from 'node:fs/promises';
import { basename, dirname, join, parse, relative, sep } from 'node:path';
import {
  linkChild,
  lstatChild,
  readDirChildWithTypes,
  readlinkChild,
  stableHandlePath,
  stableTarget,
} from '@openpacker/project-io';
import {
  O_DIRECTORY,
  mkdirChild,
  openChild,
  openStableDirectory,
  removeChild,
  renameChild,
  revalidateStableDirectory,
} from './paths.js';
import { OpmError } from './types.js';

const HANDLE_PATHS = process.platform === 'linux';

/** Run `work` with `path`'s directory open, checked again afterwards. */
export async function inParent<T>(
  path: string,
  work: (parent: FileHandle, name: string) => Promise<T>,
): Promise<T> {
  const directory = dirname(path);
  const parent = await openStableDirectory(directory);
  try {
    const result = await work(parent, basename(path));
    await revalidateStableDirectory(directory, parent);
    return result;
  } finally {
    await parent.close();
  }
}

/** `path` and all of it, gone; nothing there is fine. Links are removed, never entered. */
export async function removeTree(path: string): Promise<void> {
  await inParent(path, (parent, name) =>
    removeChild(parent, name, { recursive: true, force: true }),
  );
}

/** A new directory at `path`, with `mode` where it is given. */
export async function makeDirectory(
  path: string,
  mode?: number,
): Promise<void> {
  await inParent(path, async (parent, name) => {
    await mkdirChild(parent, name);
    if (mode === undefined) return;
    const made = await openChild(
      parent,
      name,
      constants.O_RDONLY | O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      await made.chmod(mode);
    } finally {
      await made.close();
    }
  });
}

/** A new regular file at `path` holding `bytes`, with `mode`; never one that is there. */
export async function createFile(
  path: string,
  bytes: Uint8Array,
  mode: number,
): Promise<void> {
  await inParent(path, async (parent, name) => {
    const file = await openChild(
      parent,
      name,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await file.writeFile(bytes);
      await file.chmod(mode);
      await file.sync();
    } finally {
      await file.close();
    }
  });
}

/** Rename `from` to `to` within one directory. */
export async function renameWithin(from: string, to: string): Promise<void> {
  if (dirname(from) !== dirname(to))
    throw new OpmError('INVALID_STATE', `Not one directory: ${from}, ${to}`);
  await inParent(from, (parent, name) =>
    renameChild(parent, name, basename(to)),
  );
}

/** Rename `from` to `to`, which may be in another directory. */
export async function renameAcross(from: string, to: string): Promise<void> {
  if (dirname(from) === dirname(to)) return renameWithin(from, to);
  await inParent(from, (fromParent, fromName) =>
    inParent(to, async (toParent, toName) => {
      if (HANDLE_PATHS)
        await rename(
          join(stableHandlePath(fromParent), fromName),
          join(stableHandlePath(toParent), toName),
        );
      else await rename(stableTarget(from), stableTarget(to));
    }),
  );
}

/** A symbolic link at `path` that says `target`; never followed. */
export async function symlinkAt(target: string, path: string): Promise<void> {
  await inParent(path, async (parent, name) => {
    if (HANDLE_PATHS)
      await symlink(target, join(stableHandlePath(parent), name));
    else await symlink(target, stableTarget(path));
  });
}

/** What the link at `path` says. */
export async function readlinkAt(path: string): Promise<string> {
  return inParent(path, (parent, name) => readlinkChild(parent, name));
}

/**
 * `path` as another name of the regular file `existing`, proved afterwards to
 * be the very file that was inspected; anything else is removed and refused.
 * Rejects with the system's error where the file system cannot link (EXDEV,
 * EPERM, EMLINK), for the caller to copy instead.
 */
export async function hardLinkAt(
  existing: string,
  path: string,
): Promise<void> {
  await inParent(existing, (from, fromName) =>
    inParent(path, async (to, toName) => {
      const before = await lstatChild(from, fromName);
      if (!before.isFile())
        throw new OpmError('UNSAFE_PATH', `Not a regular file: ${existing}`);
      if (HANDLE_PATHS) await linkChild(from, fromName, to, toName);
      else await link(stableTarget(existing), stableTarget(path));
      const placed = await lstatChild(to, toName).catch(() => undefined);
      if (
        placed?.isFile() !== true ||
        placed.dev !== before.dev ||
        placed.ino !== before.ino
      ) {
        await removeChild(to, toName, { force: true }).catch(() => undefined);
        throw new OpmError(
          'INPUT_CHANGED',
          `${existing} changed while it was linked to ${path}`,
        );
      }
    }),
  );
}

/** Copy the regular file `existing` to a new file `path`, with `mode`. */
export async function copyFileAt(
  existing: string,
  path: string,
  mode: number,
): Promise<void> {
  await inParent(existing, (from, fromName) =>
    inParent(path, (to, toName) => copyChild(from, fromName, to, toName, mode)),
  );
}

/**
 * Copy the regular file `name` of `from` to a new file `as` in `to`, both
 * opened no-follow relative to their directories' handles, with `mode`.
 */
export async function copyChild(
  from: FileHandle,
  name: string,
  to: FileHandle,
  as: string,
  mode: number,
): Promise<void> {
  const source = await openChild(
    from,
    name,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    if (!(await source.stat()).isFile())
      throw new OpmError('UNSAFE_PATH', `Not a regular file: ${name}`);
    const target = await openChild(
      to,
      as,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const buffer = Buffer.alloc(1024 * 1024);
      for (let offset = 0; ; ) {
        const { bytesRead } = await source.read(
          buffer,
          0,
          buffer.length,
          offset,
        );
        if (bytesRead === 0) break;
        for (let written = 0; written < bytesRead; ) {
          const { bytesWritten } = await target.write(
            buffer,
            written,
            bytesRead - written,
            offset + written,
          );
          written += bytesWritten;
        }
        offset += bytesRead;
      }
      await target.chmod(mode & 0o7777);
      // As `cp --preserve=timestamps`, where the handle can (the macOS and
      // Windows handle wrappers have no utimes; ADR 0045).
      if (typeof target.utimes === 'function') {
        const { atime, mtime } = await source.stat();
        await target.utimes(atime, mtime);
      }
    } finally {
      await target.close();
    }
  } finally {
    await source.close();
  }
}

/**
 * `target` as a copy of the tree `source`: its directories made with their
 * modes, its links made again saying what they say (never followed), its
 * files hard-linked, or copied with `copy` or where the file system cannot
 * link. Every directory of both trees is opened no-follow from its base.
 */
export async function copyTree(
  source: string,
  target: string,
  copy: boolean,
): Promise<void> {
  const from = await openStableDirectory(source);
  try {
    const mode = Number((await from.stat({ bigint: true })).mode) & 0o7777;
    // Made private and given its mode last, through its handle: a mode given
    // at mkdir goes through the umask, and a directory that is not writable
    // (0555) could not be filled.
    await makeDirectory(target, 0o700);
    for (const entry of await readDirChildWithTypes(from))
      await copyEntry(join(source, entry.name), join(target, entry.name), copy);
    await inParent(target, async (parent, name) => {
      const made = await openChild(
        parent,
        name,
        constants.O_RDONLY | O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        await made.chmod(mode);
      } finally {
        await made.close();
      }
    });
  } finally {
    await from.close();
  }
}

/** `target` as a copy of the one entry `source`, as {@link copyTree} copies each. */
export async function copyEntry(
  source: string,
  target: string,
  copy: boolean,
): Promise<void> {
  const info = await inParent(source, (parent, name) =>
    lstatChild(parent, name),
  );
  if (info.isSymbolicLink()) {
    await symlinkAt(await readlinkAt(source), target);
    return;
  }
  if (info.isDirectory()) {
    await copyTree(source, target, copy);
    return;
  }
  const mode = Number(info.mode) & 0o7777;
  if (copy) {
    await copyFileAt(source, target, mode);
    return;
  }
  await hardLinkAt(source, target).catch(async (error: unknown) => {
    // SAFETY: only the errno code of a file-system error is read.
    const code = (error as NodeJS.ErrnoException).code;
    // A file system that cannot link here still gets a faithful copy.
    if (code !== 'EXDEV' && code !== 'EPERM' && code !== 'EMLINK') throw error;
    await copyFileAt(source, target, mode);
  });
}

/**
 * The directory at `real` (a real path: no link on the way to it), opened one
 * no-follow component at a time, each missing directory made mode 0700 with
 * `create`, as `mkdir -p -m 0700` makes what it makes, umask aside. For the
 * places that hold what nobody else may read or write: the shared store root,
 * the auth config.
 */
export async function openPrivateDirectory(
  real: string,
  create: boolean,
): Promise<FileHandle> {
  const top = parse(real).root;
  let handle = await open(
    top,
    constants.O_RDONLY | O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    for (const part of relative(top, real).split(sep).filter(Boolean)) {
      const made =
        create &&
        (await mkdirChild(handle, part).then(
          () => true,
          (error: NodeJS.ErrnoException) => {
            if (error.code !== 'EEXIST') throw error;
            return false;
          },
        ));
      const next = await openChild(
        handle,
        part,
        constants.O_RDONLY | O_DIRECTORY | constants.O_NOFOLLOW,
      );
      await handle.close();
      handle = next;
      if (made && process.platform !== 'win32') await handle.chmod(0o700);
    }
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}
