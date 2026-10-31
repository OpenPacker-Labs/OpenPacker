import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  currentOwner,
  parseProcessOwner,
  type ProcessOwner,
} from './process-owner.js';
import { openChild, removeChild, renameChild } from './paths.js';
import { inParent } from './stable-ops.js';

/**
 * The owner of a directory, in a file of its own (header of
 * `process-owner.ts`): `{ "ownerVersion": 1, "owner": … }`, a few hundred
 * bytes, named {@link OWNER_FILE}. It is written to a temporary name and
 * renamed over, so a reader sees all of an owner or none, and it is read from
 * a handle that refuses a link, so a planted `.owner` that points elsewhere is
 * `unreadable`, not followed.
 */

export const OWNER_FILE = '.owner';
const OWNER_FILE_BYTES = 1024;

/**
 * Why there is no owner to read: `missing` where there is no file (its maker
 * was cut short before it wrote one), `unreadable` where there is something
 * that is not an owner this opm writes (cut short, a newer version, a link, a
 * directory, too large).
 */
export type OwnerFileProblem = 'missing' | 'unreadable';

/** Write the owner file of `dir`: this process unless `owner` says another. */
export async function writeOwnerFile(
  dir: string,
  owner?: ProcessOwner,
): Promise<void> {
  const text = `${JSON.stringify({ ownerVersion: 1, owner: owner ?? (await currentOwner()) })}\n`;
  // Written and renamed through `dir`'s handle, opened one no-follow component
  // at a time from its base: a component swapped for a link since `dir` was
  // made is refused, and no owner file lands where it points.
  await inParent(join(dir, OWNER_FILE), async (parent, name) => {
    const temporary = `.${name}.${randomUUID()}.tmp`;
    const file = await openChild(
      parent,
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o644,
    );
    try {
      await file.writeFile(text);
      await file.chmod(0o644);
      await file.sync();
    } catch (error) {
      await file.close();
      await removeChild(parent, temporary, { force: true });
      throw error;
    }
    await file.close();
    try {
      await renameChild(parent, temporary, name);
    } catch (error) {
      await removeChild(parent, temporary, { force: true });
      throw error;
    }
  });
}

/** What is in the owner file of `dir`: an owner, or why not ({@link OwnerFileProblem}). */
async function readOwnerFileOf(
  dir: string,
): Promise<{ owner: ProcessOwner } | { problem: OwnerFileProblem }> {
  let text: string;
  try {
    const file = await open(
      join(dir, OWNER_FILE),
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | constants.O_NONBLOCK,
    );
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > OWNER_FILE_BYTES)
        return { problem: 'unreadable' };
      text = await file.readFile('utf8');
    } finally {
      await file.close();
    }
  } catch (error) {
    // SAFETY: only the errno code of a failed read is looked at.
    const code = (error as NodeJS.ErrnoException).code;
    return { problem: code === 'ENOENT' ? 'missing' : 'unreadable' };
  }
  try {
    // SAFETY: parsed below; anything unexpected is a file that says nothing.
    const record = JSON.parse(text) as {
      ownerVersion?: unknown;
      owner?: unknown;
    };
    const owner =
      record.ownerVersion === 1 ? parseProcessOwner(record.owner) : undefined;
    return owner === undefined ? { problem: 'unreadable' } : { owner };
  } catch {
    return { problem: 'unreadable' };
  }
}

/** The owner `dir` names, or `undefined`: see {@link ownerFileProblem} for why not. */
export async function readOwnerFile(
  dir: string,
): Promise<ProcessOwner | undefined> {
  const read = await readOwnerFileOf(dir);
  return 'owner' in read ? read.owner : undefined;
}

/** Why {@link readOwnerFile} has no owner for `dir`; `undefined` when it has one. */
export async function ownerFileProblem(
  dir: string,
): Promise<OwnerFileProblem | undefined> {
  const read = await readOwnerFileOf(dir);
  return 'problem' in read ? read.problem : undefined;
}
