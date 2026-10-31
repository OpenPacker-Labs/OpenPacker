/**
 * Resolving a base: the links on the way to a directory, followed one
 * directory handle at a time, each judged before it is followed.
 *
 * `realpath(3)` asks the kernel to follow every link; the kernel then applies
 * `fs.protected_symlinks` if the system has it switched on, and knows nothing
 * of a project. Here each component is looked at relative to the open handle
 * of the directory before it, and a link is followed only when two rules allow
 * it (ADR 0034, trusted bases):
 *
 * - **No link inside a fence.** A fence is the identity (device and inode) of
 *   a directory that holds what a project or a validated root holds. A link
 *   whose directory, or any directory above it on the way, is fenced belongs
 *   to that project and is never followed, whatever path named the project:
 *   a bind mount, a case variant on a case-insensitive volume or a firmlink
 *   of the project is the same directory, so the same fence.
 * - **`protected_symlinks`' own rule, whatever the system's setting.** A link
 *   in a sticky directory that anyone may write to is followed only when it
 *   belongs to the user resolving it or to the directory's owner.
 *
 * A link not followed ends the resolution: the rest of the path is kept as it
 * was written, for the no-follow walk to refuse. A name is judged once, by the
 * `lstat` of it relative to its directory's handle, and its text is read
 * relative to the same handle and accepted only if the name still is the link
 * that was judged. The real path is read from the last handle, as the kernel
 * names that directory (`/proc/self/fd/N` on Linux, `F_GETPATH` on macOS).
 */

import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readlinkSync,
  statSync,
  type BigIntStats,
} from 'node:fs';
import { isAbsolute, join, parse, resolve, sep } from 'node:path';
import { libcDirectoryOps } from './base-resolve-libc.js';
import { darwinProfile } from './handle-libc-profile.js';

/** A directory, whatever path names it. */
export interface Identity {
  readonly dev: bigint;
  readonly ino: bigint;
}

export function identityKey(identity: Identity): string {
  return `${identity.dev}:${identity.ino}`;
}

export function sameIdentity(
  a: Identity | undefined,
  b: Identity | undefined,
): boolean {
  return (
    a !== undefined && b !== undefined && a.dev === b.dev && a.ino === b.ino
  );
}

/** The identity `path` leads to now, following links as the kernel does; undefined when it leads nowhere. */
export function identityOf(path: string): Identity | undefined {
  try {
    const info = statSync(path, { bigint: true });
    return { dev: info.dev, ino: info.ino };
  } catch {
    return undefined;
  }
}

/** Why a link on the way was not followed. */
export type Refusal =
  /** It lies in a fenced directory: it is the project's. */
  | 'fenced'
  /** It lies in a sticky directory anyone may write to, and belongs to neither the user nor the directory's owner. */
  | 'sticky'
  /** It changed between being judged and being read. */
  | 'changed';

/** What resolving a path found. */
export interface Resolution {
  /** The real path of what resolved, then the rest of the path as written. */
  readonly real: string;
  /** The directory `real` names, where every component resolved to one. */
  readonly identity: Identity | undefined;
  /** The fence keys of every directory a followed link lay in or below. */
  readonly linkAncestors: ReadonlySet<string>;
  /** The link the resolution stopped at, and why. */
  readonly refused:
    | { readonly link: string; readonly why: Refusal }
    | undefined;
  /**
   * The deepest directory the resolution reached: how many components of
   * `real` lead to it, and what it is. The whole of `real` when `identity` is
   * defined.
   */
  readonly reached: { readonly depth: number; readonly identity: Identity };
}

/** What one look at a name relative to a directory found. */
export interface Inspected {
  readonly kind: 'directory' | 'link' | 'other';
  readonly dev: bigint;
  readonly ino: bigint;
  readonly uid: bigint;
  readonly mode: bigint;
}

/**
 * The handle-relative calls a resolution makes. Each platform has one
 * implementation; a test may run another (`useResolverOpsForTesting`).
 */
export interface DirectoryOps {
  readonly id: string;
  /** The root directory of a path (`/`, `C:\`), opened. */
  openRoot(root: string): number;
  /** The name `name` of the open directory `fd`, not followed; undefined when nothing usable is there. */
  inspectAt(fd: number, name: string): Inspected | undefined;
  /** The child directory `name` of `fd`, opened without following a link; undefined when it is not a plain directory. */
  openDirectoryAt(fd: number, name: string): number | undefined;
  /** The text of the link `name` of `fd`. */
  readlinkAt(fd: number, name: string): string;
  /** The open directory `fd`. */
  inspect(fd: number): Inspected;
  /** The path the system gives the open directory `fd`, or undefined. */
  pathOf(fd: number): string | undefined;
  close(fd: number): void;
}

function kindOf(info: BigIntStats): Inspected['kind'] {
  if (info.isSymbolicLink()) return 'link';
  return info.isDirectory() ? 'directory' : 'other';
}

function inspected(info: BigIntStats): Inspected {
  return {
    kind: kindOf(info),
    dev: info.dev,
    ino: info.ino,
    uid: info.uid,
    mode: info.mode,
  };
}

const DIRECTORY_FLAGS =
  constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | constants.O_NOFOLLOW;

/**
 * Linux: `/proc/self/fd/N` is a magic link to the open directory, so a name
 * joined onto it is looked up relative to that directory and nowhere else.
 */
export const procOps: DirectoryOps = {
  id: 'proc-fd',
  openRoot: (root) =>
    openSync(root, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0)),
  inspectAt(fd, name) {
    try {
      return inspected(
        lstatSync(`/proc/self/fd/${fd}/${name}`, { bigint: true }),
      );
    } catch {
      return undefined;
    }
  },
  openDirectoryAt(fd, name) {
    try {
      return openSync(`/proc/self/fd/${fd}/${name}`, DIRECTORY_FLAGS);
    } catch {
      return undefined;
    }
  },
  readlinkAt: (fd, name) => readlinkSync(`/proc/self/fd/${fd}/${name}`),
  inspect: (fd) => inspected(fstatSync(fd, { bigint: true })),
  pathOf(fd) {
    try {
      const path = readlinkSync(`/proc/self/fd/${fd}`);
      return path.endsWith(' (deleted)') || !isAbsolute(path)
        ? undefined
        : path;
    } catch {
      return undefined;
    }
  },
  close: (fd) => closeSync(fd),
};

/**
 * Windows has no handle-relative lookup Node can call synchronously, and no
 * sticky permission: a resolution there goes by path, one component at a time,
 * with the same fences. A "descriptor" here is an index into the paths opened.
 */
export function pathOps(): DirectoryOps {
  const open = new Map<number, string>();
  let next = 1;
  const add = (path: string) => {
    open.set(next, path);
    return next++;
  };
  const at = (fd: number, name: string) => join(open.get(fd)!, name);
  return {
    id: 'path',
    openRoot: (root) => add(root),
    inspectAt(fd, name) {
      try {
        return inspected(lstatSync(at(fd, name), { bigint: true }));
      } catch {
        return undefined;
      }
    },
    openDirectoryAt(fd, name) {
      try {
        const info = lstatSync(at(fd, name), { bigint: true });
        return info.isDirectory() && !info.isSymbolicLink()
          ? add(at(fd, name))
          : undefined;
      } catch {
        return undefined;
      }
    },
    readlinkAt: (fd, name) => readlinkSync(at(fd, name)),
    inspect: (fd) => inspected(statSync(open.get(fd)!, { bigint: true })),
    pathOf: (fd) => open.get(fd),
    close: (fd) => {
      open.delete(fd);
    },
  };
}

let testOps: DirectoryOps | undefined;
let darwinOps: DirectoryOps | undefined;

/**
 * Resolve every base through `ops` until the returned function is called.
 * Tests drive the libc implementation against glibc with it. Not re-exported
 * from the package entry, and no environment variable reaches it.
 */
export function useResolverOpsForTesting(ops: DirectoryOps): () => void {
  const previous = testOps;
  testOps = ops;
  return () => {
    testOps = previous;
  };
}

/**
 * The implementation for this call. The platform is read at call time, as
 * `libcBackend` reads it. On macOS the C library is bound at once; where it
 * cannot be (no koffi, no libSystem), every handle-relative child operation is
 * refused already, and a base is resolved by path, which then widens nothing.
 */
export function resolverOps(): DirectoryOps {
  if (testOps !== undefined) return testOps;
  if (process.platform === 'linux') return procOps;
  if (process.platform === 'darwin') {
    if (darwinOps === undefined) {
      try {
        darwinOps = libcDirectoryOps(darwinProfile(process.arch), {
          bindNow: true,
        });
      } catch {
        darwinOps = pathOps();
      }
    }
    return darwinOps;
  }
  return pathOps();
}

const S_ISVTX = 0o1000n;
const S_IWOTH = 0o002n;
/** As many links as one resolution follows before it gives up, as Linux does. */
const MAXIMUM_LINKS = 40;

interface Step {
  readonly fd: number;
  readonly name: string;
  readonly identity: Identity;
  readonly uid: bigint;
  readonly mode: bigint;
  readonly fenced: boolean;
}

export interface ResolveOptions {
  /** Fence keys: no link in or below one of these directories is followed. */
  readonly fences: { has(key: string): boolean };
  /** The user resolving, for the sticky rule; undefined where there is none (Windows). */
  readonly euid: number | undefined;
}

/** The user the sticky rule speaks for. */
export function currentEuid(): number | undefined {
  return process.platform === 'win32' ? undefined : process.geteuid?.();
}

/**
 * `path` resolved through `ops` as described at the top of this file. A
 * component that does not exist, is not a directory, or is a link not
 * followed ends it; it and the rest are kept as written.
 */
export function resolveWith(
  ops: DirectoryOps,
  path: string,
  options: ResolveOptions,
): Resolution {
  const absolute = resolve(path);
  const firstRoot = parse(absolute).root;
  const pending = absolute.slice(firstRoot.length).split(sep).filter(Boolean);
  const linkAncestors = new Set<string>();
  const stack: Step[] = [];
  let kept: string[] = [];
  let refused: Resolution['refused'];
  let links = 0;
  const push = (fd: number, name: string) => {
    let info: Inspected;
    try {
      info = ops.inspect(fd);
    } catch (error) {
      ops.close(fd);
      throw error;
    }
    const identity = { dev: info.dev, ino: info.ino };
    stack.push({
      fd,
      name,
      identity,
      uid: info.uid,
      mode: info.mode,
      fenced: options.fences.has(identityKey(identity)),
    });
  };
  const closeAll = () => {
    for (const step of stack.splice(0)) ops.close(step.fd);
  };
  const display = (name: string) =>
    join(...stack.map((step) => step.name), name);
  try {
    push(ops.openRoot(firstRoot), firstRoot);
    while (pending.length > 0) {
      const name = pending.shift()!;
      if (name === '.') continue;
      if (name === '..') {
        if (stack.length > 1) ops.close(stack.pop()!.fd);
        continue;
      }
      const top = stack[stack.length - 1]!;
      const found = ops.inspectAt(top.fd, name);
      if (found === undefined || found.kind === 'other') {
        kept = [name, ...pending];
        break;
      }
      if (found.kind === 'directory') {
        const fd = ops.openDirectoryAt(top.fd, name);
        if (fd === undefined) {
          kept = [name, ...pending];
          break;
        }
        push(fd, name);
        continue;
      }
      const why: Refusal | undefined = stack.some((step) => step.fenced)
        ? 'fenced'
        : (top.mode & S_ISVTX) !== 0n &&
            (top.mode & S_IWOTH) !== 0n &&
            options.euid !== undefined &&
            found.uid !== BigInt(options.euid) &&
            found.uid !== top.uid
          ? 'sticky'
          : undefined;
      if (why !== undefined || links >= MAXIMUM_LINKS) {
        if (why !== undefined) refused = { link: display(name), why };
        kept = [name, ...pending];
        break;
      }
      const text = ops.readlinkAt(top.fd, name);
      const again = ops.inspectAt(top.fd, name);
      if (
        again?.kind !== 'link' ||
        again.dev !== found.dev ||
        again.ino !== found.ino
      ) {
        refused = { link: display(name), why: 'changed' };
        kept = [name, ...pending];
        break;
      }
      links += 1;
      for (const step of stack) linkAncestors.add(identityKey(step.identity));
      const target = text.replace(/^\\\\\?\\/u, '');
      if (isAbsolute(target)) {
        const absoluteTarget = resolve(target);
        const root = parse(absoluteTarget).root;
        closeAll();
        push(ops.openRoot(root), root);
        pending.unshift(
          ...absoluteTarget.slice(root.length).split(sep).filter(Boolean),
        );
      } else pending.unshift(...target.split(/[\\/]/u).filter(Boolean));
    }
    const top = stack[stack.length - 1]!;
    const named = ops.pathOf(top.fd) ?? join(...stack.map((step) => step.name));
    return {
      real: kept.length === 0 ? named : join(named, ...kept),
      identity: kept.length === 0 ? top.identity : undefined,
      linkAncestors,
      refused,
      reached: { depth: componentsOf(named).length, identity: top.identity },
    };
  } finally {
    closeAll();
  }
}

/** The components of an absolute path below its root. */
export function componentsOf(path: string): string[] {
  const absolute = resolve(path);
  return absolute.slice(parse(absolute).root.length).split(sep).filter(Boolean);
}
