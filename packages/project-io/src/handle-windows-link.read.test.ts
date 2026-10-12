/**
 * Windows only. How a junction is recognised, and what is built on that: the
 * stat of a name, the member-link reader and remover, and the tree walk that
 * takes a recorded link as a leaf.
 *
 * libuv's fstat never reports a symbolic link, so on Windows the answer to "is
 * this a link" has to come from the reparse point itself (handle-nt-lstat.ts).
 * Everything here is where a wrong answer shows: a junction reported as a
 * directory is read as `directory`, kept by the remover, and thrown at by the
 * walk. Every assertion names the call and carries the raw value. Only the
 * Windows leg of CI can run it (handle-nt-lstat.test.ts pins the reading of the
 * reparse data on any platform); until that leg has run, none of this is
 * evidence about NTFS.
 */

import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { symlinkChild } from './handle-link.js';
import {
  MEMBER,
  cleanup,
  project,
  trace,
} from './handle-windows-link-support.js';
import { lstatChild } from './handle-path.js';
import { collectFiles, collectTree } from './layout-collect.js';
import { readMemberLink, removeMemberLink } from './member-link.js';

afterEach(cleanup);

function kinds(info: Awaited<ReturnType<typeof lstatChild>>): string {
  return `isSymbolicLink ${info.isSymbolicLink()}, isDirectory ${info.isDirectory()}, isFile ${info.isFile()} (mode 0o${info.mode.toString(8)})`;
}

describe.skipIf(process.platform !== 'win32')(
  'recognising a junction through NT handles',
  () => {
    it('lstatChild says link of a junction and directory or file of what is not one', async () => {
      const p = await project();
      await mkdir(p.link('folder'));
      await writeFile(p.link('file'), 'x');
      await symlinkChild(p.modules, 'pkg', MEMBER, p.site);

      trace('lstatChild pkg (a junction)');
      const junction = await lstatChild(p.modules, 'pkg');
      trace('lstatChild folder (a directory)');
      const folder = await lstatChild(p.modules, 'folder');
      trace('lstatChild file (a file)');
      const file = await lstatChild(p.modules, 'file');

      expect(
        kinds(junction),
        'lstatChild(node_modules, "pkg") on a junction made by symlinkChild: fstat alone says directory, the answer must come from FSCTL_GET_REPARSE_POINT',
      ).toMatch(/^isSymbolicLink true, isDirectory false, isFile false /u);
      expect(
        kinds(folder),
        'lstatChild(node_modules, "folder") on a plain directory',
      ).toMatch(/^isSymbolicLink false, isDirectory true, isFile false /u);
      expect(
        kinds(file),
        'lstatChild(node_modules, "file") on a plain file',
      ).toMatch(/^isSymbolicLink false, isDirectory false, isFile true /u);
    });

    it('readMemberLink reads a junction as a link with the text it was made with', async () => {
      const p = await project();
      await mkdir(p.link('folder'));
      await writeFile(p.link('file'), 'x');
      await symlinkChild(p.modules, 'pkg', MEMBER, p.site);

      trace('readMemberLink pkg, folder, file, nothing');
      const states = {
        pkg: await readMemberLink(p.root, 'node_modules/pkg'),
        folder: await readMemberLink(p.root, 'node_modules/folder'),
        file: await readMemberLink(p.root, 'node_modules/file'),
        nothing: await readMemberLink(p.root, 'node_modules/nothing'),
      };

      expect(
        states,
        'readMemberLink of a junction, a directory, a file and nothing in node_modules',
      ).toEqual({
        pkg: { kind: 'link', target: MEMBER },
        folder: { kind: 'directory' },
        file: { kind: 'file' },
        nothing: { kind: 'absent' },
      });
    });

    it('removeMemberLink removes a junction only when its text is the recorded one, and never the member', async () => {
      const p = await project();
      await writeFile(join(p.member, 'sentinel'), 'keep');
      await symlinkChild(p.modules, 'pkg', MEMBER, p.site);

      trace('removeMemberLink pkg with another text');
      const other = await removeMemberLink(
        p.root,
        'node_modules/pkg',
        '../packages/other',
      );
      expect(
        other,
        'removeMemberLink of a junction whose text is not the recorded one',
      ).toBe('kept');
      expect(
        (await lstat(p.link('pkg'))).isSymbolicLink(),
        'lstat(node_modules\\pkg).isSymbolicLink() from libuv after the refused removal',
      ).toBe(true);

      trace('removeMemberLink pkg with its own text');
      const own = await removeMemberLink(p.root, 'node_modules/pkg', MEMBER);
      expect(
        own,
        'removeMemberLink of a junction whose text is the recorded one',
      ).toBe('removed');
      await expect(
        lstat(p.link('pkg')),
        'lstat(node_modules\\pkg) after removeMemberLink',
      ).rejects.toMatchObject({ code: 'ENOENT' });
      expect(
        await readFile(join(p.member, 'sentinel'), 'utf8'),
        'sentinel in the member after removeMemberLink removed the junction',
      ).toBe('keep');
    });

    it('collectTree walks a recorded junction as a leaf and never lists the member', async () => {
      const p = await project();
      await writeFile(join(p.member, 'sentinel'), 'keep');
      await mkdir(p.link('registry'));
      await writeFile(join(p.link('registry'), 'package.json'), '{}');
      await symlinkChild(p.modules, 'pkg', MEMBER, p.site);
      const recorded = {
        projectRoot: p.root,
        base: 'node_modules',
        links: new Map([['pkg', MEMBER]]),
      };

      trace('collectTree node_modules with pkg recorded');
      const tree = await collectTree(join(p.root, 'node_modules'), '', {
        memberLinks: recorded,
      });

      expect(
        tree.links,
        'collectTree(node_modules) links, with the junction pkg recorded',
      ).toEqual([{ path: 'pkg', target: MEMBER }]);
      expect(
        tree.files.map((file) => file.path),
        'collectTree(node_modules) files, which must not include anything under the junction',
      ).toEqual(['registry/package.json']);
    });

    it('refuses a junction the record does not name, in collectTree and in collectFiles', async () => {
      const p = await project();
      await symlinkChild(p.modules, 'pkg', MEMBER, p.site);
      await symlinkChild(p.modules, 'other', MEMBER, p.site);
      const recorded = {
        projectRoot: p.root,
        base: 'node_modules',
        links: new Map([['pkg', MEMBER]]),
      };

      trace('collectTree with only pkg recorded, other is not');
      const unrecorded = await collectTree(join(p.root, 'node_modules'), '', {
        memberLinks: recorded,
      }).catch((error: NodeJS.ErrnoException) => error);
      trace('collectFiles with nothing recorded');
      const none = await collectFiles(join(p.root, 'node_modules')).catch(
        (error: NodeJS.ErrnoException) => error,
      );

      expect(
        (unrecorded as { code?: string }).code,
        'code of collectTree(node_modules) when the junction other is not in the record',
      ).toBe('UNSAFE_PATH');
      expect(
        (none as { code?: string }).code,
        'code of collectFiles(node_modules) when it holds junctions',
      ).toBe('UNSAFE_PATH');
    });
  },
);
