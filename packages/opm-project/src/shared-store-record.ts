import { OpmError } from './types.js';
import { readStableFile, writeStableFile } from './paths.js';

/**
 * The file beside a shared store entry that says what its tree must hash to.
 *
 * Every install of a package that is new to the store records it, and installs
 * of the same package run at the same time, so the file is written and read
 * while others replace it. They all write the same bytes (the digest follows
 * from the archive), and an atomic replace is not a change of content, but it
 * is a change of inode, which is what a stable read or write reports as
 * `INPUT_CHANGED`. Same content is therefore not a conflict; different content
 * is, and that error is kept.
 */

/** The two file operations, so a test can make a peer replace the file between them. */
export interface TreeRecordIo {
  read(path: string): Promise<string>;
  write(path: string, contents: string): Promise<void>;
}

const stableIo: TreeRecordIo = {
  read: (path) => readStableFile(path),
  write: (path, contents) => writeStableFile(path, contents),
};

/**
 * A read that follows the file being replaced. Each replacement is one install
 * finishing its own record, so the number of them is the number of installs
 * racing, and a bound this size is far above any machine's.
 *
 * The race was measured only on Linux (ext4). A read sees the file replaced
 * because the rename unlinks the inode it has open, and Linux moves that
 * inode's ctime as its link count drops to 0, which the read's fstat before and
 * after then disagrees on. POSIX does not require that, so macOS may never show
 * the race, and the shared store is off by default on Windows. The fix depends
 * on no platform: a read is repeated only when it reports `INPUT_CHANGED`, and
 * an identical record is never rewritten.
 */
const READ_ATTEMPTS = 200;

const changed = (error: unknown): boolean =>
  error instanceof OpmError && error.code === 'INPUT_CHANGED';

export async function readTreeRecord(
  path: string,
  io: TreeRecordIo = stableIo,
): Promise<string> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await io.read(path);
    } catch (error) {
      if (!changed(error) || attempt === READ_ATTEMPTS) throw error;
    }
  }
}

/** What is recorded, or undefined when nothing readable is. */
async function recordedAs(
  path: string,
  io: TreeRecordIo,
): Promise<string | undefined> {
  try {
    return await readTreeRecord(path, io);
  } catch {
    return undefined;
  }
}

/**
 * Write the digest an entry's tree must hash to, unless it is already there.
 *
 * A record that already says the same is left alone: replacing it would move it
 * from under every install reading it. When two installs do write at once, the
 * second one's replace finds another inode than it wrote; that is accepted when
 * what is recorded is what it would have written.
 */
export async function recordTreeDigest(
  sharedPath: string,
  treeDigest: string,
  io: TreeRecordIo = stableIo,
): Promise<void> {
  const path = `${sharedPath}.tree`;
  const record = `${treeDigest}\n`;
  if ((await recordedAs(path, io)) === record) return;
  try {
    await io.write(path, record);
  } catch (error) {
    if (!changed(error) || (await recordedAs(path, io)) !== record) throw error;
  }
}
