/**
 * Materialise a directory from the content-addressed store.
 *
 * Copy through stable, no-follow file and directory handles, and never
 * symlink. Pathname-only hardlinks would reopen the source race this boundary
 * exists to close.
 */

import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  stat,
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

export interface MaterialiseResult {
  /** Files linked or copied. */
  files: number;
  /** True when at least one file had to be copied rather than linked. */
  copied: boolean;
}

interface TreeEntrySnapshot {
  type: 'directory' | 'file';
  dev: bigint;
  ino: bigint;
  size: bigint;
  ctimeNs: bigint;
  mtimeNs: bigint;
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
): Promise<MaterialiseResult> {
  assertContained(root, destination);
  const rootHandle = await openStableDirectory(root, true);
  const handles: FileHandle[] = [rootHandle];
  const result: MaterialiseResult = { files: 0, copied: false };
  let staging: string | undefined;
  try {
    const parts = relative(resolve(root), resolve(destination)).split(sep);
    const name = parts.pop();
    if (!name || name === '.' || name === '..') throw unsafe(destination);
    let parent = rootHandle;
    for (const part of parts) {
      if (!part || part === '.' || part === '..') throw unsafe(destination);
      const childPath = join(handlePath(parent), part);
      await mkdir(childPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
      });
      parent = await openDirectory(childPath, false);
      handles.push(parent);
    }

    const parentPath = handlePath(parent);
    staging = join(parentPath, `.${name}.openpacker-${randomUUID()}`);
    await mkdir(staging, { mode: 0o700 });
    const stagingHandle = await openDirectory(staging, false);
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
    );
    await assertTreeSnapshot(sourceHandle, sourceSnapshot);
    await assertTreeSnapshot(stagingHandle, stagedSnapshot);
    const published = join(parentPath, name);
    await assertNamedHandle(staging, stagingHandle);
    await rm(published, { recursive: true, force: true });
    await assertTreeSnapshot(sourceHandle, sourceSnapshot);
    await assertTreeSnapshot(stagingHandle, stagedSnapshot);
    await assertNamedHandle(staging, stagingHandle);
    await rename(staging, published);
    try {
      await assertNamedHandle(published, stagingHandle);
      await assertTreeSnapshot(sourceHandle, sourceSnapshot);
      stagedSnapshot.set(
        '',
        snapshot('directory', await stagingHandle.stat({ bigint: true })),
      );
      await assertTreeSnapshot(stagingHandle, stagedSnapshot);
    } catch (error) {
      await rm(published, { recursive: true, force: true }).catch(
        () => undefined,
      );
      throw error;
    }
    staging = undefined;
    return result;
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === 'ELOOP' ||
      (error as NodeJS.ErrnoException).code === 'ENOTDIR'
    )
      throw unsafe(destination);
    throw error;
  } finally {
    if (staging)
      await rm(staging, { recursive: true, force: true }).catch(
        () => undefined,
      );
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
): Promise<void> {
  const sourcePath = handlePath(source);
  const destinationPath = handlePath(destination);
  const sourceDirectoryBefore = await source.stat({ bigint: true });
  const entries = await readdir(sourcePath, { withFileTypes: true });
  for (const entry of entries) {
    const from = join(sourcePath, entry.name);
    const to = join(destinationPath, entry.name);
    const relativePath = at === '' ? entry.name : `${at}/${entry.name}`;
    if (entry.isDirectory()) {
      const fromHandle = await openDirectory(from, false);
      await mkdir(to);
      const toHandle = await openDirectory(to, false);
      try {
        await walk(
          fromHandle,
          toHandle,
          result,
          relativePath,
          sourceSnapshot,
          destinationSnapshot,
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
      throw unsafe(from);
    }
    const file = await open(
      from,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
    let output: FileHandle | undefined;
    try {
      const before = await file.stat({ bigint: true });
      if (!before.isFile()) throw unsafe(from);
      if (before.size > BigInt(Number.MAX_SAFE_INTEGER)) throw unsafe(from);
      const size = Number(before.size);
      output = await open(
        to,
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
        lstat(to, { bigint: true }),
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
        throw unsafe(from);
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
    throw unsafe(sourcePath);
  sourceSnapshot.set(at, snapshot('directory', sourceDirectoryBefore));
  destinationSnapshot.set(
    at,
    snapshot('directory', await destination.stat({ bigint: true })),
  );
}

async function assertTreeSnapshot(
  root: FileHandle,
  expected: ReadonlyMap<string, TreeEntrySnapshot>,
): Promise<void> {
  const actual = new Map<string, TreeEntrySnapshot>();
  await captureTree(root, '', actual);
  if (actual.size !== expected.size) throw unsafe(handlePath(root));
  for (const [path, snapshot] of expected) {
    const current = actual.get(path);
    if (!current || !sameSnapshot(snapshot, current))
      throw unsafe(path === '' ? handlePath(root) : path);
  }
}

async function captureTree(
  directory: FileHandle,
  at: string,
  out: Map<string, TreeEntrySnapshot>,
): Promise<void> {
  const before = await directory.stat({ bigint: true });
  const directoryPath = handlePath(directory);
  for (const entry of await readdir(directoryPath, { withFileTypes: true })) {
    const path = at === '' ? entry.name : `${at}/${entry.name}`;
    const childPath = join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      const child = await openDirectory(childPath, false);
      try {
        await captureTree(child, path, out);
      } finally {
        await child.close();
      }
      continue;
    }
    if (!entry.isFile()) throw unsafe(childPath);
    const file = await open(
      childPath,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
    try {
      const info = await file.stat({ bigint: true });
      if (!info.isFile()) throw unsafe(childPath);
      out.set(path, snapshot('file', info));
    } finally {
      await file.close();
    }
  }
  const after = await directory.stat({ bigint: true });
  if (!sameMetadata(before, after)) throw unsafe(directoryPath);
  out.set(at, snapshot('directory', before));
}

function snapshot(
  type: TreeEntrySnapshot['type'],
  info: Awaited<ReturnType<FileHandle['stat']>>,
): TreeEntrySnapshot {
  return {
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
  left: TreeEntrySnapshot,
  right: TreeEntrySnapshot,
): boolean {
  return left.type === right.type && sameMetadata(left, right);
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
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.ctimeNs === right.ctimeNs &&
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
      const child = join(handlePath(handle), part);
      if (create)
        await mkdir(child).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'EEXIST') throw error;
        });
      const next = await openDirectory(child, false);
      await handle.close();
      handle = next;
    }
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
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
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    if (!(await handle.stat()).isDirectory()) {
      await handle.close();
      throw unsafe(path);
    }
    const [opened, referenced] = await Promise.all([
      handle.stat({ bigint: true }),
      stat(handlePath(handle), { bigint: true }),
    ]);
    if (opened.dev !== referenced.dev || opened.ino !== referenced.ino) {
      await handle.close();
      throw unsafe(path);
    }
    return handle;
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === 'ELOOP' ||
      (error as NodeJS.ErrnoException).code === 'ENOTDIR'
    )
      throw unsafe(path);
    throw error;
  }
}

function handlePath(handle: FileHandle): string {
  if (process.platform === 'linux') return `/proc/self/fd/${handle.fd}`;
  if (process.platform === 'darwin') return `/dev/fd/${handle.fd}`;
  throw new ProjectIoError(
    'UNSAFE_PATH',
    String(handle.fd),
    'Native layout requires stable no-follow directory handles on this platform',
  );
}

export function supportsStableTreeLayout(
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === 'linux' || platform === 'darwin';
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
    await rm(join(handlePath(parent), resolve(path).split(sep).at(-1)!), {
      recursive: true,
      force: true,
    });
  } finally {
    await parent.close();
  }
}

/** Every file under `root`, as archive entries with forward-slash paths. */
export async function collectFiles(
  root: string,
  prefix = '',
): Promise<{ path: string; contents: Uint8Array; executable: boolean }[]> {
  const out: {
    path: string;
    contents: Uint8Array;
    executable: boolean;
  }[] = [];
  const rootHandle = await openStableDirectory(root, false);
  const snapshots = new Map<string, TreeEntrySnapshot>();
  let totalBytes = 0;
  const walkOne = async (directory: FileHandle, at: string): Promise<void> => {
    const beforeDirectory = await directory.stat({ bigint: true });
    const directoryPath = handlePath(directory);
    for (const entry of await readdir(directoryPath, { withFileTypes: true })) {
      const from = join(directoryPath, entry.name);
      const path = at === '' ? entry.name : `${at}/${entry.name}`;
      if (entry.isDirectory()) {
        const child = await openDirectory(from, false);
        try {
          await walkOne(child, path);
        } finally {
          await child.close();
        }
        continue;
      }
      if (!entry.isFile()) throw unsafe(from);
      const file = await open(
        from,
        constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
      );
      try {
        const before = await file.stat({ bigint: true });
        if (!before.isFile() || before.size > 512n * 1024n * 1024n)
          throw unsafe(from);
        const size = Number(before.size);
        if (totalBytes > 1024 * 1024 * 1024 - size) throw unsafe(root);
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
          lstat(from, { bigint: true }),
        ]);
        if (
          offset !== size ||
          !sameMetadata(before, after) ||
          after.dev !== named.dev ||
          after.ino !== named.ino
        )
          throw unsafe(from);
        totalBytes += size;
        snapshots.set(path, snapshot('file', before));
        out.push({
          path: prefix === '' ? path : `${prefix}/${path}`,
          contents,
          executable: (before.mode & 0o111n) !== 0n,
        });
      } finally {
        await file.close();
      }
    }
    const afterDirectory = await directory.stat({ bigint: true });
    if (!sameMetadata(beforeDirectory, afterDirectory)) throw unsafe(root);
    snapshots.set(at, snapshot('directory', beforeDirectory));
  };
  try {
    await walkOne(rootHandle, '');
    await assertTreeSnapshot(rootHandle, snapshots);
  } finally {
    await rootHandle.close();
  }
  return out;
}
