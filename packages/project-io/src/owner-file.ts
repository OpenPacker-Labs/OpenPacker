import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openChild, removeChild, renameChild } from './handle-path.js';
import { openProjectDirectory } from './stable-open.js';
import {
  currentOwner,
  parseProcessOwner,
  type ProcessOwner,
} from './process-owner.js';

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

/** What an owner file holds for `owner`. */
const ownerText = (owner: ProcessOwner): string =>
  `${JSON.stringify({ ownerVersion: 1, owner })}\n`;

/**
 * `writeOwnerFile` through `dir`, a handle of the directory, never by its
 * path: the temporary file is made and renamed over as a child of that handle,
 * so the directory it lands in is the one that was opened.
 */
export async function writeOwnerFileAt(
  dir: FileHandle,
  owner?: ProcessOwner,
): Promise<void> {
  const text = ownerText(owner ?? (await currentOwner()));
  const temporary = `.${OWNER_FILE}.${randomUUID()}.tmp`;
  const file = await openChild(
    dir,
    temporary,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      (constants.O_NOFOLLOW ?? 0),
    0o644,
  );
  try {
    await file.writeFile(text);
    await file.chmod(0o644);
    await file.sync();
  } catch (error) {
    await file.close();
    await removeChild(dir, temporary, { force: true });
    throw error;
  }
  await file.close();
  try {
    await renameChild(dir, temporary, OWNER_FILE);
  } catch (error) {
    await removeChild(dir, temporary, { force: true });
    throw error;
  }
}

/**
 * Write the owner file of `dir`: this process unless `owner` says another.
 * Through `dir`'s handle, opened one no-follow component at a time from its
 * base (`trusted-base.ts`, ADR 0034): a component swapped for a link since
 * `dir` was made is refused, and no owner file lands where it points.
 */
export async function writeOwnerFile(
  dir: string,
  owner?: ProcessOwner,
): Promise<void> {
  const handle = await openProjectDirectory(dir, false);
  try {
    await writeOwnerFileAt(handle, owner);
  } finally {
    await handle.close();
  }
}

/** How an owner file is read: no link followed, a FIFO never waited on. */
const OWNER_FILE_FLAGS =
  constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | constants.O_NONBLOCK;

/** What an owner file says: an owner, or why not ({@link OwnerFileProblem}). */
export type OwnerFileRead =
  | { owner: ProcessOwner }
  | { problem: OwnerFileProblem };

/** What is in the owner file of `dir`: an owner, or why not ({@link OwnerFileProblem}). */
async function readOwnerFileOf(dir: string): Promise<OwnerFileRead> {
  return await readOwnerFileFrom(
    async () => await open(join(dir, OWNER_FILE), OWNER_FILE_FLAGS),
  );
}

/**
 * What is in the owner file of the directory `dir` is a handle of, read
 * through that handle: the directory judged is the one opened, whatever its
 * name has come to name since.
 */
export async function readOwnerFileAt(dir: FileHandle): Promise<OwnerFileRead> {
  return await readOwnerFileFrom(
    async () => await openChild(dir, OWNER_FILE, OWNER_FILE_FLAGS),
  );
}

async function readOwnerFileFrom(
  opened: () => Promise<FileHandle>,
): Promise<OwnerFileRead> {
  let text: string;
  try {
    const file = await opened();
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
