import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  mkdir,
  lstat,
  open,
  realpath,
  rename,
  rm,
  type FileHandle,
} from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from 'node:path';
import { OpmError } from './types.js';

export const MANIFEST_NAME = 'opm.toml';
export const LOCK_NAME = 'opm.lock.json';
export const OPM_DIR = '.opm';
export const STORE_DIR = 'store';
export const BIN_DIR = 'bin';
export const LINKS_DIR = 'links';
export const PROJECT_STATE = 'project.json';
export const CATALOG_NAME = 'catalog.json';

/** Single path segment safe for aliases, bin names, link files. */
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;
const STORE_KEY = /^sha256-[0-9a-f]{64}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

export interface ProjectPaths {
  root: string;
  manifest: string;
  lock: string;
  opmDir: string;
  store: string;
  bin: string;
  links: string;
  projectState: string;
  catalog: string;
}

export function projectPaths(root: string): ProjectPaths {
  const resolved = resolve(root);
  const opmDir = join(resolved, OPM_DIR);
  return {
    root: resolved,
    manifest: join(resolved, MANIFEST_NAME),
    lock: join(resolved, LOCK_NAME),
    opmDir,
    store: join(opmDir, STORE_DIR),
    bin: join(opmDir, BIN_DIR),
    links: join(opmDir, LINKS_DIR),
    projectState: join(opmDir, PROJECT_STATE),
    catalog: join(opmDir, CATALOG_NAME),
  };
}

/**
 * Windows device names, reserved at every directory level and still reserved
 * with an extension — `CON`, `CON.cmd` and `nul` are devices, not files. A bin
 * shim written as `CON.cmd` on Windows writes to the console.
 */
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu;

/** Windows strips trailing dots, so `a.` and `a` are one name there. */
const WINDOWS_TRAILING = /[ .]$/u;

export function assertSafeSegment(value: string, kind: string): string {
  if (!SAFE_SEGMENT.test(value) || value === '.' || value === '..') {
    throw new OpmError(
      'UNSAFE_PATH',
      `Invalid ${kind} "${value}" (must match ${SAFE_SEGMENT})`,
    );
  }
  // Enforced on every platform. A store and a bin directory are portable
  // artifacts, and a name that only works on Linux makes the same lockfile
  // install differently depending on where it runs.
  if (WINDOWS_DEVICE.test(value))
    throw new OpmError(
      'UNSAFE_PATH',
      `Invalid ${kind} "${value}": that is a reserved Windows device name`,
    );
  if (WINDOWS_TRAILING.test(value))
    throw new OpmError(
      'UNSAFE_PATH',
      `Invalid ${kind} "${value}": a trailing dot or space is stripped on Windows, ` +
        `so this would collide with "${value.replace(/[ .]+$/u, '')}"`,
    );
  return value;
}

/**
 * Multi-segment relative path contained beneath a root, such as a delegated
 * pack provider manifest at `.opm/providers/acme.json`. Every segment must be
 * a safe single name; absolute paths and `.`/`..` escapes fail closed. The
 * result is lexical only — callers must open it through the stable no-follow
 * primitives below, never by bare path.
 */
export function assertContainedRelativePath(
  value: string,
  kind: string,
): string {
  if (isAbsolute(value)) {
    throw new OpmError(
      'UNSAFE_PATH',
      `Invalid ${kind} "${value}": must be a relative path contained in the project`,
    );
  }
  const segments = value.split('/');
  for (const segment of segments) assertSafeSegment(segment, kind);
  return join(...segments);
}

export function assertDigest(digest: string): string {
  if (!DIGEST.test(digest)) {
    throw new OpmError(
      'INVALID_DIGEST',
      `Invalid digest "${digest}" (expected sha256:<64 hex>)`,
    );
  }
  return digest;
}

export function storeKeyFromDigest(digest: string): string {
  const normalized = assertDigest(digest);
  const value = normalized.slice('sha256:'.length);
  return `sha256-${value}`;
}

export function assertStoreKey(storeKey: string, digest?: string): string {
  if (!STORE_KEY.test(storeKey)) {
    throw new OpmError(
      'UNSAFE_PATH',
      `Invalid storeKey "${storeKey}" (expected sha256-<64 hex>)`,
    );
  }
  if (digest !== undefined) {
    const expected = storeKeyFromDigest(digest);
    if (storeKey !== expected) {
      throw new OpmError(
        'UNSAFE_PATH',
        `storeKey "${storeKey}" does not match digest ${digest}`,
      );
    }
  }
  return storeKey;
}

/** Resolve a path under root; reject escapes. */
export function resolveContained(root: string, ...parts: string[]): string {
  const base = resolve(root);
  const target = resolve(base, ...parts);
  if (target !== base && !target.startsWith(base + sep)) {
    throw new OpmError(
      'UNSAFE_PATH',
      `Path escapes containment root: ${parts.join('/')}`,
    );
  }
  return target;
}

export function storePathForDigest(root: string, digest: string): string {
  return resolveContained(projectPaths(root).store, storeKeyFromDigest(digest));
}

/**
 * Canonicalize the existing ancestor prefix of a stable target.
 *
 * The no-follow component walk refuses symlinked path components, which would
 * reject every project under a legitimately symlinked ancestor — macOS
 * `/var` → `/private/var` (all of `$TMPDIR`), symlinked home directories,
 * automounters. Honor such a stable pre-existing prefix once by realpath-ing
 * the deepest existing ancestor here; the final component stays lexical so a
 * symlinked target itself is still refused, and the dev/ino identity
 * re-checks against the lexical path still detect a later swap of the prefix.
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
      if (code === 'ELOOP' || code === 'ENOTDIR')
        throw new OpmError(
          'UNSAFE_PATH',
          `Directory path is linked or unstable: ${path}`,
        );
      if (code !== 'ENOENT') throw error;
    }
    const parent = dirname(candidate);
    if (parent === candidate) return absolute;
    tail.push(basename(candidate));
    candidate = parent;
  }
}

export async function openStableDirectory(
  path: string,
  create = false,
): Promise<FileHandle> {
  const absolute = await canonicalizeStableTarget(path);
  const root = parse(absolute).root;
  let handle = await open(
    root,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    for (const part of relative(root, absolute).split(sep).filter(Boolean)) {
      const child = join(stableHandlePath(handle), part);
      if (create)
        await mkdir(child).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'EEXIST') throw error;
        });
      const next = await open(
        child,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      if (!(await next.stat()).isDirectory()) {
        await next.close();
        throw new OpmError('UNSAFE_PATH', `Not a directory: ${path}`);
      }
      await handle.close();
      handle = next;
    }
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    if (
      (error as NodeJS.ErrnoException).code === 'ELOOP' ||
      (error as NodeJS.ErrnoException).code === 'ENOTDIR'
    )
      throw new OpmError(
        'UNSAFE_PATH',
        `Directory path is linked or unstable: ${path}`,
      );
    throw error;
  }
}

export function stableHandlePath(handle: FileHandle): string {
  if (process.platform === 'linux') return `/proc/self/fd/${handle.fd}`;
  if (process.platform === 'darwin') return `/dev/fd/${handle.fd}`;
  throw new OpmError(
    'UNSAFE_PATH',
    'Stable no-follow filesystem handles are unavailable on this platform',
  );
}

export function supportsStableProjectMetadata(
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === 'linux' || platform === 'darwin';
}

export function assertStableProjectMetadataSupported(
  platform: NodeJS.Platform = process.platform,
): void {
  if (!supportsStableProjectMetadata(platform))
    throw new OpmError(
      'UNSAFE_PATH',
      'Stable no-follow project metadata is unavailable on this platform',
    );
}

export async function ensureStableDirectory(path: string): Promise<void> {
  const handle = await openStableDirectory(path, true);
  try {
    await assertNamedDirectory(path, handle);
  } finally {
    await handle.close();
  }
}

export async function readStableFile(
  path: string,
  maximumBytes = 4 * 1024 * 1024,
): Promise<string> {
  const parent = await openStableDirectory(dirname(path));
  try {
    await assertNamedDirectory(dirname(path), parent);
    const contents = await readStableFileAt(
      parent,
      basename(path),
      maximumBytes,
      path,
    );
    await assertNamedDirectory(dirname(path), parent);
    return contents;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP')
      throw new OpmError('UNSAFE_PATH', `Metadata file is linked: ${path}`);
    throw error;
  } finally {
    await parent.close();
  }
}

/** Binary twin of readStableFile, for cached artifact bytes. */
export async function readStableFileBytes(
  path: string,
  maximumBytes = 64 * 1024 * 1024,
): Promise<Uint8Array> {
  const parent = await openStableDirectory(dirname(path));
  try {
    await assertNamedDirectory(dirname(path), parent);
    const contents = await readStableFileBytesAt(
      parent,
      basename(path),
      maximumBytes,
      path,
    );
    await assertNamedDirectory(dirname(path), parent);
    return contents;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP')
      throw new OpmError('UNSAFE_PATH', `Metadata file is linked: ${path}`);
    throw error;
  } finally {
    await parent.close();
  }
}

export async function readStableFileAt(
  parent: FileHandle,
  name: string,
  maximumBytes = 4 * 1024 * 1024,
  displayPath = name,
): Promise<string> {
  return (
    await readStableFileBytesAt(parent, name, maximumBytes, displayPath)
  ).toString('utf8');
}

export async function readStableFileBytesAt(
  parent: FileHandle,
  name: string,
  maximumBytes = 64 * 1024 * 1024,
  displayPath = name,
): Promise<Buffer> {
  assertSafeSegment(name, 'metadata file name');
  const file = await open(
    join(stableHandlePath(parent), name),
    constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
  );
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(maximumBytes))
      throw new OpmError(
        'INVALID_STATE',
        `Metadata file is special or exceeds ${maximumBytes} bytes: ${displayPath}`,
      );
    const buffer = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < buffer.byteLength) {
      const { bytesRead } = await file.read(
        buffer,
        offset,
        buffer.byteLength - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = await file.stat({ bigint: true });
    if (
      BigInt(offset) !== before.size ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.ctimeNs !== before.ctimeNs ||
      after.mtimeNs !== before.mtimeNs
    )
      throw new OpmError(
        'INPUT_CHANGED',
        `Metadata file changed while it was read: ${displayPath}`,
      );
    return buffer;
  } finally {
    await file.close();
  }
}

export async function writeStableFile(
  path: string,
  contents: string | Uint8Array,
  mode = 0o644,
): Promise<void> {
  const parent = await openStableDirectory(dirname(path), true);
  try {
    await writeStableFileAt(parent, basename(path), contents, mode, path);
    await assertNamedDirectory(dirname(path), parent);
  } finally {
    await parent.close();
  }
}

export async function writeStableFileAt(
  parent: FileHandle,
  name: string,
  contents: string | Uint8Array,
  mode = 0o644,
  displayPath = name,
): Promise<void> {
  assertSafeSegment(name, 'metadata file name');
  const directory = stableHandlePath(parent);
  const temporary = join(directory, `.${name}.${randomUUID()}.tmp`);
  let file: FileHandle | undefined;
  try {
    file = await open(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      mode,
    );
    await file.writeFile(contents);
    // O_CREAT applies mode through the umask; chmod the open handle so a
    // requested mode (0o755 bin shims) holds regardless of the umask.
    await file.chmod(mode);
    await file.sync();
    const opened = await file.stat({ bigint: true });
    const named = await lstat(temporary, { bigint: true });
    if (opened.dev !== named.dev || opened.ino !== named.ino)
      throw new OpmError(
        'INPUT_CHANGED',
        `Metadata staging file changed before publication: ${displayPath}`,
      );
    const published = join(directory, name);
    await rename(temporary, published);
    const publishedInfo = await lstat(published, { bigint: true });
    if (opened.dev !== publishedInfo.dev || opened.ino !== publishedInfo.ino)
      throw new OpmError(
        'INPUT_CHANGED',
        `Metadata file changed during publication: ${displayPath}`,
      );
  } finally {
    await file?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function revalidateStableDirectory(
  path: string,
  handle: FileHandle,
): Promise<void> {
  try {
    await assertNamedDirectory(path, handle);
  } catch (error) {
    if (
      ['ENOENT', 'ENOTDIR', 'ELOOP'].includes(
        (error as NodeJS.ErrnoException).code ?? '',
      )
    )
      throw new OpmError(
        'INPUT_CHANGED',
        `Directory changed while it was in use: ${path}`,
      );
    throw error;
  }
}

export async function removeStableFile(path: string): Promise<void> {
  const parent = await openStableDirectory(dirname(path));
  try {
    await rm(join(stableHandlePath(parent), basename(path)), { force: true });
    await assertNamedDirectory(dirname(path), parent);
  } finally {
    await parent.close();
  }
}

export async function removeStableTree(path: string): Promise<void> {
  const parent = await openStableDirectory(dirname(path));
  try {
    await rm(join(stableHandlePath(parent), basename(path)), {
      recursive: true,
      force: true,
    });
    await assertNamedDirectory(dirname(path), parent);
  } finally {
    await parent.close();
  }
}

async function assertNamedDirectory(
  path: string,
  handle: FileHandle,
): Promise<void> {
  const [opened, named] = await Promise.all([
    handle.stat({ bigint: true }),
    lstat(resolve(path), { bigint: true }),
  ]);
  if (
    !named.isDirectory() ||
    named.isSymbolicLink() ||
    opened.dev !== named.dev ||
    opened.ino !== named.ino
  )
    throw new OpmError(
      'INPUT_CHANGED',
      `Directory changed while it was in use: ${path}`,
    );
}

export function findProjectRoot(
  start: string,
  stopAt: string = dirname(resolve(start)),
): string | undefined {
  let current = resolve(start);
  const stop = resolve(stopAt);
  for (;;) {
    const paths = projectPaths(current);
    try {
      // sync check via path only — caller uses exists
      if (current === stop && current !== resolve(start)) break;
    } catch {
      // ignore
    }
    // Use filesystem via require would be async; expose path candidate only
    void paths;
    if (current === dirname(current)) break;
    // walk handled by async helper in project.ts
    break;
  }
  return undefined;
}

export function parentDirs(start: string): string[] {
  const result: string[] = [];
  let current = resolve(start);
  for (;;) {
    result.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return result;
}
