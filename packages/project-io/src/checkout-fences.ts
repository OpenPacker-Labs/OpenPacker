/**
 * The directories a command fences because a checkout or a tree it did not
 * make holds them (ADR 0034, trusted bases): what `beginCommand` adds to the
 * fences before any base is resolved.
 *
 * - **Every checkout around a path.** Each ancestor of the path, up to the
 *   file system's root and past the home directory, that holds `.git` (a
 *   directory, or the gitfile of a worktree or a submodule). A gitfile's
 *   `gitdir:` leads to the repository that holds it, and from there to the
 *   superproject of a submodule (`super/.git/modules/lib`) or to the main
 *   work tree of a worktree (its `commondir`), each fenced in turn and walked
 *   the same way.
 * - **The work tree git is told of.** `GIT_WORK_TREE`, else, where `GIT_DIR`
 *   is set, the directory git would use as the work tree (`core.worktree`,
 *   and the working directory, which git takes for the top level when nothing
 *   names one), and the directory that holds `GIT_DIR`.
 * - **The tree a command runs in, marked or not.** The topmost directory of
 *   the working directory below the deepest of the home directory and the
 *   temporary directory that holds it, else below the file system's root:
 *   `/workspace` for `/workspace/repo/packages/a`, `~/code` for
 *   `~/code/repo/packages/a`. An archive or a Docker context has no `.git`,
 *   and its root may hold no marker either.
 *
 * Nothing here opens a file but a gitfile, a `commondir` and a `config`, each
 * read only up to a few kilobytes; what they name is fenced, never followed
 * for anything else. Fencing more than is needed refuses a link a person made,
 * which is what opm did before it followed any: the safe direction.
 */

import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  resolve,
  sep,
} from 'node:path';

/** How much of a gitfile, a `commondir` or a git `config` is read. */
const SMALL_FILE_BYTES = 64 * 1024;
/** How many checkouts one search fences at most; a cycle of gitfiles ends far sooner. */
const MAXIMUM_CHECKOUTS = 256;

/** Every directory from `path` up to its root, `path` first. */
export function ancestorsOf(path: string): string[] {
  const found: string[] = [];
  for (let dir = resolve(path); ; dir = dirname(dir)) {
    found.push(dir);
    if (dirname(dir) === dir) return found;
  }
}

function within(path: string, base: string): boolean {
  return (
    path === base || path.startsWith(base.endsWith(sep) ? base : base + sep)
  );
}

function readSmall(path: string): string | undefined {
  try {
    const info = statSync(path);
    if (!info.isFile() || info.size > SMALL_FILE_BYTES) return undefined;
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

function realOrNothing(path: string): string[] {
  try {
    return [realpathSync(path)];
  } catch {
    return [];
  }
}

/**
 * The work trees the gitfile `<dir>/.git` leads back to: the superproject of
 * a submodule, whose repository holds the submodule's at
 * `<super>/.git/modules/<name>`, and the main work tree of a worktree, whose
 * repository is its `commondir` (`<main>/.git`).
 */
export function treesOfGitfile(dir: string): string[] {
  const text = readSmall(join(dir, '.git'));
  const named = /^gitdir:[ \t]*(.+?)[ \t]*$/mu.exec(text ?? '')?.[1];
  if (named === undefined) return [];
  const gitdir = resolve(dir, named);
  const repositories = [gitdir, ...realOrNothing(gitdir)];
  const common = readSmall(join(gitdir, 'commondir'))?.trim();
  if (common !== undefined && common !== '') {
    const commonDir = resolve(gitdir, common);
    repositories.push(commonDir, ...realOrNothing(commonDir));
  }
  const trees = new Set<string>();
  for (const repository of repositories)
    for (const ancestor of ancestorsOf(repository))
      if (basename(ancestor) === '.git') trees.add(dirname(ancestor));
  return [...trees];
}

/**
 * Every checkout one of `paths` lies in or is: each ancestor holding `.git`,
 * and the work trees a gitfile among them leads to, and theirs, walked the
 * same way. Nearest first.
 */
export function checkoutsAround(paths: readonly string[]): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const queue = paths.filter((path) => isAbsolute(path));
  while (queue.length > 0 && found.length < MAXIMUM_CHECKOUTS) {
    for (const dir of ancestorsOf(queue.shift()!)) {
      // Its ancestors were walked when it was.
      if (seen.has(dir)) break;
      seen.add(dir);
      let git;
      try {
        git = lstatSync(join(dir, '.git'));
      } catch {
        continue;
      }
      found.push(dir);
      if (!git.isDirectory()) queue.push(...treesOfGitfile(dir));
    }
  }
  return found;
}

/** `core.worktree` in the git `config` of `gitDir`, as written, or undefined. */
function configuredWorkTree(gitDir: string): string | undefined {
  const config = readSmall(join(gitDir, 'config'));
  if (config === undefined) return undefined;
  let core = false;
  for (const line of config.split(/\r?\n/u)) {
    const section = /^\s*\[\s*([^\]\s"]+)/u.exec(line)?.[1];
    if (section !== undefined) {
      core = section.toLowerCase() === 'core';
      continue;
    }
    const value = /^\s*worktree\s*=\s*(.*?)\s*$/iu.exec(line)?.[1];
    if (core && value !== undefined && value !== '')
      return value.replace(/^"(.*)"$/u, '$1');
  }
  return undefined;
}

/**
 * The work trees git is told of in `env` for a command run in `cwd`:
 * `GIT_WORK_TREE`; else, where `GIT_DIR` is set, `core.worktree` and the
 * working directory (git's top level when nothing names one); and the
 * directory that holds `GIT_DIR`.
 */
export function gitEnvironmentTrees(
  cwd: string,
  env: NodeJS.ProcessEnv,
): string[] {
  const trees: string[] = [];
  const workTree = env.GIT_WORK_TREE?.trim();
  const gitDir = env.GIT_DIR?.trim();
  if (workTree !== undefined && workTree !== '')
    trees.push(resolve(cwd, workTree));
  if (gitDir !== undefined && gitDir !== '') {
    const repository = resolve(cwd, gitDir);
    trees.push(dirname(repository));
    if (workTree === undefined || workTree === '') {
      const configured = configuredWorkTree(repository);
      if (configured !== undefined) trees.push(resolve(repository, configured));
      trees.push(resolve(cwd));
    }
  }
  return trees;
}

/**
 * The topmost directory of `path` below the deepest of `roots` that holds it,
 * else below the file system's root; undefined when `path` is that root or one
 * of `roots`. `roots` are the home and temporary directories, as written and
 * as their real paths: a person's own, whose links stay theirs.
 */
export function topmostBelow(
  path: string,
  roots: readonly string[],
): string | undefined {
  const absolute = resolve(path);
  let base = parse(absolute).root;
  for (const root of roots)
    if (
      isAbsolute(root) &&
      within(absolute, resolve(root)) &&
      resolve(root).length > base.length
    )
      base = resolve(root);
  const rest = absolute.slice(base.length).split(sep).filter(Boolean);
  return rest.length === 0 ? undefined : join(base, rest[0]!);
}
