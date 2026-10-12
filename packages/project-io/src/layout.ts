/**
 * Materialise a directory from the content-addressed store.
 *
 * Copy through stable, no-follow file and directory handles, and never
 * symlink. Pathname-only hardlinks would reopen the source race this boundary
 * exists to close.
 */

import { randomUUID } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  realpath,
  type FileHandle,
} from 'node:fs/promises';
import {
  basename,
  dirname,
  join,
  parse,
  relative,
  resolve,
  sep,
} from 'node:path';
import { ProjectIoError } from './index.js';
import {
  recordedLinkText,
  type CollectedLink,
  type RecordedLinks,
} from './layout-links.js';
import {
  linkChild,
  O_DIRECTORY,
  lstatChild,
  mkdirChild,
  openChild,
  readDirChildWithTypes,
  removeChild,
  renameChild,
  StableHandleError,
  supportsStableHandles,
} from './handle-path.js';

export interface MaterialiseOptions {
  /**
   * Hard-link each file from `source` instead of copying its bytes.
   *
   * The linked entry must be the very inode that was opened and inspected
   * through the source directory handle; a name that was swapped between the
   * inspection and the link is refused, never kept. A filesystem that cannot
   * link (another device, a platform without handle-relative links, a file
   * system that refuses) falls back to a verified copy for the rest of the
   * tree, and `copied` says so. Linked files share their inode with the
   * source, so their mode is the source's and is never changed from here.
   */
  link?: boolean;
}

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

export interface CollectTreeOptions extends CollectOptions {
  /**
   * The workspace-member links the layout's record says it wrote under the
   * walked directory. Each is returned as a leaf (its path and text) and is
   * never entered, followed or counted; any other link is refused.
   */
  memberLinks?: RecordedLinks;
}

export type { CollectedLink, RecordedLinks };

/** The files under a tree, and the recorded member links met on the way. */
export interface CollectedTree {
  files: { path: string; contents: Uint8Array; executable: boolean }[];
  links: CollectedLink[];
}

export interface MaterialiseResult {
  /** Files linked or copied. */
  files: number;
  /** Of `files`, how many are hard links to the source rather than copies. */
  linked: number;
  /** True when at least one file had to be copied rather than linked. */
  copied: boolean;
}

interface TreeEntrySnapshot {
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

/** Why a link attempt means "copy instead" and not "something is wrong". */
const LINK_FALLBACK = new Set([
  'EXDEV',
  'EPERM',
  'ENOTSUP',
  'EOPNOTSUPP',
  'ENOSYS',
  'EMLINK',
]);

interface LinkState {
  /** Set once the filesystem has said it cannot link; later files just copy. */
  unavailable: boolean;
}

/**
 * Replace `destination` with the contents of `source`.
 *
 * Replace, not merge: a layout that accumulates files from a previous
 * resolution is a layout nobody can reason about.
 */
export async function materialiseTree(
  source: string,
  destination: string,
  root: string,
  options: MaterialiseOptions = {},
): Promise<MaterialiseResult> {
  assertContained(root, destination);
  const rootHandle = await openStableDirectory(root, true);
  const handles: FileHandle[] = [rootHandle];
  const result: MaterialiseResult = { files: 0, linked: 0, copied: false };
  const link: LinkState | undefined =
    options.link === true ? { unavailable: false } : undefined;
  let staging: string | undefined;
  let stagingParent = rootHandle;
  try {
    const parts = relative(resolve(root), resolve(destination)).split(sep);
    const name = parts.pop();
    if (!name || name === '.' || name === '..') throw unsafe(destination);
    let parent = rootHandle;
    for (const part of parts) {
      if (!part || part === '.' || part === '..') throw unsafe(destination);
      await mkdirChild(parent, part).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
      });
      parent = await openDirectoryAt(parent, part);
      handles.push(parent);
      stagingParent = parent;
    }

    const stagingName = `.${name}.openpacker-${randomUUID()}`;
    staging = stagingName;
    await mkdirChild(parent, stagingName);
    const stagingHandle = await openDirectoryAt(parent, stagingName);
    handles.push(stagingHandle);
    const sourceHandle = await openStableDirectory(source, false);
    handles.push(sourceHandle);
    const sourceSnapshot = new Map<string, TreeEntrySnapshot>();
    const stagedSnapshot = new Map<string, TreeEntrySnapshot>();
    await walk(
      sourceHandle,
      stagingHandle,
      result,
      '',
      sourceSnapshot,
      stagedSnapshot,
      link,
    );
    await assertTreeSnapshot(sourceHandle, sourceSnapshot);
    await assertTreeSnapshot(stagingHandle, stagedSnapshot);
    const publishedLexical = resolve(destination);
    await removeChild(parent, name, { recursive: true, force: true });
    await assertTreeSnapshot(sourceHandle, sourceSnapshot);
    await assertTreeSnapshot(stagingHandle, stagedSnapshot);
    await renameChild(parent, stagingName, name);
    staging = undefined;
    try {
      await assertNamedHandle(publishedLexical, stagingHandle);
      await assertTreeSnapshot(sourceHandle, sourceSnapshot);
      stagedSnapshot.set(
        '',
        snapshot('directory', await stagingHandle.stat({ bigint: true })),
      );
      await assertTreeSnapshot(stagingHandle, stagedSnapshot);
    } catch (error) {
      await removeChild(parent, name, { recursive: true, force: true }).catch(
        () => undefined,
      );
      throw error;
    }
    return result;
  } catch (error) {
    if (
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      (error as NodeJS.ErrnoException).code === 'ELOOP' ||
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      (error as NodeJS.ErrnoException).code === 'ENOTDIR' ||
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    )
      throw unsafe(destination);
    throw error;
  } finally {
    if (staging)
      await removeChild(stagingParent, staging, {
        recursive: true,
        force: true,
      }).catch(() => undefined);
    await Promise.all(
      handles.reverse().map(async (handle) => await handle.close()),
    );
  }
}

async function walk(
  source: FileHandle,
  destination: FileHandle,
  result: MaterialiseResult,
  at: string,
  sourceSnapshot: Map<string, TreeEntrySnapshot>,
  destinationSnapshot: Map<string, TreeEntrySnapshot>,
  link: LinkState | undefined,
): Promise<void> {
  const sourceDirectoryBefore = await source.stat({ bigint: true });
  const entries = await readDirChildWithTypes(source);
  for (const entry of entries) {
    const relativePath = at === '' ? entry.name : `${at}/${entry.name}`;
    if (entry.isDirectory()) {
      const fromHandle = await openDirectoryAt(source, entry.name);
      await mkdirChild(destination, entry.name);
      const toHandle = await openDirectoryAt(destination, entry.name);
      try {
        await walk(
          fromHandle,
          toHandle,
          result,
          relativePath,
          sourceSnapshot,
          destinationSnapshot,
          link,
        );
      } finally {
        await Promise.all([fromHandle.close(), toHandle.close()]);
      }
      continue;
    }
    if (!entry.isFile()) {
      // The store is built by the materializer, which already refuses
      // symlinks, devices and sockets. Anything else here is not something to
      // reproduce into a project directory on a guess.
      throw unsafe(relativePath);
    }
    const file = await openChild(
      source,
      entry.name,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
    let output: FileHandle | undefined;
    try {
      const before = await file.stat({ bigint: true });
      if (!before.isFile()) throw unsafe(relativePath);
      if (before.size > BigInt(Number.MAX_SAFE_INTEGER))
        throw unsafe(relativePath);
      if (
        link &&
        !link.unavailable &&
        (await linkVerified({
          source,
          destination,
          name: entry.name,
          file,
          before,
          relativePath,
          link,
          sourceSnapshot,
          destinationSnapshot,
        }))
      ) {
        result.files += 1;
        result.linked += 1;
        continue;
      }
      const size = Number(before.size);
      output = await openChild(
        destination,
        entry.name,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        (before.mode & 0o111n) !== 0n ? 0o755 : 0o644,
      );
      const buffer = new Uint8Array(64 * 1024);
      let offset = 0;
      while (offset < size) {
        const length = Math.min(size - offset, buffer.byteLength);
        const { bytesRead } = await file.read(buffer, 0, length, offset);
        if (bytesRead === 0) break;
        await output.write(buffer, 0, bytesRead, offset);
        offset += bytesRead;
      }
      await output.sync();
      const [after, outputInfo, namedOutput] = await Promise.all([
        file.stat({ bigint: true }),
        output.stat({ bigint: true }),
        lstatChild(destination, entry.name),
      ]);
      if (
        BigInt(offset) !== before.size ||
        after.dev !== before.dev ||
        after.ino !== before.ino ||
        after.size !== before.size ||
        after.ctimeNs !== before.ctimeNs ||
        after.mtimeNs !== before.mtimeNs ||
        outputInfo.dev !== namedOutput.dev ||
        outputInfo.ino !== namedOutput.ino
      )
        throw unsafe(relativePath);
      await output.chmod((before.mode & 0o111n) !== 0n ? 0o755 : 0o644);
      const finalOutput = await output.stat({ bigint: true });
      destinationSnapshot.set(relativePath, snapshot('file', finalOutput));
      sourceSnapshot.set(relativePath, snapshot('file', before));
      result.copied = true;
    } finally {
      await output?.close().catch(() => undefined);
      await file.close();
    }
    result.files += 1;
  }
  const sourceDirectoryAfter = await source.stat({ bigint: true });
  if (!sameMetadata(sourceDirectoryBefore, sourceDirectoryAfter))
    throw unsafe(at || '<source>');
  sourceSnapshot.set(at, snapshot('directory', sourceDirectoryBefore));
  destinationSnapshot.set(
    at,
    snapshot('directory', await destination.stat({ bigint: true })),
  );
}

async function assertTreeSnapshot(
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

/**
 * Link one file and prove the link is the inode that was inspected.
 *
 * Returns false when the filesystem cannot link, so the caller copies. Any
 * other outcome that is not exactly "the entry I opened, now with one more
 * name" removes the new name and fails closed.
 */
async function linkVerified(input: {
  source: FileHandle;
  destination: FileHandle;
  name: string;
  file: FileHandle;
  before: BigIntStats;
  relativePath: string;
  link: LinkState;
  sourceSnapshot: Map<string, TreeEntrySnapshot>;
  destinationSnapshot: Map<string, TreeEntrySnapshot>;
}): Promise<boolean> {
  const { destination, name, file, before, relativePath } = input;
  try {
    await linkChild(input.source, name, destination, name);
  } catch (error) {
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const code = (error as NodeJS.ErrnoException).code ?? '';
    if (error instanceof StableHandleError || LINK_FALLBACK.has(code)) {
      // One inode out of links is that file's problem; every other reason
      // means this filesystem will not link at all.
      if (code !== 'EMLINK') input.link.unavailable = true;
      return false;
    }
    throw error;
  }
  const refuse = async (): Promise<never> => {
    await removeChild(destination, name, { force: true }).catch(
      () => undefined,
    );
    throw unsafe(relativePath);
  };
  const placed = await lstatChild(destination, name);
  if (
    !placed.isFile() ||
    BigInt(placed.dev) !== BigInt(before.dev) ||
    BigInt(placed.ino) !== BigInt(before.ino)
  )
    return refuse();
  const after = await file.stat({ bigint: true });
  if (
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    after.size !== before.size ||
    after.mtimeNs !== before.mtimeNs
  )
    return refuse();
  input.sourceSnapshot.set(relativePath, snapshot('file', after, true));
  input.destinationSnapshot.set(relativePath, snapshot('file', placed, true));
  return true;
}

function snapshot(
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

function sameMetadata(
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

/**
 * Canonicalize the existing ancestor prefix of a stable target.
 *
 * The no-follow component walk refuses symlinked path components, which would
 * reject every layout under a legitimately symlinked ancestor — macOS
 * `/var` → `/private/var` (all of `$TMPDIR`), symlinked home directories,
 * automounters. Honor such a stable pre-existing prefix once by realpath-ing
 * the deepest existing ancestor here; the final component stays lexical so a
 * symlinked target itself is still refused, and all subsequent traversal is
 * fd-relative, so a later swap of the prefix cannot redirect anything.
 */
async function canonicalizeStableTarget(path: string): Promise<string> {
  const absolute = resolve(path);
  const tail: string[] = [basename(absolute)];
  let candidate = dirname(absolute);
  for (;;) {
    try {
      const canonical = await realpath(candidate);
      return join(canonical, ...tail.reverse());
    } catch (error) {
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ELOOP' || code === 'ENOTDIR') throw unsafe(path);
      if (code !== 'ENOENT') throw error;
    }
    const parent = dirname(candidate);
    if (parent === candidate) return absolute;
    tail.push(basename(candidate));
    candidate = parent;
  }
}

async function openStableDirectory(
  path: string,
  create: boolean,
): Promise<FileHandle> {
  const absolute = await canonicalizeStableTarget(path);
  const root = parse(absolute).root;
  let handle = await openDirectory(root, false);
  try {
    for (const part of relative(root, absolute).split(sep).filter(Boolean)) {
      if (create)
        await mkdirChild(handle, part).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'EEXIST') throw error;
        });
      const next = await openDirectoryAt(handle, part);
      await handle.close();
      handle = next;
    }
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    if (
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      (error as NodeJS.ErrnoException).code === 'ELOOP' ||
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      (error as NodeJS.ErrnoException).code === 'ENOTDIR' ||
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    )
      throw unsafe(path);
    throw error;
  }
}

async function assertNamedHandle(
  path: string,
  handle: FileHandle,
): Promise<void> {
  const [opened, named] = await Promise.all([
    handle.stat({ bigint: true }),
    lstat(path, { bigint: true }),
  ]);
  if (opened.dev !== named.dev || opened.ino !== named.ino) throw unsafe(path);
}

async function openDirectory(
  path: string,
  create: boolean,
): Promise<FileHandle> {
  if (create)
    await mkdir(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
  try {
    const handle = await open(
      path,
      constants.O_RDONLY | O_DIRECTORY | constants.O_NOFOLLOW,
    );
    if (!(await handle.stat()).isDirectory()) {
      await handle.close();
      throw unsafe(path);
    }
    return handle;
  } catch (error) {
    if (
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      (error as NodeJS.ErrnoException).code === 'ELOOP' ||
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      (error as NodeJS.ErrnoException).code === 'ENOTDIR' ||
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    )
      throw unsafe(path);
    throw error;
  }
}

async function openDirectoryAt(
  parent: FileHandle,
  name: string,
): Promise<FileHandle> {
  const handle = await openChild(
    parent,
    name,
    constants.O_RDONLY | O_DIRECTORY | constants.O_NOFOLLOW,
  );
  if (!(await handle.stat()).isDirectory()) {
    await handle.close();
    throw unsafe(name);
  }
  return handle;
}

export function supportsStableTreeLayout(
  platform: NodeJS.Platform = process.platform,
): boolean {
  return supportsStableHandles(platform);
}

function unsafe(path: string): ProjectIoError {
  return new ProjectIoError(
    'UNSAFE_PATH',
    path,
    `Layout path is linked, special, or unstable: ${path}`,
  );
}

/**
 * Refuse a destination outside its root.
 *
 * The path is built from a package name that came off a registry, and what
 * happens next is a recursive delete followed by a write. `@evil/../../..` has
 * to stop here.
 */
function assertContained(root: string, destination: string): void {
  const base = resolve(root);
  const target = resolve(destination);
  if (target !== base && !target.startsWith(base + sep))
    throw new ProjectIoError(
      'UNSAFE_PATH',
      destination,
      `Layout destination escapes ${base}: ${destination}`,
    );
}

/** Remove a layout directory if it exists. */
export async function removeTree(path: string): Promise<void> {
  const parent = await openStableDirectory(dirname(resolve(path)), false);
  try {
    await removeChild(parent, resolve(path).split(sep).at(-1)!, {
      recursive: true,
      force: true,
    });
  } finally {
    await parent.close();
  }
}

/** {@link collectFiles}, accepting the member links the record names. */
export async function collectTree(
  root: string,
  prefix = '',
  options: CollectTreeOptions = {},
): Promise<CollectedTree> {
  const rootHandle = await openStableDirectory(root, false);
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
  const rootHandle = await openStableDirectory(root, false);
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

/**
 * The no-follow walk from a root, for the sibling modules that place and read
 * member links. Not part of the package entry.
 */
export { openStableDirectory as openProjectDirectory, openDirectoryAt };
