/**
 * Windows only. Workspace-member links are directory junctions made through
 * NtCreateFile (relative to the parent handle) and FSCTL_SET_REPARSE_POINT, so
 * what NTFS does with them can only be seen here. The CI build matrix runs this
 * file on its Windows legs, and handle-link.test.ts beside it, which runs the
 * link suite the other platforms run, against the same NT code.
 *
 * Every assertion carries a message naming the call and the raw value, and
 * every step writes a line to stderr first: a native fault takes the process
 * down without a JavaScript error, and the last line then names the call.
 */

import { constants, writeSync } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectReparse } from './handle-nt-link.js';
import { readlinkChild, symlinkChild, unlinkChild } from './handle-link.js';
import {
  O_DIRECTORY,
  openChild,
  readDirChild,
  readDirChildWithTypes,
  removeChild,
} from './handle-path.js';
import { IO_REPARSE_TAG_MOUNT_POINT } from './reparse-data.js';

const trace = (message: string): void => {
  writeSync(2, `[handle-windows-link] ${message}\n`);
};

const MEMBER = '../packages/pkg';

const temps: string[] = [];
const handles: FileHandle[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close()));
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function project() {
  trace('make a project directory');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'opm-junction-')));
  temps.push(root);
  await mkdir(join(root, 'node_modules'), { recursive: true });
  await mkdir(join(root, 'packages', 'pkg'), { recursive: true });
  await writeFile(join(root, 'packages', 'pkg', 'index.js'), 'member');
  const modules = await open(join(root, 'node_modules'), constants.O_RDONLY);
  handles.push(modules);
  return {
    root,
    modules,
    site: { directory: 'node_modules', projectRoot: root },
    member: join(root, 'packages', 'pkg'),
    link: (name: string) => join(root, 'node_modules', name),
  };
}

describe.skipIf(process.platform !== 'win32')(
  'member links as junctions through NT handles',
  () => {
    it('makes a mount-point reparse point that names the member, and Node sees a link to it', async () => {
      const p = await project();

      trace('symlinkChild pkg (first junction: FSCTL_SET_REPARSE_POINT)');
      expect(await symlinkChild(p.modules, 'pkg', MEMBER, p.site)).toBe(
        'created',
      );

      trace('inspectReparse pkg (FSCTL_GET_REPARSE_POINT)');
      const data = await inspectReparse(p.modules, 'pkg');
      expect(
        data?.tag.toString(16),
        'reparse tag of node_modules\\pkg from FSCTL_GET_REPARSE_POINT',
      ).toBe(IO_REPARSE_TAG_MOUNT_POINT.toString(16));
      expect(
        data?.substitute,
        'substitute name of the junction from FSCTL_GET_REPARSE_POINT',
      ).toBe(`\\??\\${win32.join(p.root, 'packages', 'pkg')}`);
      expect(
        data?.print,
        'print name of the junction from FSCTL_GET_REPARSE_POINT',
      ).toBe(win32.join(p.root, 'packages', 'pkg'));

      trace("Node's lstat and readlink of the junction");
      expect(
        (await lstat(p.link('pkg'))).isSymbolicLink(),
        'lstat(node_modules\\pkg).isSymbolicLink() from libuv',
      ).toBe(true);
      expect(
        win32.normalize(await readlink(p.link('pkg'))).replace(/\\$/u, ''),
        'fs.readlink(node_modules\\pkg) from libuv',
      ).toBe(win32.join(p.root, 'packages', 'pkg'));
      expect(
        await readFile(join(p.link('pkg'), 'index.js'), 'utf8'),
        'index.js read through the junction',
      ).toBe('member');
    });

    it('gives the text back relative, and leaves no staging name beside the link', async () => {
      const p = await project();
      await symlinkChild(p.modules, 'pkg', MEMBER, p.site);

      trace('readlinkChild pkg with a site');
      expect(
        await readlinkChild(p.modules, 'pkg', p.site),
        'readlinkChild(node_modules\\pkg) relative to the project root',
      ).toBe(MEMBER);
      trace('readdir node_modules');
      expect(
        await readdir(join(p.root, 'node_modules')),
        'names in node_modules after the junction was published by rename',
      ).toEqual(['pkg']);
    });

    it('is idempotent and refuses a taken name without leaving a staging directory', async () => {
      const p = await project();
      await symlinkChild(p.modules, 'pkg', MEMBER, p.site);

      trace('symlinkChild pkg again');
      expect(
        await symlinkChild(p.modules, 'pkg', MEMBER, p.site),
        'symlinkChild over its own junction',
      ).toBe('unchanged');
      trace('symlinkChild pkg to another target');
      const failure = await symlinkChild(
        p.modules,
        'pkg',
        '../packages/other',
        p.site,
      ).catch((error: NodeJS.ErrnoException) => error);
      expect(
        (failure as NodeJS.ErrnoException).code,
        'code of symlinkChild over a junction to another target (rename with ReplaceIfExists off)',
      ).toBe('LINK_CONFLICT');
      expect(
        await readdir(join(p.root, 'node_modules')),
        'names in node_modules after the refused junction',
      ).toEqual(['pkg']);
    });

    it('lists a junction as a link and never lists what it points at', async () => {
      const p = await project();
      await writeFile(join(p.member, 'sentinel'), 'keep');
      await symlinkChild(p.modules, 'pkg', MEMBER, p.site);

      trace('readDirChildWithTypes node_modules');
      const entry = (await readDirChildWithTypes(p.modules)).find(
        (candidate) => candidate.name === 'pkg',
      );
      expect(
        entry?.isSymbolicLink(),
        'isSymbolicLink() of node_modules\\pkg from NtQueryDirectoryFile attributes',
      ).toBe(true);
      trace('openChild pkg as a directory without following');
      const opened = await openChild(
        p.modules,
        'pkg',
        constants.O_RDONLY | O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        expect(
          await readDirChild(opened),
          'NtQueryDirectoryFile on a handle opened on the junction itself, which must not reach the member',
        ).toEqual([]);
      } finally {
        await opened.close();
      }
    });

    it('removes only the junction, by unlinkChild and by a recursive removal of a tree holding one', async () => {
      const p = await project();
      await writeFile(join(p.member, 'sentinel'), 'keep');
      await symlinkChild(p.modules, 'pkg', MEMBER, p.site);

      trace('unlinkChild pkg');
      await unlinkChild(p.modules, 'pkg');
      await expect(
        lstat(p.link('pkg')),
        'lstat after unlinkChild removed the junction',
      ).rejects.toMatchObject({ code: 'ENOENT' });
      expect(
        await readFile(join(p.member, 'sentinel'), 'utf8'),
        'sentinel in the member after unlinkChild',
      ).toBe('keep');

      await symlinkChild(p.modules, 'again', MEMBER, p.site);
      trace('removeChild again (recursive)');
      await removeChild(p.modules, 'again', { recursive: true });
      expect(
        await readFile(join(p.member, 'sentinel'), 'utf8'),
        'sentinel in the member after removeChild recursive on a junction',
      ).toBe('keep');

      await mkdir(join(p.root, 'node_modules', 'host', 'node_modules'), {
        recursive: true,
      });
      const inner = await open(
        join(p.root, 'node_modules', 'host', 'node_modules'),
        constants.O_RDONLY,
      );
      handles.push(inner);
      await symlinkChild(inner, 'inner', '../../../packages/pkg', {
        directory: 'node_modules/host/node_modules',
        projectRoot: p.root,
      });
      trace('removeChild host (recursive, holds a junction)');
      await removeChild(p.modules, 'host', { recursive: true });
      expect(
        await readFile(join(p.member, 'sentinel'), 'utf8'),
        'sentinel in the member after a recursive removal of a tree holding a junction',
      ).toBe('keep');
      expect(
        await readFile(join(p.member, 'index.js'), 'utf8'),
        'index.js in the member after a recursive removal of a tree holding a junction',
      ).toBe('member');
    });

    it('refuses a directory in the way and keeps what is in it', async () => {
      const p = await project();
      await mkdir(p.link('pkg'));
      await writeFile(join(p.link('pkg'), 'inner'), 'precious');

      trace('symlinkChild over a directory');
      const failure = await symlinkChild(
        p.modules,
        'pkg',
        MEMBER,
        p.site,
      ).catch((error: NodeJS.ErrnoException) => error);

      expect(
        (failure as NodeJS.ErrnoException).code,
        'code of symlinkChild over an existing directory',
      ).toBe('LINK_CONFLICT');
      expect(
        await readFile(join(p.link('pkg'), 'inner'), 'utf8'),
        'inner in the directory symlinkChild was refused over',
      ).toBe('precious');
      expect(
        await readdir(join(p.root, 'node_modules')),
        'names in node_modules after the refusal',
      ).toEqual(['pkg']);
    });
  },
);
