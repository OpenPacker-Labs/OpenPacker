import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tarballWrapper } from './tarball-wrapper.js';

/**
 * npm strips the first path component of every entry of a package's tarball,
 * so the one directory the files sit in is the package, whatever it is
 * called. A directory with no file anywhere in it installs nothing under that
 * strip, so it is not a second wrapper; a file beside the wrapper, or a second
 * directory that holds one, keeps the tree whole (ADR 0058 section 8). The
 * npm layout and the opmx tool layout both read the wrapper here.
 */

const made: string[] = [];
afterEach(async () => {
  await Promise.all(
    made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function tree(files: string[], directories: string[] = []) {
  const root = await mkdtemp(join(tmpdir(), 'opm-wrapper-'));
  made.push(root);
  for (const dir of directories)
    await mkdir(join(root, dir), { recursive: true });
  for (const file of files) {
    await mkdir(join(root, file, '..'), { recursive: true });
    await writeFile(join(root, file), 'x');
  }
  return root;
}

describe('the directory a tarball wraps its package in', () => {
  it('is the one top-level directory', async () => {
    expect(await tarballWrapper(await tree(['package/index.js']))).toBe(
      'package',
    );
    expect(await tarballWrapper(await tree(['node/index.js']))).toBe('node');
  });

  it('is that directory however many directories with no file sit beside it', async () => {
    expect(
      await tarballWrapper(
        await tree(['package/index.js'], ['other', 'nested/deeper']),
      ),
    ).toBe('package');
  });

  it('is none where a file sits beside it', async () => {
    expect(
      await tarballWrapper(await tree(['package/index.js', 'README.md'])),
    ).toBeUndefined();
  });

  it('is none where a second directory holds a file, however deep', async () => {
    expect(
      await tarballWrapper(
        await tree(['package/index.js', 'other/inner/o.js']),
      ),
    ).toBeUndefined();
  });

  it('is none for a tree whose only entry is a file, or that holds no file', async () => {
    expect(await tarballWrapper(await tree(['index.js']))).toBeUndefined();
    expect(await tarballWrapper(await tree([], ['a', 'b']))).toBeUndefined();
  });
});
