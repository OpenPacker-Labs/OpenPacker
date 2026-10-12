/**
 * The identity of every entry of a tree, taken before and after it is read.
 *
 * A tree is read through directory handles and never through a path, but a name
 * can still be swapped between the listing and the read. So each entry's inode,
 * size and times are recorded as it is read, and the whole tree is walked again
 * at the end and compared. A recorded workspace-member link is a leaf in that
 * walk: its inode and text are compared and what it points at is never opened.
 */

import type { FileHandle } from 'node:fs/promises';
import { lstatChild, readDirChildWithTypes } from './handle-path.js';
import { recordedLinkText, type RecordedLinks } from './layout-links.js';
import { openDirectoryAt, unsafe } from './stable-open.js';

export interface TreeEntrySnapshot {
  type: 'directory' | 'file' | 'link';
  /** The text of a recorded member link, which is compared as well as its inode. */
  target?: string;
  dev: bigint;
  ino: bigint;
  size: bigint;
  ctimeNs: bigint;
  mtimeNs: bigint;
  /**
   * A hard-linked inode changes ctime whenever another link to it is made or
   * dropped, which a second project doing the same thing does at any moment.
   * Content identity (inode, size, mtime) is still compared.
   */
  volatileCtime?: boolean;
}

export async function assertTreeSnapshot(
  root: FileHandle,
  expected: ReadonlyMap<string, TreeEntrySnapshot>,
  links?: RecordedLinks,
): Promise<void> {
  const actual = new Map<string, TreeEntrySnapshot>();
  await captureTree(root, '', actual, links);
  if (actual.size !== expected.size) throw unsafe('<directory handle>');
  for (const [path, snapshot] of expected) {
    const current = actual.get(path);
    if (!current || !sameSnapshot(snapshot, current))
      throw unsafe(path === '' ? '<directory handle>' : path);
  }
}

async function captureTree(
  directory: FileHandle,
  at: string,
  out: Map<string, TreeEntrySnapshot>,
  links?: RecordedLinks,
): Promise<void> {
  const before = await directory.stat({ bigint: true });
  for (const entry of await readDirChildWithTypes(directory)) {
    const path = at === '' ? entry.name : `${at}/${entry.name}`;
    if (entry.isDirectory()) {
      const child = await openDirectoryAt(directory, entry.name);
      try {
        await captureTree(child, path, out, links);
      } finally {
        await child.close();
      }
      continue;
    }
    if (entry.isSymbolicLink()) {
      // A recorded member link is a leaf: its inode and text are compared, and
      // what it points at is not opened.
      const text = await recordedLinkText(directory, entry.name, at, links);
      if (text === undefined) throw unsafe(path);
      const info = await lstatChild(directory, entry.name);
      if (!info.isSymbolicLink()) throw unsafe(path);
      out.set(path, snapshot('link', info, false, text));
      continue;
    }
    if (!entry.isFile()) throw unsafe(path);
    // The name is looked at, not followed: a link or anything but a regular
    // file that took the place of a file since the listing is not a file here.
    // One lstat through the directory handle says what opening the file and
    // asking it would, at a third of the calls, and a snapshot is taken of
    // every file of every package several times over.
    const info = await lstatChild(directory, entry.name);
    if (!info.isFile()) throw unsafe(path);
    out.set(path, snapshot('file', info));
  }
  const after = await directory.stat({ bigint: true });
  if (!sameMetadata(before, after)) throw unsafe(at || '<directory handle>');
  out.set(at, snapshot('directory', before));
}

export function snapshot(
  type: TreeEntrySnapshot['type'],
  info: Awaited<ReturnType<FileHandle['stat']>>,
  volatileCtime = false,
  target?: string,
): TreeEntrySnapshot {
  return {
    ...(volatileCtime && { volatileCtime }),
    ...(target !== undefined && { target }),
    type,
    dev: BigInt(info.dev),
    ino: BigInt(info.ino),
    size: BigInt(info.size),
    ctimeNs:
      'ctimeNs' in info
        ? BigInt(info.ctimeNs)
        : BigInt(info.ctimeMs) * 1_000_000n,
    mtimeNs:
      'mtimeNs' in info
        ? BigInt(info.mtimeNs)
        : BigInt(info.mtimeMs) * 1_000_000n,
  };
}

function sameSnapshot(
  expected: TreeEntrySnapshot,
  actual: TreeEntrySnapshot,
): boolean {
  return (
    expected.type === actual.type &&
    expected.target === actual.target &&
    sameMetadata(expected, actual, expected.volatileCtime === true)
  );
}

export function sameMetadata(
  left: {
    dev: bigint;
    ino: bigint;
    size: bigint;
    ctimeNs: bigint;
    mtimeNs: bigint;
  },
  right: {
    dev: bigint;
    ino: bigint;
    size: bigint;
    ctimeNs: bigint;
    mtimeNs: bigint;
  },
  ignoreCtime = false,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    (ignoreCtime || left.ctimeNs === right.ctimeNs) &&
    left.mtimeNs === right.mtimeNs
  );
}
