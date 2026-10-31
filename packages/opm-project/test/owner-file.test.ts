import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  OWNER_FILE,
  currentOwner,
  ownerFileProblem,
  placeDigest,
  readOwnerFile,
  writeOwnerFile,
  type ProcessOwner,
} from '../src/index.js';

/**
 * The record file an owner keeps in a directory of its own (X6): what a
 * holder that cannot put its owner in a file name (a scratch directory, a
 * lease) writes, and what the next process reads to judge it with
 * `isOwnerAlive`. Small, versioned, atomic, and never followed through a link.
 */

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'opm-owner-file-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const other: ProcessOwner = {
  pid: 4242,
  host: 'vm',
  startTime: '777',
  pidNamespace: '4026531836',
  bootId: placeDigest('boot', '9f7295d1-5100-478f-84e5-84ce9db4b369'),
  machineId: placeDigest('machine', '4c398f739c8447eb99d3fe100ad1b0fa'),
};

describe('the owner file of a directory', () => {
  it('names this process by default, and reads back as it', async () => {
    await writeOwnerFile(dir);
    expect(await readOwnerFile(dir)).toEqual(await currentOwner());
    expect(await ownerFileProblem(dir)).toBeUndefined();
  });

  it('names any owner it is given', async () => {
    await writeOwnerFile(dir, other);
    expect(await readOwnerFile(dir)).toEqual(other);
  });

  it('is small, versioned JSON named .owner, with the ids as digests', async () => {
    await writeOwnerFile(dir, other);
    expect(OWNER_FILE).toBe('.owner');
    const text = await readFile(join(dir, OWNER_FILE), 'utf8');
    expect(JSON.parse(text)).toEqual({ ownerVersion: 1, owner: other });
    expect(text.length).toBeLessThan(1024);
    expect(text).not.toContain('4c398f739c8447eb99d3fe100ad1b0fa');
    expect(text).not.toContain('9f7295d1-5100-478f-84e5-84ce9db4b369');
  });

  it('replaces an earlier file whole, and leaves no temporary name', async () => {
    await writeOwnerFile(dir, other);
    await writeOwnerFile(dir, { ...other, pid: 7 });
    expect((await readOwnerFile(dir))?.pid).toBe(7);
    expect(await readdir(dir)).toEqual([OWNER_FILE]);
  });

  it('a file replaced where a link stood is a file, and the link target is untouched', async () => {
    const target = join(dir, 'target.txt');
    await writeFile(target, 'mine');
    await symlink(target, join(dir, OWNER_FILE));
    await writeOwnerFile(dir, other);
    expect(await readFile(target, 'utf8')).toBe('mine');
    expect(await readOwnerFile(dir)).toEqual(other);
  });

  describe('a directory that has none, or none opm can judge', () => {
    it('has no file yet: the holder was cut short before it wrote it', async () => {
      expect(await readOwnerFile(dir)).toBeUndefined();
      expect(await ownerFileProblem(dir)).toBe('missing');
    });

    it('has no directory either', async () => {
      expect(await readOwnerFile(join(dir, 'none'))).toBeUndefined();
      expect(await ownerFileProblem(join(dir, 'none'))).toBe('missing');
    });

    it.each([
      ['empty', ''],
      ['cut short', '{"ownerVersion":1,"owner":{"pid":4'],
      ['not JSON', 'pid 4242'],
      ['of a newer version', JSON.stringify({ ownerVersion: 2, owner: other })],
      ['without an owner', JSON.stringify({ ownerVersion: 1 })],
      [
        'with an owner that is not one',
        JSON.stringify({ ownerVersion: 1, owner: { pid: 0, host: 'vm' } }),
      ],
      ['too large', ' '.repeat(5000)],
      [
        'valid, but over 1 KiB',
        JSON.stringify({
          ownerVersion: 1,
          owner: other,
          padding: 'x'.repeat(1100),
        }),
      ],
    ])('%s is unreadable, and judged by nobody', async (_case, text) => {
      await writeFile(join(dir, OWNER_FILE), text);
      expect(await readOwnerFile(dir)).toBeUndefined();
      expect(await ownerFileProblem(dir)).toBe('unreadable');
    });

    it('a link is unreadable and is not followed', async () => {
      const target = join(dir, 'elsewhere.json');
      await writeFile(
        target,
        JSON.stringify({ ownerVersion: 1, owner: other }),
      );
      await symlink(target, join(dir, OWNER_FILE));
      expect(await readOwnerFile(dir)).toBeUndefined();
      expect(await ownerFileProblem(dir)).toBe('unreadable');
    });

    it('a directory is unreadable', async () => {
      await mkdir(join(dir, OWNER_FILE));
      expect(await readOwnerFile(dir)).toBeUndefined();
      expect(await ownerFileProblem(dir)).toBe('unreadable');
    });
  });

  it('reads an owner file as written: raw ids stay raw', async () => {
    await writeFile(
      join(dir, OWNER_FILE),
      JSON.stringify({
        ownerVersion: 1,
        owner: {
          ...other,
          machineId: '4c398f739c8447eb99d3fe100ad1b0fa',
          bootId: '9f7295d1-5100-478f-84e5-84ce9db4b369',
        },
      }),
    );
    expect(await readOwnerFile(dir)).toEqual({
      ...other,
      machineId: '4c398f739c8447eb99d3fe100ad1b0fa',
      bootId: '9f7295d1-5100-478f-84e5-84ce9db4b369',
    });
  });
});
