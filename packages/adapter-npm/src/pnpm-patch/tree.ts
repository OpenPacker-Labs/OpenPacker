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
 * 4,096 UTF-8 bytes). pnpm takes whatever path the patch gives, `../../x` and
 * a path 40,000 directories deep included; opm refuses the patch.
 */

import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { PACKAGE_TREE_LIMITS, quote } from '@openpacker/adapter-core';
import { PatchRefusal, type PatchTree } from './apply.js';
import type { PatchEffect } from './parse.js';

/** A path below the package as a patch names it. */
export type PatchNode =
  | { readonly kind: 'file'; readonly bytes: Buffer; readonly mode: number }
  | { readonly kind: 'dir' };

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
  return undefined;
}

/** Every path a patch names. */
export function pathsOf(effects: readonly PatchEffect[]): string[] {
  return effects.flatMap((effect) =>
    effect.type === 'rename' ? [effect.fromPath, effect.toPath] : [effect.path],
  );
}

/**
 * Each path and every directory above it, shortest first, and in the order
 * they are first named within one depth. One pass over each path's segments:
 * a prefix is a slice of the path, never a join of its segments again.
 */
export function withAncestors(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const byDepth: string[][] = [];
  for (const path of paths)
    for (let depth = 0, end = path.indexOf('/'); ; depth += 1) {
      const prefix = end === -1 ? path : path.slice(0, end);
      if (!seen.has(prefix)) {
        seen.add(prefix);
        (byDepth[depth] ??= []).push(prefix);
      }
      if (end === -1) break;
      end = path.indexOf('/', end + 1);
    }
  return byDepth.flat();
}

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

  constructor(base: ReadonlyMap<string, PatchNode | undefined>) {
    this.#nodes = new Map(base);
  }

  /** Where each path ends: a file, a directory, or nothing. */
  get nodes(): ReadonlyMap<string, PatchNode | undefined> {
    return this.#nodes;
  }

  #get(path: string): PatchNode | undefined {
    if (!this.#nodes.has(path))
      throw new Error(`the patch tree does not hold ${path}`);
    // A path below a file is not there.
    for (let up = parentOf(path); up !== undefined; up = parentOf(up))
      if (this.#nodes.get(up)?.kind === 'file') return undefined;
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

/** Read every path the patch names below `root`, and each directory above it. */
export async function loadPatchTree(
  root: string,
  effects: readonly PatchEffect[],
): Promise<OverlayTree> {
  const base = new Map<string, PatchNode | undefined>();
  // Shortest first, so a link is found before anything below it is looked at.
  for (const path of withAncestors(pathsOf(effects))) {
    const where = join(root, ...path.split('/'));
    const info = await lstat(where).catch((error: NodeJS.ErrnoException) => {
      // Below a file or a missing directory, nothing is there.
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined;
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
    base.set(path, {
      kind: 'file',
      bytes: await readFile(where, {
        flag: constants.O_RDONLY | constants.O_NOFOLLOW,
      }),
      mode: info.mode & 0o7777,
    });
  }
  return new OverlayTree(base);
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
