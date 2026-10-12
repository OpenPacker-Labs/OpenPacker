/**
 * The order of operations of the Windows junction code, run on any platform
 * against an in-memory directory that keeps the contract of the few NT calls it
 * makes. This proves the control flow (what is created, what is sent, what is
 * closed once, what is cleaned up on each failure); it proves nothing about
 * NTFS, which only the Windows leg of CI can (handle-windows-link.test.ts).
 */

import { constants } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { beforeEach, describe, expect, it } from 'vitest';
import { NtJunctions, type NtLinkOps } from './handle-nt-link.js';
import { decodeReparse, encodeMountPoint } from './reparse-data.js';

const SITE = {
  directory: 'node_modules/@scope',
  projectRoot: 'C:\\work\\project',
};
const ABSOLUTE = 'C:\\work\\project\\packages\\pkg';
const PARENT = {} as FileHandle;

function failure(code: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(code);
  error.code = code;
  return error;
}

/** A directory of named entries, each possibly a reparse point. */
class FakeDirectory implements NtLinkOps {
  readonly entries = new Map<string, { reparse?: Buffer }>();
  readonly log: string[] = [];
  readonly closed: number[] = [];
  /** The status the next reparse request is answered with. */
  setStatus = 0;
  /** Answer reads with a substitute name two bytes short. */
  skewReadBack = false;
  /** The status the next delete of an open handle is answered with. */
  deleteStatus = 0;
  /** Names whose object was deleted through an open handle, with the fd that did it. */
  readonly deleted: [string, number][] = [];
  private readonly opened = new Map<number, string>();
  private nextFd = 100;

  open(
    _directory: FileHandle,
    name: string,
    flags: number,
    access?: number,
  ): Promise<FileHandle> {
    const create = (flags & constants.O_CREAT) !== 0;
    if (create && this.entries.has(name))
      return Promise.reject(failure('EEXIST'));
    if (!create && !this.entries.has(name))
      return Promise.reject(failure('ENOENT'));
    if (create) this.entries.set(name, {});
    this.nextFd += 1;
    const fd = this.nextFd;
    this.opened.set(fd, name);
    this.log.push(
      `open ${name}${create ? ' (create)' : ''}${access === undefined ? '' : ` with access 0x${access.toString(16)}`} as ${fd}`,
    );
    const handle: Pick<FileHandle, 'fd' | 'close'> = {
      fd,
      close: () => {
        this.closed.push(fd);
        this.log.push(`close ${fd}`);
        return Promise.resolve();
      },
    };
    // The two members the code under test uses are the two that are kept.
    return Promise.resolve(handle as FileHandle);
  }

  readReparse(fd: number): Buffer | undefined {
    const reparse = this.entries.get(this.opened.get(fd) ?? '')?.reparse;
    if (reparse === undefined || !this.skewReadBack) return reparse;
    const skewed = Buffer.from(reparse);
    skewed.writeUInt16LE(skewed.readUInt16LE(10) - 2, 10);
    return skewed;
  }

  setReparse(fd: number, data: Buffer): number {
    this.log.push(`set reparse on ${fd}`);
    if (this.setStatus !== 0) return this.setStatus;
    const entry = this.entries.get(this.opened.get(fd) ?? '');
    if (entry === undefined) return 0xc0000008;
    entry.reparse = Buffer.from(data);
    return 0;
  }

  rename(
    _directory: FileHandle,
    from: string,
    to: string,
    replace: boolean,
  ): Promise<void> {
    this.log.push(`rename ${from} -> ${to} replace=${replace}`);
    if (!replace && this.entries.has(to))
      return Promise.reject(failure('EEXIST'));
    this.entries.set(to, this.entries.get(from) ?? {});
    this.entries.delete(from);
    return Promise.resolve();
  }

  remove(_directory: FileHandle, name: string): Promise<void> {
    this.log.push(`remove ${name}`);
    this.entries.delete(name);
    return Promise.resolve();
  }

  /** NT deletes the object a handle holds, whatever its name has become since. */
  deleteOpened(fd: number): number {
    this.log.push(`delete ${fd}`);
    if (this.deleteStatus !== 0) return this.deleteStatus;
    const name = this.opened.get(fd) ?? '';
    this.deleted.push([name, fd]);
    this.entries.delete(name);
    return 0;
  }
}

let directory: FakeDirectory;
let junctions: NtJunctions;
beforeEach(() => {
  directory = new FakeDirectory();
  junctions = new NtJunctions(directory);
});

describe('NtJunctions.create', () => {
  it('makes the directory under a staging name, sends the junction through its handle, closes it, then renames without replacing', async () => {
    await junctions.create(PARENT, 'pkg', '../../packages/pkg', SITE);

    const staging = directory.log[0]!.split(' ')[1]!;
    expect(staging).toMatch(/^\.pkg\.opm-link-[0-9a-f-]{36}$/u);
    expect(directory.log.slice(0, 4)).toEqual([
      `open ${staging} (create) as 101`,
      'set reparse on 101',
      'close 101',
      `rename ${staging} -> pkg replace=false`,
    ]);
    // The name now holds the junction, and nothing is left under the staging name.
    expect([...directory.entries.keys()]).toEqual(['pkg']);
    expect(decodeReparse(directory.entries.get('pkg')!.reparse!)).toMatchObject(
      { substitute: `\\??\\${ABSOLUTE}`, print: ABSOLUTE },
    );
  });

  it('sends exactly the bytes a mount point to the resolved path has', async () => {
    await junctions.create(PARENT, 'pkg', '../../packages/pkg', SITE);

    expect(directory.entries.get('pkg')!.reparse!.toString('hex')).toBe(
      encodeMountPoint(`\\??\\${ABSOLUTE}`, ABSOLUTE).toString('hex'),
    );
  });

  it('closes each handle once', async () => {
    await junctions.create(PARENT, 'pkg', '../../packages/pkg', SITE);

    expect(directory.closed.length).toBe(new Set(directory.closed).size);
  });

  it('removes the staging directory and says which call failed when NT refuses the reparse data', async () => {
    directory.setStatus = 0xc0000022;

    await expect(
      junctions.create(PARENT, 'pkg', '../../packages/pkg', SITE),
    ).rejects.toThrow(
      'FSCTL_SET_REPARSE_POINT for "C:\\\\work\\\\project\\\\packages\\\\pkg" failed with status 0xc0000022',
    );

    expect(directory.entries.size).toBe(0);
    expect(directory.closed).toEqual([101]);
    expect(directory.log.some((line) => line.startsWith('rename'))).toBe(false);
  });

  it('leaves a taken name alone, reports EEXIST and removes its staging directory', async () => {
    directory.entries.set('pkg', { reparse: Buffer.from('theirs') });

    await expect(
      junctions.create(PARENT, 'pkg', '../../packages/pkg', SITE),
    ).rejects.toMatchObject({ code: 'EEXIST' });

    expect([...directory.entries.keys()]).toEqual(['pkg']);
    expect(directory.entries.get('pkg')!.reparse!.toString()).toBe('theirs');
  });

  it('removes a junction that reads back as something else, naming the call and the raw names', async () => {
    directory.skewReadBack = true;

    await expect(
      junctions.create(PARENT, 'checked', '../../packages/pkg', SITE),
    ).rejects.toThrow(
      /FSCTL_SET_REPARSE_POINT then FSCTL_GET_REPARSE_POINT disagree for .*substitute name is/u,
    );

    expect(directory.entries.has('checked')).toBe(false);
  });

  it('checks the first junction only', async () => {
    await junctions.create(PARENT, 'one', '../../packages/pkg', SITE);
    directory.skewReadBack = true;

    await junctions.create(PARENT, 'two', '../../packages/pkg', SITE);

    expect(directory.entries.has('two')).toBe(true);
  });

  it.each(['/work/project', 'project', '\\project', ''])(
    'refuses a project root that is not a drive or share path: %j',
    async (projectRoot) => {
      await expect(
        junctions.create(PARENT, 'pkg', '../../packages/pkg', {
          ...SITE,
          projectRoot,
        }),
      ).rejects.toThrow(/absolute project root with a drive or a share/u);
      expect(directory.log).toEqual([]);
    },
  );
});

describe('NtJunctions.read', () => {
  it('gives the relative text a junction was made from, and the absolute path without a site', async () => {
    await junctions.create(PARENT, 'pkg', '../../packages/pkg', SITE);

    expect(await junctions.read(PARENT, 'pkg', SITE)).toBe(
      '../../packages/pkg',
    );
    expect(await junctions.read(PARENT, 'pkg')).toBe(ABSOLUTE);
  });

  it('says EINVAL for something that is not a reparse point and ENOENT for nothing', async () => {
    directory.entries.set('plain', {});

    await expect(junctions.read(PARENT, 'plain', SITE)).rejects.toMatchObject({
      code: 'EINVAL',
    });
    await expect(junctions.read(PARENT, 'missing', SITE)).rejects.toMatchObject(
      { code: 'ENOENT' },
    );
    expect(await junctions.inspect(PARENT, 'plain')).toBeUndefined();
  });
});

describe('NtJunctions.unlink', () => {
  const DELETE = 0x10000;

  async function made(name = 'pkg'): Promise<void> {
    await junctions.create(PARENT, name, '../../packages/pkg', SITE);
    directory.log.length = 0;
    directory.closed.length = 0;
  }

  it('opens the name as itself with DELETE, reads its reparse data from that handle, deletes that handle, and closes it once', async () => {
    await made();

    expect(await junctions.unlink(PARENT, 'pkg')).toEqual({ kind: 'removed' });

    expect(directory.log).toEqual([
      `open pkg with access 0x${DELETE.toString(16)} as 103`,
      'delete 103',
      'close 103',
    ]);
    expect(
      directory.deleted,
      'names deleted, with the fd that deleted them',
    ).toEqual([['pkg', 103]]);
    expect(directory.entries.has('pkg')).toBe(false);
  });

  it('removes a junction whose text is the expected one', async () => {
    await made();

    expect(
      await junctions.unlink(PARENT, 'pkg', {
        target: '../../packages/pkg',
        site: SITE,
      }),
    ).toEqual({ kind: 'removed' });
    expect(directory.entries.has('pkg')).toBe(false);
  });

  it('leaves a junction whose text is another, and says what it is', async () => {
    await made();

    expect(
      await junctions.unlink(PARENT, 'pkg', {
        target: '../../packages/other',
        site: SITE,
      }),
    ).toEqual({ kind: 'other-target', text: '../../packages/pkg' });
    expect(directory.entries.has('pkg')).toBe(true);
    expect(directory.log.some((line) => line.startsWith('delete'))).toBe(false);
    expect(directory.closed).toEqual([103]);
  });

  it('leaves a plain directory or file, and a reparse point of some other kind', async () => {
    directory.entries.set('plain', {});
    const cloud = Buffer.alloc(16);
    cloud.writeUInt32LE(0x9000601a, 0);
    cloud.writeUInt16LE(8, 4);
    directory.entries.set('placeholder', { reparse: cloud });

    expect(await junctions.unlink(PARENT, 'plain')).toEqual({
      kind: 'not-a-link',
    });
    expect(await junctions.unlink(PARENT, 'placeholder')).toEqual({
      kind: 'not-a-link',
    });

    expect([...directory.entries.keys()]).toEqual(['plain', 'placeholder']);
    expect(directory.log.some((line) => line.startsWith('delete'))).toBe(false);
  });

  it('says ENOENT for nothing, and turns a refusal by NT into an error that keeps the junction', async () => {
    await made();

    await expect(junctions.unlink(PARENT, 'missing')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    directory.deleteStatus = 0xc0000022;
    await expect(junctions.unlink(PARENT, 'pkg')).rejects.toMatchObject({
      code: 'EACCES',
    });
    expect(directory.entries.has('pkg')).toBe(true);
    expect(directory.closed.length).toBe(new Set(directory.closed).size);
  });
});
