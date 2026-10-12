/**
 * Reading a tree into memory through no-follow directory handles.
 *
 * `collectFiles` reads every file under a root and refuses anything that is
 * not a regular file or a directory. `collectTree` also accepts the
 * workspace-member links a layout's record names, as opaque leaves (see
 * `layout-links.ts`): their path and text are returned, and what they point at
 * is never opened, listed, hashed or counted against a read limit.
 */

import type { BigIntStats } from 'node:fs';
import { constants } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { lstatChild, openChild, readDirChildWithTypes } from './handle-path.js';
import {
  recordedLinkText,
  type CollectTreeOptions,
  type CollectedLink,
  type CollectedTree,
} from './layout-links.js';
import {
  openDirectoryAt,
  openProjectDirectory,
  unsafe,
} from './stable-open.js';
import {
  assertTreeSnapshot,
  sameMetadata,
  snapshot,
  type TreeEntrySnapshot,
} from './tree-snapshot.js';

/** Files of one directory read at the same time while collecting a tree. */
const COLLECT_CONCURRENCY = 16;

export interface CollectOptions {
  /**
   * Accept a file whose only change while it was read is its change time.
   *
   * A store file is hard-linked into every project that uses it, and a project
   * linking or unlinking it at that moment changes its ctime without touching a
   * byte. Inode, size and modification time still have to hold still. Do not
   * set this for a working tree that nothing else should be touching.
   */
  linkTolerant?: boolean;
}

/** {@link collectFiles}, accepting the member links the record names. */
export async function collectTree(
  root: string,
  prefix = '',
  options: CollectTreeOptions = {},
): Promise<CollectedTree> {
  const rootHandle = await openProjectDirectory(root, false);
  try {
    return await collectTreeFromHandle(rootHandle, prefix, root, options);
  } finally {
    await rootHandle.close();
  }
}

/** Every file under `root`, as archive entries with forward-slash paths. */
export async function collectFiles(
  root: string,
  prefix = '',
): Promise<{ path: string; contents: Uint8Array; executable: boolean }[]> {
  const rootHandle = await openProjectDirectory(root, false);
  try {
    return await collectFilesFromHandle(rootHandle, prefix, root);
  } finally {
    await rootHandle.close();
  }
}

/**
 * Collect a stable tree through authority the caller already retained. Every
 * link in it is refused: nothing here follows one, and a caller that expects
 * member links asks for `collectTreeFromHandle`.
 */
export async function collectFilesFromHandle(
  rootHandle: FileHandle,
  prefix = '',
  displayRoot = '<directory handle>',
  options: CollectOptions = {},
): Promise<{ path: string; contents: Uint8Array; executable: boolean }[]> {
  const { linkTolerant } = options;
  return (
    await collectTreeFromHandle(rootHandle, prefix, displayRoot, {
      ...(linkTolerant !== undefined && { linkTolerant }),
    })
  ).files;
}

/** {@link collectFilesFromHandle}, accepting the member links the record names. */
export async function collectTreeFromHandle(
  rootHandle: FileHandle,
  prefix = '',
  displayRoot = '<directory handle>',
  options: CollectTreeOptions = {},
): Promise<CollectedTree> {
  const linkTolerant = options.linkTolerant === true;
  const out: {
    path: string;
    contents: Uint8Array;
    executable: boolean;
  }[] = [];
  const collectedLinks: CollectedLink[] = [];
  const snapshots = new Map<string, TreeEntrySnapshot>();
  // Bytes read or being read; a tree past the limit is refused before the
  // read that would cross it, however many files are in flight.
  let reservedBytes = 0;
  const readFileAt = async (
    directory: FileHandle,
    name: string,
    path: string,
  ): Promise<{
    contents: Uint8Array;
    executable: boolean;
    before: BigIntStats;
  }> => {
    const file = await openChild(
      directory,
      name,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
    try {
      const before = await file.stat({ bigint: true });
      if (!before.isFile() || before.size > 512n * 1024n * 1024n)
        throw unsafe(path);
      const size = Number(before.size);
      if (reservedBytes > 1024 * 1024 * 1024 - size) throw unsafe(displayRoot);
      reservedBytes += size;
      const contents = new Uint8Array(size);
      let offset = 0;
      while (offset < size) {
        const { bytesRead } = await file.read(
          contents,
          offset,
          size - offset,
          offset,
        );
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      const [after, named] = await Promise.all([
        file.stat({ bigint: true }),
        lstatChild(directory, name),
      ]);
      if (
        offset !== size ||
        !sameMetadata(before, after, linkTolerant) ||
        after.dev !== named.dev ||
        after.ino !== named.ino
      )
        throw unsafe(path);
      return { contents, executable: (before.mode & 0o111n) !== 0n, before };
    } finally {
      await file.close();
    }
  };
  const walkOne = async (directory: FileHandle, at: string): Promise<void> => {
    const beforeDirectory = await directory.stat({ bigint: true });
    const entries = await readDirChildWithTypes(directory);
    const pathOf = (name: string) => (at === '' ? name : `${at}/${name}`);
    for (const entry of entries) {
      if (entry.isDirectory() || entry.isFile()) continue;
      // A link is a leaf if the record names it and says the same of it; it is
      // read, not opened, so a link to a tree or to `/` costs one readlink.
      const text = entry.isSymbolicLink()
        ? await recordedLinkText(directory, entry.name, at, options.memberLinks)
        : undefined;
      if (text === undefined) throw unsafe(pathOf(entry.name));
      const info = await lstatChild(directory, entry.name);
      if (!info.isSymbolicLink()) throw unsafe(pathOf(entry.name));
      snapshots.set(pathOf(entry.name), snapshot('link', info, false, text));
      collectedLinks.push({
        path:
          prefix === ''
            ? pathOf(entry.name)
            : `${prefix}/${pathOf(entry.name)}`,
        target: text,
      });
    }
    // The files of one directory are read a few at a time: a package is
    // mostly many small files, and one at a time is all waiting on the disk.
    // The results are used in directory order, so the output is the same.
    const wanted = entries.filter((entry) => entry.isFile());
    const read = new Map<string, Awaited<ReturnType<typeof readFileAt>>>();
    let next = 0;
    await Promise.all(
      Array.from(
        { length: Math.min(COLLECT_CONCURRENCY, wanted.length) },
        async () => {
          for (;;) {
            const entry = wanted[next++];
            if (entry === undefined) return;
            read.set(
              entry.name,
              await readFileAt(directory, entry.name, pathOf(entry.name)),
            );
          }
        },
      ),
    );
    for (const entry of entries) {
      const path = pathOf(entry.name);
      if (entry.isDirectory()) {
        const child = await openDirectoryAt(directory, entry.name);
        try {
          await walkOne(child, path);
        } finally {
          await child.close();
        }
        continue;
      }
      if (entry.isSymbolicLink()) continue;
      const { contents, executable, before } = read.get(entry.name)!;
      snapshots.set(path, snapshot('file', before, linkTolerant));
      out.push({
        path: prefix === '' ? path : `${prefix}/${path}`,
        contents,
        executable,
      });
    }
    const afterDirectory = await directory.stat({ bigint: true });
    if (!sameMetadata(beforeDirectory, afterDirectory))
      throw unsafe(displayRoot);
    snapshots.set(at, snapshot('directory', beforeDirectory));
  };
  await walkOne(rootHandle, '');
  await assertTreeSnapshot(rootHandle, snapshots, options.memberLinks);
  // Directory order is not part of the answer: the links are given by path.
  collectedLinks.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  return { files: out, links: collectedLinks };
}
