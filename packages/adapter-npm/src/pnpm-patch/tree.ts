/**
 * The files a patch touches, held in memory while it is applied, and written
 * to the package only when the whole patch applied (ADR 0056).
 *
 * pnpm applies a patch in the package's own directory, path by path, and a
 * patch that fails half way leaves the half it did. opm reads every path the
 * patch names (and each directory above it) first, applies the patch to that
 * copy with pnpm's rules (`apply.ts`), and writes the result only on success:
 * a patch applies whole, or the package is left as it was.
 *
 * A path is a `/`-separated path below the package: no `..`, `.` or empty
 * segment, not absolute, no `\` (a name the store refuses) or NUL, and within
 * the bounds of a path in an archive (`PACKAGE_TREE_LIMITS`: 128 segments,
 * 4,096 UTF-8 bytes, and no segment an archive refuses: a Windows device name,
 * a `:`, a trailing dot or space; none past 255 bytes). pnpm takes whatever
 * path the patch gives, `../../x` and a path 40,000 directories deep included;
 * opm refuses the patch.
 *
 * Every lookup of a path walks its ancestors, and every named path and each
 * directory above it costs an `lstat`; both are charged to the patch's work
 * budget (`apply.ts`), in characters, as the work on a file's text is: a
 * patch that names one path 128 directories deep over and over, or thousands
 * of them, is refused as too costly instead of run for minutes. The paths a
 * patch names and the directories above them are also held to the number of
 * files an archive may hold.
 */

import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import {
  PACKAGE_TREE_LIMITS,
  quote,
  segmentProblem,
} from '@openpacker/adapter-core';
import { PatchBudget, PatchRefusal, type PatchTree } from './apply.js';
import type { PatchEffect } from './parse.js';

/** A path below the package as a patch names it. */
export type PatchNode =
  | { readonly kind: 'file'; readonly bytes: Buffer; readonly mode: number }
  | { readonly kind: 'dir' };

/** The longest name a file system takes for a file or a directory. */
export const MAXIMUM_SEGMENT_BYTES = 255;

/** What is wrong with a path a patch names, or undefined. */
export function patchPathProblem(path: string): string | undefined {
  if (path.includes('\0')) return 'holds a NUL character';
  if (path.includes('\\')) return 'holds a backslash';
  if (path.startsWith('/')) return 'is absolute';
  const { maximumDepth, maximumPathBytes } = PACKAGE_TREE_LIMITS;
  // Measured before the path is split: a long one is never taken apart.
  const bytes = Buffer.byteLength(path, 'utf8');
  if (bytes > maximumPathBytes)
    return `is ${bytes} bytes long, more than the ${maximumPathBytes} a path in an archive may be`;
  const segments = path.split('/');
  if (segments.length > maximumDepth)
    return `is ${segments.length} segments deep, more than the ${maximumDepth} a path in an archive may be`;
  if (segments.includes('..')) return 'leaves the package (a ".." segment)';
  if (segments.some((segment) => segment === '' || segment === '.'))
    return 'is not a plain path below the package (an empty or "." segment)';
  for (const segment of segments) {
    // The names an archive refuses on every platform: the materializer's rule.
    const problem = segmentProblem(segment);
    if (problem !== undefined)
      return `has the segment ${JSON.stringify(segment)}, which ${problem.reason}; an archive refuses it on every platform`;
    const length = Buffer.byteLength(segment, 'utf8');
    if (length > MAXIMUM_SEGMENT_BYTES)
      return `has a segment of ${length} bytes, more than the ${MAXIMUM_SEGMENT_BYTES} a file name may be`;
  }
  return undefined;
}

/** The path a patch names that takes the most bytes (empty for a patch that names none). */
export function longestPath(effects: readonly PatchEffect[]): {
  readonly path: string;
  readonly bytes: number;
} {
  let longest = { path: '', bytes: 0 };
  for (const path of pathsOf(effects)) {
    const bytes = Buffer.byteLength(path, 'utf8');
    if (bytes > longest.bytes) longest = { path, bytes };
  }
  return longest;
}

/** Every path a patch names. */
export function pathsOf(effects: readonly PatchEffect[]): string[] {
  return effects.flatMap((effect) =>
    effect.type === 'rename' ? [effect.fromPath, effect.toPath] : [effect.path],
  );
}

/**
 * Each path and every directory above it, shortest first, and in the order
 * they are first named within one depth. A prefix is a slice of the path,
 * never a join of its segments again. The prefixes of a path that were seen
 * are its shortest ones (every prefix of a path seen is seen with it), so the
 * first one not seen is found by bisection, and a path that shares 127
 * directories with an earlier one costs 7 lookups, not 128.
 *
 * `limit` is the most entries the result may hold; one past it is a
 * `PatchRefusal` (`SIZE_LIMIT`) before the rest is built.
 */
export function withAncestors(
  paths: Iterable<string>,
  limit = Number.POSITIVE_INFINITY,
): string[] {
  const seen = new Set<string>();
  const byDepth: string[][] = [];
  let count = 0;
  for (const path of paths) {
    const ends: number[] = [];
    for (let at = path.indexOf('/'); at !== -1; at = path.indexOf('/', at + 1))
      ends.push(at);
    ends.push(path.length);
    let low = 0;
    for (let high = ends.length; low < high; ) {
      const middle = (low + high) >> 1;
      if (seen.has(path.slice(0, ends[middle]))) low = middle + 1;
      else high = middle;
    }
    for (let depth = low; depth < ends.length; depth += 1) {
      const prefix = path.slice(0, ends[depth]);
      seen.add(prefix);
      (byDepth[depth] ??= []).push(prefix);
      count += 1;
      if (count > limit)
        throw new PatchRefusal(
          'SIZE_LIMIT',
          `it names paths that, with the directories above them, come to more than the ${limit} files a package's archive may hold`,
        );
    }
  }
  return byDepth.flat();
}

/** The entries of a patch's tree, held to the files an archive may hold. */
export const entriesOf = (paths: Iterable<string>): string[] =>
  withAncestors(paths, PACKAGE_TREE_LIMITS.maximumFiles);

/** A path as a message shows it: whole when short, its two ends otherwise. */
export const shownPath = (path: string): string =>
  path.length > 160 ? `${path.slice(0, 120)}...${path.slice(-30)}` : path;

const parentOf = (path: string): string | undefined => {
  const at = path.lastIndexOf('/');
  return at === -1 ? undefined : path.slice(0, at);
};

const errno = (code: string, message: string): Error =>
  Object.assign(new Error(`${code}: ${message}`), { code });

/**
 * The paths a patch names, as they stand, with the changes made to them so
 * far. A path is known only if the patch names it or a path below it.
 */
export class OverlayTree implements PatchTree {
  readonly #nodes: Map<string, PatchNode | undefined>;
  readonly #budget: PatchBudget;

  /**
   * `budget` is charged, in characters, for every path a lookup hashes and
   * every ancestor it visits: a lookup costs the depth of its path times the
   * path's length, so a deep path costs thousands of times a shallow one.
   */
  constructor(
    base: ReadonlyMap<string, PatchNode | undefined>,
    budget: PatchBudget = new PatchBudget(),
  ) {
    this.#nodes = new Map(base);
    this.#budget = budget;
  }

  /** Where each path ends: a file, a directory, or nothing. */
  get nodes(): ReadonlyMap<string, PatchNode | undefined> {
    return this.#nodes;
  }

  #get(path: string): PatchNode | undefined {
    this.#budget.charge(path.length + 1);
    if (!this.#nodes.has(path))
      throw new Error(`the patch tree does not hold ${path}`);
    // A path below a file is not there.
    for (let up = parentOf(path); up !== undefined; up = parentOf(up)) {
      this.#budget.charge(up.length + 1);
      if (this.#nodes.get(up)?.kind === 'file') return undefined;
    }
    return this.#nodes.get(path);
  }

  #file(path: string): Extract<PatchNode, { kind: 'file' }> {
    const node = this.#get(path);
    if (node === undefined) throw errno('ENOENT', `no such file, ${path}`);
    if (node.kind === 'dir')
      throw errno('EISDIR', `illegal operation on a directory, ${path}`);
    return node;
  }

  /** `ensureDirSync(dirname(path))`. */
  #ensureParent(path: string): void {
    const parent = parentOf(path);
    if (parent === undefined) return;
    this.#budget.charge(parent.length + 1);
    this.#ensureParent(parent);
    const node = this.#get(parent);
    if (node?.kind === 'file')
      throw errno('ENOTDIR', `not a directory, ${parent}`);
    if (node === undefined) this.#nodes.set(parent, { kind: 'dir' });
  }

  exists(path: string): boolean {
    return this.#get(path) !== undefined;
  }

  readText(path: string): string {
    return this.#file(path).bytes.toString('utf8');
  }

  mode(path: string): number {
    const node = this.#get(path);
    if (node === undefined) throw errno('ENOENT', `no such file, ${path}`);
    if (node.kind === 'dir')
      throw new PatchRefusal(
        'PATCH_FAILED',
        `${quote(path)} is a directory, and opm changes the mode of files only`,
      );
    return node.mode;
  }

  write(path: string, text: string, mode: number): void {
    this.#ensureParent(path);
    const node = this.#get(path);
    if (node?.kind === 'dir')
      throw errno('EISDIR', `illegal operation on a directory, ${path}`);
    // An existing file keeps its mode, as `writeFileSync` keeps it.
    this.#nodes.set(path, {
      kind: 'file',
      bytes: Buffer.from(text, 'utf8'),
      mode: node?.mode ?? mode,
    });
  }

  unlink(path: string): void {
    this.#file(path);
    this.#nodes.set(path, undefined);
  }

  move(from: string, to: string): void {
    const source = this.#get(from);
    if (source === undefined) throw errno('ENOENT', `no such file, ${from}`);
    if (source.kind === 'dir')
      throw new PatchRefusal(
        'PATCH_FAILED',
        `the patch renames the directory ${quote(from)}, and opm renames files only`,
      );
    const target = this.#get(to);
    if (from === to)
      throw new Error('Source and destination must not be the same.');
    if (target?.kind === 'dir')
      throw new Error(
        `Cannot overwrite directory '${to}' with non-directory '${from}'.`,
      );
    this.#ensureParent(to);
    if (target !== undefined) throw new Error('dest already exists.');
    this.#nodes.set(to, source);
    this.#nodes.set(from, undefined);
  }

  chmod(path: string, mode: number): void {
    const file = this.#file(path);
    this.#nodes.set(path, { ...file, mode });
  }
}

/**
 * What an `lstat` of a path costs the budget, before the path's own length:
 * a system call, and the path joined and walked by the system.
 */
export const LSTAT_UNITS = 2048;

/**
 * Read every path the patch names below `root`, and each directory above it,
 * charging `budget` for each `lstat` and each file read.
 */
export async function loadPatchTree(
  root: string,
  effects: readonly PatchEffect[],
  budget: PatchBudget = new PatchBudget(),
): Promise<OverlayTree> {
  const base = new Map<string, PatchNode | undefined>();
  // Shortest first, so a link is found before anything below it is looked at.
  for (const path of entriesOf(pathsOf(effects))) {
    budget.charge(LSTAT_UNITS + path.length);
    const where = join(root, ...path.split('/'));
    const info = await lstat(where).catch((error: NodeJS.ErrnoException) => {
      // Below a file or a missing directory, nothing is there.
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined;
      // The net under `patchPathProblem` and the whole-path check: a name or
      // a path this file system does not take is a refusal that names it.
      if (error.code === 'ENAMETOOLONG')
        throw new PatchRefusal(
          'UNSAFE_PATH',
          `${quote(shownPath(path))} in the patch is longer than the file system takes`,
        );
      throw error;
    });
    if (info === undefined) {
      base.set(path, undefined);
      continue;
    }
    if (info.isDirectory()) {
      base.set(path, { kind: 'dir' });
      continue;
    }
    if (!info.isFile())
      throw new PatchRefusal(
        'UNSAFE_PATH',
        `${quote(path)} in the package is a link or not a regular file`,
      );
    const bytes = await readFile(where, {
      flag: constants.O_RDONLY | constants.O_NOFOLLOW,
    });
    budget.charge(bytes.length + 1);
    base.set(path, { kind: 'file', bytes, mode: info.mode & 0o7777 });
  }
  return new OverlayTree(base, budget);
}

const sameFile = (
  left: PatchNode | undefined,
  right: PatchNode | undefined,
): boolean =>
  left?.kind === 'file' &&
  right?.kind === 'file' &&
  left.mode === right.mode &&
  left.bytes.equals(right.bytes);

/** Write what the patch changed: files removed, directories made, files written. */
export async function commitPatchTree(
  root: string,
  before: ReadonlyMap<string, PatchNode | undefined>,
  after: OverlayTree,
): Promise<void> {
  const where = (path: string) => join(root, ...path.split('/'));
  const changed = [...after.nodes].filter(
    ([path, node]) =>
      !sameFile(before.get(path), node) &&
      !(before.get(path)?.kind === 'dir' && node?.kind === 'dir'),
  );
  for (const [path, node] of changed)
    if (before.get(path)?.kind === 'file' && node?.kind !== 'file')
      await unlink(where(path));
  for (const [path, node] of changed)
    if (node?.kind === 'dir') await mkdir(where(path));
  for (const [path, node] of changed) {
    if (node?.kind !== 'file') continue;
    const handle = await open(
      where(path),
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_TRUNC |
        constants.O_NOFOLLOW,
      node.mode & 0o777,
    );
    try {
      await handle.writeFile(node.bytes);
    } finally {
      await handle.close();
    }
    await chmod(where(path), node.mode & 0o777);
  }
}
