/**
 * Writes and removals of a project or store path, each made relative to its
 * directory, which is opened one no-follow component at a time from the base
 * the path lies under (`openStableDirectory`, ADR 0034). A component swapped
 * for a link since an earlier step of the same operation redirects none of
 * them: it is refused when the directory is opened, and what is done in the
 * directory is done through its handle.
 *
 * A rename between two directories, a symbolic link and a hard link are made
 * relative to the directories' handles on every platform that has the calls:
 * `/proc/self/fd/N` on Linux, `renameat`, `symlinkat` and `linkat` on macOS,
 * a rename with the target directory's handle on Windows. Windows has no
 * handle-relative symbolic or hard link: a file is copied there instead of
 * linked, and a link a rollback puts back is the one thing made by path.
 */

import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { symlink, type FileHandle } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
  linkChild,
  lstatChild,
  moveChild,
  readDirChildWithTypes,
  readlinkChild,
  restoreLinkChild,
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

/** Rename `from` to `to`, which may be in another directory, relative to both directories' handles. */
export async function renameAcross(from: string, to: string): Promise<void> {
  if (dirname(from) === dirname(to)) return renameWithin(from, to);
  await inParent(from, (fromParent, fromName) =>
    inParent(to, (toParent, toName) =>
      moveChild(fromParent, fromName, toParent, toName),
    ),
  );
}

/** A symbolic link at `path` that says `target`; never followed. */
export async function symlinkAt(target: string, path: string): Promise<void> {
  await inParent(path, async (parent, name) => {
    if (process.platform !== 'win32')
      return restoreLinkChild(parent, name, target);
    // Windows makes a symbolic link by path only (ADR 0034, "What remains").
    await symlink(target, stableTarget(path));
  });
}

/** What the link at `path` says. */
export async function readlinkAt(path: string): Promise<string> {
  return inParent(path, (parent, name) => readlinkChild(parent, name));
}

/**
 * Give the regular file `name` of `from`, which was `before` when it was
 * inspected, the new name `as` in `to`: a hard link made under a private
 * temporary name, proved to be that very file, and only then given its name.
 * A source swapped since (for a link, which is linked as itself and not
 * followed, or for another file) leaves nothing behind and is refused with
 * `INPUT_CHANGED`. Rejects with the system's error where the file system
 * cannot link (EXDEV, EPERM, EMLINK) for the caller to copy instead; Windows,
 * which has no handle-relative hard link, rejects with EXDEV too.
 */
export async function linkVerified(
  from: FileHandle,
  name: string,
  before: { dev: bigint; ino: bigint },
  to: FileHandle,
  as: string,
  display: string,
): Promise<void> {
  if (process.platform === 'win32')
    throw Object.assign(new Error(`Cannot link here: ${display}`), {
      code: 'EXDEV',
    });
  const temporary = `.${as}.link-${randomUUID()}`;
  await linkChild(from, name, to, temporary);
  try {
    const placed = await lstatChild(to, temporary).catch(() => undefined);
    if (
      placed?.isFile() !== true ||
      placed.dev !== before.dev ||
      placed.ino !== before.ino
    )
      throw new OpmError(
        'INPUT_CHANGED',
        `${display} changed while it was linked`,
      );
    await linkChild(to, temporary, to, as);
  } finally {
    await removeChild(to, temporary, { force: true }).catch(() => undefined);
  }
}

/**
 * `path` as another name of the regular file `existing` ({@link linkVerified}).
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
      await linkVerified(from, fromName, before, to, toName, existing);
    }),
  );
}

/** How a file is copied: the mode it gets, and whether it keeps its times. */
export interface CopyAs {
  /** Given through the new file's handle, past the umask. */
  mode: number;
  /** As `cp --preserve=timestamps`. */
  preserveTimes?: boolean;
}

/** Copy the regular file `existing` to a new file `path`. */
export async function copyFileAt(
  existing: string,
  path: string,
  as: CopyAs,
): Promise<void> {
  await inParent(existing, (from, fromName) =>
    inParent(path, (to, toName) => copyChild(from, fromName, to, toName, as)),
  );
}

/**
 * Copy the regular file `name` of `from` to a new file `as` in `to`, both
 * opened no-follow relative to their directories' handles. Every copy opm
 * makes goes through here: of a shared store file a project may write
 * (`(mode & 0o777) | 0o200`), of a rollback copy (the mode as it was).
 */
export async function copyChild(
  from: FileHandle,
  name: string,
  to: FileHandle,
  as: string,
  how: CopyAs,
): Promise<void> {
  const source = await openChild(
    from,
    name,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await source.stat();
    if (!info.isFile())
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
      await target.chmod(how.mode & 0o7777);
      // The macOS and Windows handle wrappers have no utimes (ADR 0045).
      if (how.preserveTimes === true && typeof target.utimes === 'function')
        await target.utimes(info.atime, info.mtime);
    } finally {
      await target.close();
    }
  } finally {
    await source.close();
  }
}

/** How a tree is copied: its files hard-linked, or copied with `copy`, keeping their times with `preserveTimes`. */
export interface TreeCopy {
  copy: boolean;
  preserveTimes?: boolean;
}

/**
 * `target` as a copy of the tree `source`: its directories made with their
 * modes, its links made again saying what they say (never followed), its
 * files hard-linked, or copied (with `copy`, or where the file system cannot
 * link) with their modes. Every directory of both trees is opened no-follow
 * from its base.
 */
export async function copyTree(
  source: string,
  target: string,
  how: TreeCopy,
): Promise<void> {
  const from = await openStableDirectory(source);
  try {
    const mode = Number((await from.stat({ bigint: true })).mode) & 0o7777;
    // Made private and given its mode last, through its handle: a mode given
    // at mkdir goes through the umask, and a directory that is not writable
    // (0555) could not be filled.
    await makeDirectory(target, 0o700);
    for (const entry of await readDirChildWithTypes(from))
      await copyEntry(join(source, entry.name), join(target, entry.name), how);
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
  how: TreeCopy,
): Promise<void> {
  const info = await inParent(source, (parent, name) =>
    lstatChild(parent, name),
  );
  if (info.isSymbolicLink()) {
    await symlinkAt(await readlinkAt(source), target);
    return;
  }
  if (info.isDirectory()) {
    await copyTree(source, target, how);
    return;
  }
  const as: CopyAs = {
    mode: Number(info.mode) & 0o7777,
    ...(how.preserveTimes === true && { preserveTimes: true }),
  };
  if (how.copy) {
    await copyFileAt(source, target, as);
    return;
  }
  await hardLinkAt(source, target).catch(async (error: unknown) => {
    // SAFETY: only the errno code of a file-system error is read.
    const code = (error as NodeJS.ErrnoException).code;
    // A file system that cannot link here still gets a faithful copy.
    if (code !== 'EXDEV' && code !== 'EPERM' && code !== 'EMLINK') throw error;
    await copyFileAt(source, target, as);
  });
}
