/**
 * Whether a name on Windows is a link, decided on any platform against a stand-in
 * for the open handle.
 *
 * libuv's fstat, which is what statting an open NT handle is, never reports a
 * symbolic link: a junction answers "directory" and a file symlink answers
 * "regular file". So the answer has to come from the reparse point itself
 * (FSCTL_GET_REPARSE_POINT). The stand-in answers fstat the way libuv does, with
 * the stat of a real directory or file, and the reparse reader with the bytes
 * the system would send. What NTFS really answers is for the Windows leg of CI
 * (handle-windows-link.test.ts); this pins our reading of it.
 */

import type { BigIntStats } from 'node:fs';
import { lstat, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lstatOpened } from './handle-nt-lstat.js';
import {
  IO_REPARSE_TAG_MOUNT_POINT,
  IO_REPARSE_TAG_SYMLINK,
  encodeMountPoint,
} from './reparse-data.js';

const CALL = 'lstatChild(node_modules, "pkg") on an NT handle opened as itself';
/** A tag that is neither a junction nor a symbolic link: a OneDrive placeholder. */
const IO_REPARSE_TAG_CLOUD = 0x9000601a;

let directoryStat: BigIntStats;
let fileStat: BigIntStats;
let scratch = '';
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'nt-lstat-'));
  await writeFile(join(scratch, 'file'), 'x');
  directoryStat = await lstat(scratch, { bigint: true });
  fileStat = await lstat(join(scratch, 'file'), { bigint: true });
});
afterAll(() => rm(scratch, { recursive: true, force: true }));

/** A reparse buffer with only a tag and an empty payload. */
function tagged(tag: number): Buffer {
  const buffer = Buffer.alloc(8);
  buffer.writeUInt32LE(tag, 0);
  return buffer;
}

function junction(): Buffer {
  return encodeMountPoint(
    '\\??\\C:\\project\\packages\\pkg',
    'C:\\project\\packages\\pkg',
  );
}

function handleOf(stats: BigIntStats) {
  const closed: number[] = [];
  const stand = {
    fd: 7,
    stat: () => Promise.resolve(stats),
    close: () => {
      closed.push(7);
      return Promise.resolve();
    },
  };
  // SAFETY: lstatOpened uses only fd, stat and close, which the stand-in has.
  return { handle: stand as unknown as FileHandle, closed };
}

function kinds(info: BigIntStats) {
  return {
    link: info.isSymbolicLink(),
    directory: info.isDirectory(),
    file: info.isFile(),
  };
}

async function ask(
  stats: BigIntStats,
  reparse: Buffer | undefined,
): Promise<{ info: BigIntStats; closed: number[]; asked: number[] }> {
  const { handle, closed } = handleOf(stats);
  const asked: number[] = [];
  const info = await lstatOpened(handle, (fd) => {
    asked.push(fd);
    return reparse;
  });
  return { info, closed, asked };
}

describe('lstatOpened', () => {
  it('says link, and neither directory nor file, of a junction that fstat calls a directory', async () => {
    const { info } = await ask(directoryStat, junction());

    expect(
      kinds(info),
      `${CALL}: reparse tag 0x${IO_REPARSE_TAG_MOUNT_POINT.toString(16)} (IO_REPARSE_TAG_MOUNT_POINT), fstat mode 0o${directoryStat.mode.toString(8)} (a directory)`,
    ).toEqual({ link: true, directory: false, file: false });
  });

  it('says link of a symbolic link to a directory', async () => {
    const { info } = await ask(directoryStat, tagged(IO_REPARSE_TAG_SYMLINK));

    expect(
      kinds(info),
      `${CALL}: reparse tag 0x${IO_REPARSE_TAG_SYMLINK.toString(16)} (IO_REPARSE_TAG_SYMLINK) on a directory`,
    ).toEqual({ link: true, directory: false, file: false });
  });

  it('says link of a symbolic link to a file, which fstat calls a regular file', async () => {
    const { info } = await ask(fileStat, tagged(IO_REPARSE_TAG_SYMLINK));

    expect(
      kinds(info),
      `${CALL}: reparse tag 0x${IO_REPARSE_TAG_SYMLINK.toString(16)} (IO_REPARSE_TAG_SYMLINK), fstat mode 0o${fileStat.mode.toString(8)} (a regular file)`,
    ).toEqual({ link: true, directory: false, file: false });
  });

  it('says neither link, directory nor file of a reparse point that is some other kind of thing', async () => {
    const { info } = await ask(fileStat, tagged(IO_REPARSE_TAG_CLOUD));

    expect(
      kinds(info),
      `${CALL}: reparse tag 0x${IO_REPARSE_TAG_CLOUD.toString(16)}, which is not a link this package makes or follows`,
    ).toEqual({ link: false, directory: false, file: false });
  });

  it('leaves a plain directory and a plain file as they are', async () => {
    const folder = await ask(directoryStat, undefined);
    const plain = await ask(fileStat, undefined);

    expect(
      [kinds(folder.info), folder.info === directoryStat],
      `${CALL}: STATUS_NOT_A_REPARSE_POINT on a directory`,
    ).toEqual([{ link: false, directory: true, file: false }, true]);
    expect(
      [kinds(plain.info), plain.info === fileStat],
      `${CALL}: STATUS_NOT_A_REPARSE_POINT on a regular file`,
    ).toEqual([{ link: false, directory: false, file: true }, true]);
  });

  it('keeps the identity fstat gave, so a name can still be compared with a handle', async () => {
    const { info } = await ask(directoryStat, junction());

    expect(
      [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs],
      `${CALL}: dev, ino, size, mtimeNs, ctimeNs of the stat a junction is answered with`,
    ).toEqual([
      directoryStat.dev,
      directoryStat.ino,
      directoryStat.size,
      directoryStat.mtimeNs,
      directoryStat.ctimeNs,
    ]);
  });

  it('asks the reparse data of the very handle it statted, and closes that handle once', async () => {
    const { closed, asked } = await ask(directoryStat, junction());

    expect(
      [asked, closed],
      `${CALL}: fds given to FSCTL_GET_REPARSE_POINT and fds closed`,
    ).toEqual([[7], [7]]);
  });

  it('fails, and still closes the handle, when the reparse data cannot be read', async () => {
    const { handle, closed } = handleOf(directoryStat);

    await expect(
      lstatOpened(handle, () => {
        throw new Error(
          'FSCTL_GET_REPARSE_POINT on fd 7 failed with status 0xc0000022',
        );
      }),
      `${CALL}: a handle that cannot say whether it is a link must not be taken for one that is not`,
    ).rejects.toThrow('status 0xc0000022');
    expect(closed, `${CALL}: fds closed after the failure`).toEqual([7]);
  });
});
