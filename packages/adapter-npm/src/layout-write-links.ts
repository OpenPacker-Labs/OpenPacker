/**
 * Writing the workspace-member links of a layout, and checking afterwards that
 * they are the only symlinks the writer made.
 *
 * This is the one place in the package that asks for a link to be created, and
 * it does so only through `placeMemberLink` (`@openpacker/project-io`), which
 * applies the member-link rules again and creates through the no-follow handle
 * API. Everything else the layout writer produces is a hard link, a copy or a
 * shim, so a symlink anywhere else in what it wrote is a bug or an attack, and
 * `assertNoUndeclaredSymlinks` fails the write rather than leave it.
 *
 * What the layout wrote is what its record lists (`.opm-layout.json`), so a
 * link is removed only while it is exactly the link the record says it wrote.
 */

import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ProjectIoError,
  placeMemberLink,
  removeEmptyScope,
  removeMemberLink,
} from '@openpacker/project-io';
import { type LayoutLink, placePath } from './layout-links.js';
import type { Placement } from './layout-plan.js';

export interface LinkWriteOutcome {
  created: number;
  unchanged: number;
  removed: number;
  /** Recorded links that were not removed because they are no longer what was written. */
  kept: { path: string; reason: string }[];
}

/** The scope directory a link sits in, or undefined when it sits in a node_modules. */
function scopeOf(path: string): string | undefined {
  const cut = path.lastIndexOf('/');
  const directory = path.slice(0, cut);
  return directory.slice(directory.lastIndexOf('/') + 1).startsWith('@')
    ? directory
    : undefined;
}

/**
 * Make `wanted` the links of the layout: take away the recorded links that are
 * no longer wanted (or want another target), then make the wanted ones.
 *
 * A path the layout installs a package at now (`placed`) is not removed here:
 * installing the package replaced the link, without following it.
 */
export async function writeMemberLinks(
  projectRoot: string,
  wanted: readonly LayoutLink[],
  recorded: readonly LayoutLink[],
  placed: ReadonlySet<string>,
): Promise<LinkWriteOutcome> {
  const outcome: LinkWriteOutcome = {
    created: 0,
    unchanged: 0,
    removed: 0,
    kept: [],
  };
  const target = new Map(wanted.map((link) => [link.path, link.target]));
  const emptied = new Set<string>();
  for (const old of recorded) {
    if (placed.has(old.path)) continue;
    if (target.get(old.path) === old.target) continue;
    const result = await removeMemberLink(projectRoot, old.path, old.target);
    if (result === 'removed') {
      outcome.removed += 1;
      const scope = scopeOf(old.path);
      if (scope !== undefined) emptied.add(scope);
    } else if (result === 'kept')
      outcome.kept.push({
        path: join(projectRoot, ...old.path.split('/')),
        reason: `${old.path} is no longer the link opm wrote (${old.target}), so it is left as it is`,
      });
  }
  for (const link of wanted) {
    const result = await placeMemberLink(projectRoot, link.path, link.target);
    if (result === 'created') outcome.created += 1;
    else outcome.unchanged += 1;
  }
  for (const scope of emptied) await removeEmptyScope(projectRoot, scope);
  return outcome;
}

/**
 * Fail if a package the writer placed is a symlink that was not declared.
 * Looked at, not followed.
 */
export async function assertNoUndeclaredSymlinks(
  projectRoot: string,
  placements: readonly Pick<Placement, 'chain'>[],
  declared: readonly LayoutLink[],
): Promise<void> {
  const linked = new Set(declared.map((link) => link.path));
  for (const { chain } of placements) {
    const path = placePath(chain);
    if (linked.has(path)) continue;
    const info = await lstat(join(projectRoot, ...path.split('/')));
    if (info.isSymbolicLink())
      throw new ProjectIoError(
        'UNSAFE_PATH',
        path,
        `${path} is a symlink, and only declared workspace links may be: the layout refuses to leave it`,
      );
  }
}
