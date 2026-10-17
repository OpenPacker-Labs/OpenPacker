import { constants } from 'node:fs';
import {
  lstat,
  open,
  readlink,
  rename,
  rm,
  symlink,
  type FileHandle,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { DISCARD_SUFFIX, linkDigest, sha256 } from './rollback-record.js';
import { OpmError } from './types.js';

/**
 * The files of a project as a rollback copy keeps and puts them back
 * (ADR 0056 §4): a link is a link and is never read through, a regular file is
 * read from a no-follow handle, and a file is put back by writing a temporary
 * name beside it and renaming that over it, so that the project's own name is
 * never a half-written file and never a write into an inode someone else also
 * links to.
 */

/** Not defined where links cannot be refused by `open` (Windows). */
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;

/** What `readLive` found. */
export type LiveFile =
  | { kind: 'file'; bytes: Buffer; mode: number }
  | { kind: 'link'; target: string };

/** `undefined` for a path that does not exist; anything else is thrown. */
export function absent(error: NodeJS.ErrnoException): undefined {
  if (error.code === 'ENOENT') return undefined;
  throw error;
}

/** Refuse, with nothing changed: the copy or the project is not what it should be. */
export function refuse(code: string, holder: string, what: string): OpmError {
  const copy = join('.opm', basename(holder));
  return new OpmError(
    code,
    `Refusing to put the project back from ${copy}: ${what}. opm made no change; remove ${copy} to keep the project as it is now.`,
  );
}

export const liveDigest = (live: LiveFile): string =>
  live.kind === 'file' ? sha256(live.bytes) : linkDigest(live.target);

/**
 * What is at `path`: a link as its target, a regular file as its bytes (read
 * from a handle that refuses a link), nothing as `undefined`. A directory or
 * anything else that is not a file is refused: the copy keeps files.
 */
export async function readLive(
  path: string,
  name: string,
): Promise<LiveFile | undefined> {
  const info = await lstat(path).catch(absent);
  if (info === undefined) return undefined;
  if (info.isSymbolicLink())
    return { kind: 'link', target: await readlink(path) };
  if (!info.isFile())
    throw new OpmError(
      'UNSAFE_PATH',
      `${name} is neither a regular file nor a link, and opm will not read it`,
    );
  const file = await openNoFollow(path, name);
  try {
    const opened = await file.stat();
    if (!opened.isFile())
      throw new OpmError('UNSAFE_PATH', `${name} is not a regular file`);
    return {
      kind: 'file',
      bytes: await file.readFile(),
      mode: opened.mode & 0o7777,
    };
  } finally {
    await file.close();
  }
}

/**
 * A kept file's bytes, from a handle that refuses a link, of a file with no
 * other name, and only when they are the ones the record says. Nothing else is
 * ever put back.
 */
export async function readKept(
  path: string,
  expected: string,
  holder: string,
  name: string,
): Promise<Buffer> {
  let file: FileHandle;
  try {
    file = await openNoFollow(path, name);
  } catch (error) {
    // SAFETY: only the errno code of a file-system error is read.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw refuse(
        'ROLLBACK_CONFLICT',
        holder,
        `${name} is missing from the copy`,
      );
    if (error instanceof OpmError)
      throw refuse('UNSAFE_PATH', holder, `${name} in the copy is a link`);
    throw error;
  }
  try {
    const info = await file.stat();
    if (!info.isFile())
      throw refuse(
        'UNSAFE_PATH',
        holder,
        `${name} in the copy is not a regular file`,
      );
    if (info.nlink !== 1)
      throw refuse(
        'UNSAFE_PATH',
        holder,
        `${name} in the copy has ${info.nlink} names, so it may be a file outside the project`,
      );
    const bytes = await file.readFile();
    if (sha256(bytes) !== expected)
      throw refuse(
        'ROLLBACK_CONFLICT',
        holder,
        `${name} in the copy is not the file the record says it kept`,
      );
    return bytes;
  } finally {
    await file.close();
  }
}

async function openNoFollow(path: string, name: string): Promise<FileHandle> {
  try {
    return await open(
      path,
      constants.O_RDONLY | NO_FOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    // SAFETY: only the errno code of a file-system error is read.
    if ((error as NodeJS.ErrnoException).code === 'ELOOP')
      throw new OpmError('UNSAFE_PATH', `${name} is a link`);
    throw error;
  }
}

/** The temporary name beside `path`: one, so a killed putting back leaves at most one. */
const beside = (path: string) =>
  join(dirname(path), `.${basename(path)}.opm-restore`);

/**
 * Put a regular file back at `path`: written whole under a temporary name,
 * flushed, then renamed over the name. A link at `path` is replaced, and a
 * file with other names stays as it is for them.
 */
export async function putFileBack(
  path: string,
  bytes: Buffer,
  mode: number,
): Promise<void> {
  const temporary = beside(path);
  await rm(temporary, { recursive: true, force: true });
  const file = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
    0o600,
  );
  try {
    await file.writeFile(bytes);
    await file.chmod(mode);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
}

/** Put a link back at `path`, the same way. */
export async function putLinkBack(path: string, target: string): Promise<void> {
  const temporary = beside(path);
  await rm(temporary, { recursive: true, force: true });
  await symlink(target, temporary);
  await rename(temporary, path);
}

/**
 * Remove a copy. It is renamed first, so a copy half removed is never taken
 * for one to restore from.
 */
export async function discardCopy(holder: string): Promise<void> {
  const gone = holder.endsWith(DISCARD_SUFFIX)
    ? holder
    : `${holder}${DISCARD_SUFFIX}`;
  if (gone !== holder) await rename(holder, gone).catch(absent);
  await rm(gone, { recursive: true, force: true });
}
