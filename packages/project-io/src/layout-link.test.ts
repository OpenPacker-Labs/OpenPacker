import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { materialiseTree } from './layout.js';

const temps: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'project-io-link-'));
  temps.push(dir);
  const source = join(dir, 'store', 'pkg');
  await mkdir(join(source, 'lib'), { recursive: true });
  await writeFile(join(source, 'package.json'), '{"name":"pkg"}\n');
  await writeFile(join(source, 'lib', 'index.js'), 'module.exports = 1;\n');
  await writeFile(join(source, 'cli.js'), '#!/usr/bin/env node\n');
  await chmod(join(source, 'cli.js'), 0o755);
  return { dir, source, root: join(dir, 'node_modules') };
}

describe('materialiseTree link mode', () => {
  it('hard-links every file to the store inode and leaves the store mode alone', async () => {
    const { source, root } = await fixture();
    const destination = join(root, 'pkg');

    const result = await materialiseTree(source, destination, root, {
      link: true,
    });

    expect(result).toEqual({ files: 3, linked: 3, copied: false });
    for (const path of ['package.json', 'lib/index.js', 'cli.js']) {
      const from = await stat(join(source, path));
      const to = await stat(join(destination, path));
      expect(to.ino).toBe(from.ino);
      expect(to.nlink).toBe(2);
      expect(to.mode).toBe(from.mode);
    }
    expect(((await stat(join(destination, 'cli.js'))).mode & 0o111) !== 0).toBe(
      true,
    );
  });

  it('copies when link mode is not asked for', async () => {
    const { source, root } = await fixture();
    const result = await materialiseTree(source, join(root, 'pkg'), root);
    expect(result.linked).toBe(0);
    expect(result.copied).toBe(true);
    const copy = await stat(join(root, 'pkg', 'package.json'));
    expect(copy.nlink).toBe(1);
  });

  it('replacing a linked tree unlinks it and never touches the store inode', async () => {
    const { source, root } = await fixture();
    const destination = join(root, 'pkg');
    await materialiseTree(source, destination, root, { link: true });
    await writeFile(join(destination, 'stray.txt'), 'left over');

    await materialiseTree(source, destination, root, { link: true });

    await expect(lstat(join(destination, 'stray.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect((await stat(join(source, 'package.json'))).nlink).toBe(2);
    await rm(destination, { recursive: true });
    expect((await stat(join(source, 'package.json'))).nlink).toBe(1);
    expect(await readFile(join(source, 'package.json'), 'utf8')).toBe(
      '{"name":"pkg"}\n',
    );
  });

  it('falls back to a copy for the whole tree once the filesystem refuses to link', async () => {
    const handle = await import('./handle-path.js');
    const attempts: string[] = [];
    vi.spyOn(handle, 'linkChild').mockImplementation(async (_from, name) => {
      attempts.push(name);
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' });
    });
    const { source, root } = await fixture();

    const result = await materialiseTree(source, join(root, 'pkg'), root, {
      link: true,
    });

    expect(result).toMatchObject({ files: 3, linked: 0, copied: true });
    // One refusal is enough: asking again for every file only costs syscalls.
    expect(attempts).toHaveLength(1);
    const copy = await stat(join(root, 'pkg', 'lib', 'index.js'));
    expect(copy.nlink).toBe(1);
    expect(await readFile(join(root, 'pkg', 'lib', 'index.js'), 'utf8')).toBe(
      'module.exports = 1;\n',
    );
  });

  it('keeps linking the other files when one inode is out of links', async () => {
    const handle = await import('./handle-path.js');
    const real = handle.linkChild;
    let first = true;
    vi.spyOn(handle, 'linkChild').mockImplementation(async (...args) => {
      if (first) {
        first = false;
        // SAFETY: The surrounding boundary establishes the asserted domain contract.
        throw Object.assign(new Error('too many links'), { code: 'EMLINK' });
      }
      return real(...args);
    });
    const { source, root } = await fixture();

    const result = await materialiseTree(source, join(root, 'pkg'), root, {
      link: true,
    });

    expect(result.files).toBe(3);
    expect(result.linked).toBe(2);
    expect(result.copied).toBe(true);
  });

  it('refuses a link that does not point at the inode it inspected', async () => {
    const handle = await import('./handle-path.js');
    const { dir, source, root } = await fixture();
    // The source name is swapped for another file between the inspection and
    // the link: the new name is a hard link to something nobody checked.
    const decoy = join(dir, 'decoy.js');
    await writeFile(decoy, 'process.exit(1)\n');
    vi.spyOn(handle, 'linkChild').mockImplementation(
      async (_from, name, to, toName) => {
        const { link } = await import('node:fs/promises');
        await link(decoy, join(`/proc/self/fd/${to.fd}`, toName));
        void name;
      },
    );

    await expect(
      materialiseTree(source, join(root, 'pkg'), root, { link: true }),
    ).rejects.toMatchObject({ code: 'UNSAFE_PATH' });

    await expect(lstat(join(root, 'pkg'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    // The decoy is only unlinked from the staging area, never altered.
    expect(await readFile(decoy, 'utf8')).toBe('process.exit(1)\n');
    expect((await stat(decoy)).nlink).toBe(1);
    expect(await readdir(root)).toEqual([]);
  });

  it('is not disturbed by another project linking the same inode meanwhile', async () => {
    const handle = await import('./handle-path.js');
    const real = handle.linkChild;
    const { dir, source, root } = await fixture();
    let other = 0;
    vi.spyOn(handle, 'linkChild').mockImplementation(async (...args) => {
      await real(...args);
      // A second consumer takes another name for the same store inode, which
      // changes its ctime while this tree is still being assembled.
      await mkdir(join(dir, 'other'), { recursive: true });
      const { link } = await import('node:fs/promises');
      await link(
        join(source, 'package.json'),
        join(dir, 'other', `p${other++}.json`),
      );
    });

    const result = await materialiseTree(source, join(root, 'pkg'), root, {
      link: true,
    });

    expect(result.linked).toBe(3);
  });
});

describe('collectFilesFromHandle over a tree others hard-link', () => {
  it('does not mistake another link appearing for the tree changing', async () => {
    const { collectFilesFromHandle } = await import('./layout-collect.js');
    const { openStableDirectory } = await import('./index.js');
    const { link, unlink } = await import('node:fs/promises');
    const { source, dir } = await fixture();
    const others = join(dir, 'others');
    await mkdir(others);
    let churn = true;
    const churning = (async () => {
      for (let n = 0; churn; n += 1) {
        const name = join(others, `n${n % 8}`);
        await link(join(source, 'lib', 'index.js'), name).catch(
          () => undefined,
        );
        await unlink(name).catch(() => undefined);
      }
    })();
    try {
      for (let round = 0; round < 150; round += 1) {
        const handle = await openStableDirectory(source);
        try {
          const files = await collectFilesFromHandle(handle, '', 'tree', {
            linkTolerant: true,
          });
          expect(files.map((file) => file.path).sort()).toEqual([
            'cli.js',
            'lib/index.js',
            'package.json',
          ]);
        } finally {
          await handle.close();
        }
      }
    } finally {
      churn = false;
      await churning;
    }
  });
});
