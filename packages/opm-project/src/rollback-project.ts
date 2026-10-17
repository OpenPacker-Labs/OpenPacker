import { realpath, stat } from 'node:fs/promises';
import type { RollbackProject } from './rollback-record.js';

/**
 * Which project a copy belongs to (ADR 0056 §4). A copy that arrives in
 * another project's `.opm` (`cp -a .opm`, a CI cache, an archive, a second
 * checkout) would otherwise be put back over it. The record names the root
 * directory's device and inode, which a rename within a file system keeps and a
 * copy does not, and its real path, which a project restored to the same place
 * keeps. Either one agreeing is the same project.
 */

export async function projectIdentity(root: string): Promise<RollbackProject> {
  const [info, path] = await Promise.all([
    stat(root, { bigint: true }),
    realpath(root),
  ]);
  return { dev: String(info.dev), ino: String(info.ino), path };
}

/**
 * The real path of the project a copy was made in, when that is not `root`;
 * `undefined` for a copy of this project, and for one that names none (a
 * record an earlier opm wrote).
 */
export async function otherProject(
  root: string,
  recorded: RollbackProject | undefined,
): Promise<string | undefined> {
  if (recorded === undefined) return undefined;
  const here = await projectIdentity(root);
  const same =
    (here.dev === recorded.dev && here.ino === recorded.ino) ||
    here.path === recorded.path;
  return same ? undefined : recorded.path;
}
