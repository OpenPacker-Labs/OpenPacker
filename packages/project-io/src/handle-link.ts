/**
 * Workspace-member links through the no-follow handle API.
 *
 * ADR 0043 keeps symlinks out of `node_modules`. ADR 0050 allows exactly one
 * kind: a link from a workspace member's name to the member's own directory.
 * This is the only place in the package that creates a link, and it goes to
 * the operating system the way every other child operation does, relative to
 * an open directory and never through a path it re-walks:
 *
 * - Linux: `symlink`/`readlink` on `/proc/self/fd/N/name`. The directory is
 *   the magic link, and the final component is created or read, never followed.
 * - macOS: libc `symlinkat` and `readlinkat` (`handle-libc.ts`).
 * - Windows: a directory junction made relative to the parent handle, then
 *   published by one rename (`handle-nt-link.ts`).
 *
 * The rules (`link-rules.ts`) run first, on every platform, so no call reaches
 * the operating system with a name, a place or a target that is not a member
 * link's.
 */

import { readlink, symlink, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import {
  assertHandleSegment,
  libcBackend,
  lstatChild,
  stableHandlePath,
} from './handle-path.js';
import { ProjectIoError } from './index.js';
import {
  linkDirectoryProblem,
  linkNameProblem,
  linkTargetProblem,
} from './link-rules.js';
import {
  createJunction,
  readJunction,
  unlinkJunction,
} from './handle-nt-link.js';
import { unlinkNonDirectory } from './handle-remove.js';
import { linkOnTheWayTo } from './link-prefix.js';

/** Where a link sits, which the rules and a Windows junction both need. */
export interface LinkSite {
  /**
   * The directory the link goes in, relative to the project root and written
   * with `/`: `node_modules`, `node_modules/@scope`, or either inside a
   * package's own `node_modules`.
   */
  directory: string;
  /**
   * The project root as an absolute path. A Windows junction cannot be
   * relative, so its text is this root joined with the directory and target;
   * on other platforms it only anchors the rules.
   */
  projectRoot: string;
}

/** Whether `symlinkChild` made the link or found it already there. */
export type LinkOutcome = 'created' | 'unchanged';

/** Attempts at create-then-compare before a name that keeps changing is given up on. */
const ATTEMPTS = 3;

function refuse(site: LinkSite, name: string, problem: string): ProjectIoError {
  return new ProjectIoError(
    'UNSAFE_PATH',
    `${site.directory}/${name}`,
    `Refusing to create a link at ${site.directory}/${name}: ${problem}`,
  );
}

function conflict(site: LinkSite, name: string, what: string): ProjectIoError {
  return new ProjectIoError(
    'LINK_CONFLICT',
    `${site.directory}/${name}`,
    `${site.directory}/${name} ${what}`,
  );
}

function platformIsWindows(): boolean {
  return process.platform === 'win32';
}

async function createRaw(
  directory: FileHandle,
  name: string,
  target: string,
  site: LinkSite,
): Promise<void> {
  if (platformIsWindows()) return createJunction(directory, name, target, site);
  const libc = libcBackend();
  if (libc !== undefined) return libc.symlinkChild(directory, name, target);
  await symlink(target, join(stableHandlePath(directory), name));
}

/**
 * The text of the link at `name`, as `symlinkChild` was given it. EINVAL when
 * the name is not a link, ENOENT when there is nothing there. The final
 * component is read, never followed.
 *
 * Without a `site`, Windows can only say where its junction points as an
 * absolute path; with one it answers in the relative form it was made from.
 */
export async function readlinkChild(
  directory: FileHandle,
  name: string,
  site?: LinkSite,
): Promise<string> {
  assertHandleSegment(name);
  if (platformIsWindows()) return readJunction(directory, name, site);
  const libc = libcBackend();
  if (libc !== undefined) return libc.readlinkChild(directory, name);
  return readlink(join(stableHandlePath(directory), name));
}

async function describeEntry(
  directory: FileHandle,
  name: string,
): Promise<string> {
  try {
    const info = await lstatChild(directory, name);
    if (info.isDirectory()) return 'is a directory';
    if (info.isFile()) return 'is a regular file';
    return 'is neither a link, a file nor a directory';
  } catch {
    return 'exists and is not a link';
  }
}

function checkRequest(site: LinkSite, name: string, target: string): void {
  assertHandleSegment(name);
  const problem =
    linkDirectoryProblem(site.directory) ??
    linkNameProblem(name) ??
    linkTargetProblem(site.directory, target);
  if (problem !== undefined) throw refuse(site, name, problem);
}

/**
 * Create the member link `name` in `directory`, pointing at `target`.
 *
 * `target` is the link's text, relative to `site.directory`; it must stay
 * inside the project root (see `linkTargetProblem`). Idempotent: a link that is
 * already there with exactly this target is left alone. Anything else at the
 * name, whether a link to somewhere else, a file or a directory, is a
 * `LINK_CONFLICT` that names it; nothing is replaced.
 *
 * Two callers creating the same link at once both succeed. If the two disagree
 * about the target, one gets the conflict.
 *
 * Beyond the text of the target, the nearest existing prefix of the place it
 * names is walked with no-follow opens, and a link on the way refuses the
 * request, also when the link is already there (`link-prefix.ts`, ADR 0050).
 *
 * `site` is the caller's statement of where `directory` sits in the project. It
 * is what the rules and the walk are applied to, and it is not proved against
 * the handle: a handle names the directory it opened, whatever the pathname has
 * become. `placeMemberLink` builds its site from its own walk, so for it the
 * statement is true by construction; a direct caller vouches for it.
 */
export async function symlinkChild(
  directory: FileHandle,
  name: string,
  target: string,
  site: LinkSite,
): Promise<LinkOutcome> {
  checkRequest(site, name, target);
  // Before anything is made, and before an existing link is called unchanged:
  // a prefix swapped since the link was made is found at the next write.
  const through = await linkOnTheWayTo(site, target);
  if (through !== undefined)
    throw refuse(
      site,
      name,
      `its target ${JSON.stringify(target)} goes through ${through}, which is a link, so the link could lead out of the project`,
    );
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    try {
      await createRaw(directory, name, target, site);
      return 'created';
    } catch (error) {
      // SAFETY: the operations above throw Error values with an optional errno code.
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    let existing: string;
    try {
      existing = await readlinkChild(directory, name, site);
    } catch (error) {
      // SAFETY: the operations above throw Error values with an optional errno code.
      const code = (error as NodeJS.ErrnoException).code;
      // Gone again: the entry that was in the way has been removed, so ask again.
      if (code === 'ENOENT') continue;
      if (code === 'EINVAL')
        throw conflict(
          site,
          name,
          `${await describeEntry(directory, name)}, not a link; it is not replaced`,
        );
      throw error;
    }
    if (existing === target) return 'unchanged';
    throw conflict(
      site,
      name,
      `is a link to ${JSON.stringify(existing)}, not ${JSON.stringify(target)}; it is not replaced`,
    );
  }
  throw conflict(site, name, 'kept changing while its link was being made');
}

/** What a link must still be for `unlinkChild` to take it away. */
export interface LinkExpectation {
  /** The text the link was made with. */
  target: string;
  /** Where its directory sits, which a Windows junction needs to give its text back relative. */
  site: LinkSite;
}

function notALink(name: string): ProjectIoError {
  return new ProjectIoError(
    'NOT_A_LINK',
    name,
    `${name} is not a link, so it is not unlinked`,
  );
}

function changed(
  expected: LinkExpectation,
  name: string,
  text: string,
): ProjectIoError {
  return conflict(
    expected.site,
    name,
    `is a link to ${JSON.stringify(text)}, not the ${JSON.stringify(expected.target)} it was expected to be; it is not removed`,
  );
}

/**
 * Remove the link `name` without following it, and nothing else: a name that
 * is not a link is `NOT_A_LINK` and is left, ENOENT when there is nothing there.
 * With `expected`, a link whose text is anything else is a `LINK_CONFLICT` and
 * is left too.
 *
 * What is guaranteed differs by platform, and ADR 0050 says why.
 *
 * - Windows: exact. The name is opened as itself, its reparse data read and the
 *   object that handle holds is the one deleted (`NtJunctions.unlink`), so
 *   nothing the name becomes in between can be removed.
 * - Linux and macOS: the text is read (that is the proof it is a link, and the
 *   comparison with `expected`), then `unlink` is called, which the system
 *   refuses for a directory whatever the name has become. A regular file or a
 *   different link put there by somebody with write access to the directory in
 *   the instant between the two calls is removed; nothing can undo that, and
 *   nobody who could do it needed opm to remove their own file.
 */
export async function unlinkChild(
  directory: FileHandle,
  name: string,
  expected?: LinkExpectation,
): Promise<void> {
  assertHandleSegment(name);
  if (platformIsWindows()) {
    const result = await unlinkJunction(directory, name, expected);
    if (result.kind === 'not-a-link') throw notALink(name);
    if (result.kind === 'other-target' && expected !== undefined)
      throw changed(expected, name, result.text);
    return;
  }
  let text: string;
  try {
    text = await readlinkChild(directory, name);
  } catch (error) {
    // SAFETY: the operations above throw Error values with an optional errno code.
    if ((error as NodeJS.ErrnoException).code === 'EINVAL')
      throw notALink(name);
    throw error;
  }
  if (expected !== undefined && text !== expected.target)
    throw changed(expected, name, text);
  try {
    await unlinkNonDirectory(directory, name);
  } catch (error) {
    // SAFETY: the operations above throw Error values with an optional errno code.
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EISDIR' && code !== 'EPERM') throw error;
    // The system refused a directory that took the link's place since it was
    // read. (EPERM is also what a link it may not remove answers.)
    if ((await lstatChild(directory, name)).isSymbolicLink()) throw error;
    throw notALink(name);
  }
}
