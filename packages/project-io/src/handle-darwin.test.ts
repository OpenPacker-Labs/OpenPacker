/**
 * macOS only. The suites that run everywhere else bind the same backend to
 * glibc; this one runs the shipped selection against the real libSystem, so a
 * wrong struct layout, symbol name, errno value or AT_* flag shows up here
 * (CI: the macOS leg of "CI build") and not in a user's project.
 */

import { constants } from 'node:fs';
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectedTranscripts } from './handle-conformance.expected.js';
import { scenarioNames, transcript } from './handle-conformance.js';
import {
  childBackendKind,
  lstatChild,
  openChild,
  readDirChild,
  readDirChildBounded,
  readDirChildWithTypes,
} from './handle-path.js';
import { removeTree, materialiseTree } from './layout.js';
import { readTextFile, writeFileAtomic } from './index.js';
import { openStablePath } from './stable-path.js';

describe.skipIf(process.platform !== 'darwin')(
  'macOS handle-relative I/O through libSystem',
  () => {
    let dir: string;
    beforeAll(async () => {
      // $TMPDIR is under /var, a symlink to /private/var; every component of
      // the path walked below is opened without following links.
      dir = await mkdtemp(join(await realpath(tmpdir()), 'handle-darwin-'));
    });
    afterAll(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('selects the libc backend, not a /dev/fd path', () => {
      expect(childBackendKind()).toBe('libc-at');
    });

    /** A directory of this test's own, so listings never see a neighbor's files. */
    async function scratch(): Promise<string> {
      return await mkdtemp(join(dir, 'case-'));
    }

    it('is needed: /dev/fd/N/child does not resolve on macOS', async () => {
      const here = await scratch();
      const parent = await open(
        here,
        constants.O_RDONLY | constants.O_DIRECTORY,
      );
      try {
        await writeFile(join(here, 'child'), 'x');
        // The failure that broke `opm init`: the child of a descriptor is not a path.
        const outcome = await open(`/dev/fd/${parent.fd}/child`).then(
          async (handle) => {
            await handle.close();
            return 'opened';
          },
          (error: NodeJS.ErrnoException) => error.code ?? 'failed',
        );
        expect(outcome).not.toBe('opened');
      } finally {
        await parent.close();
      }
    });

    it('binds libSystem and finds its struct layouts in agreement with Node', async () => {
      // The first stat and the first listing compare libc's answer for "/"
      // with Node's; a mismatch throws with the field and the raw bytes.
      const here = await scratch();
      const parent = await open(
        here,
        constants.O_RDONLY | constants.O_DIRECTORY,
      );
      try {
        await writeFile(join(here, 'probe'), 'four');
        await mkdir(join(here, 'probe-dir'));
        await symlink('probe', join(here, 'probe-link'));
        const file = await lstatChild(parent, 'probe');
        const named = await stat(join(here, 'probe'), { bigint: true });
        expect(file.isFile()).toBe(true);
        expect(file.size).toBe(4n);
        expect([file.dev, file.ino, file.mode]).toEqual([
          named.dev,
          named.ino,
          named.mode,
        ]);
        expect((await lstatChild(parent, 'probe-link')).isSymbolicLink()).toBe(
          true,
        );
        expect(await readDirChild(parent)).toEqual([
          'probe',
          'probe-dir',
          'probe-link',
        ]);
        const kinds = (await readDirChildWithTypes(parent)).map((entry) =>
          entry.isDirectory() ? 'd' : entry.isSymbolicLink() ? 'l' : 'f',
        );
        expect(kinds).toEqual(['f', 'd', 'l']);
        const opened = await openChild(parent, 'probe', constants.O_RDONLY);
        try {
          expect((await opened.stat({ bigint: true })).ino).toBe(named.ino);
        } finally {
          await opened.close();
        }
      } finally {
        await parent.close();
      }
    });

    it('stops a listing at the bound and types the entries it keeps', async () => {
      // The bound is applied while libSystem's readdir is being walked, so a
      // directory of millions of names is not held in memory first.
      const here = await scratch();
      for (const name of ['a', 'b', 'c', 'd'])
        await writeFile(join(here, name), '');
      await mkdir(join(here, 'e'));
      const parent = await open(
        here,
        constants.O_RDONLY | constants.O_DIRECTORY,
      );
      try {
        const cut = await readDirChildBounded(parent, 2);
        expect([cut.exceeded, cut.entries.length]).toEqual([true, 2]);
        const whole = await readDirChildBounded(parent, 5);
        expect([whole.exceeded, whole.entries.length]).toEqual([false, 5]);
        expect(
          whole.entries
            .filter((entry) => entry.isDirectory())
            .map((e) => e.name),
        ).toEqual(['e']);
        expect(whole.entries.filter((entry) => entry.isFile())).toHaveLength(4);
      } finally {
        await parent.close();
      }
    });

    it('opens an existing path without /dev/fd, and refuses a link in it', async () => {
      // What the sandbox does for every bind: ancestors opened one at a time
      // from "/" with O_NOFOLLOW, each step an openat against the one before.
      const here = await scratch();
      await mkdir(join(here, 'real', 'inner'), { recursive: true });
      await writeFile(join(here, 'real', 'inner', 'file'), 'bytes');
      await symlink(join(here, 'real'), join(here, 'alias'));
      const folder = await openStablePath(join(here, 'real', 'inner'));
      try {
        expect((await folder.stat()).isDirectory()).toBe(true);
      } finally {
        await folder.close();
      }
      const file = await openStablePath(join(here, 'real', 'inner', 'file'), {
        allowFile: true,
      });
      try {
        expect((await file.stat()).size).toBe(5);
      } finally {
        await file.close();
      }
      const refused = await openStablePath(join(here, 'alias', 'inner')).then(
        () => 'opened',
        (error: NodeJS.ErrnoException) => error.code,
      );
      expect(['ELOOP', 'ENOTDIR']).toContain(refused);
    });

    describe.each(scenarioNames)('%s', (name) => {
      it('behaves as recorded on Linux', { timeout: 60_000 }, async () => {
        await mkdir(join(dir, 'scenarios'), { recursive: true });
        expect(await transcript(name, join(dir, 'scenarios'))).toEqual(
          expectedTranscripts[name],
        );
      });
    });

    it('creates missing directories and writes a project file atomically', async () => {
      // What `opm init` does: walk down from "/", creating what is missing.
      const file = join(await scratch(), 'project', 'nested', 'opm.toml');
      await writeFileAtomic(file, 'name = "smoke"\n');
      expect(await readTextFile(file)).toMatchObject({
        text: 'name = "smoke"\n',
      });
      await writeFileAtomic(file, 'name = "again"\n');
      expect(await readFile(file, 'utf8')).toBe('name = "again"\n');
    });

    it('materialises a tree with its modes, then removes it', async () => {
      const here = await scratch();
      const source = join(here, 'tree-source');
      const root = join(here, 'tree-root');
      await mkdir(join(source, 'bin'), { recursive: true });
      await writeFile(join(source, 'index.js'), 'module.exports = 1;\n');
      await writeFile(join(source, 'bin', 'tool'), '#!/bin/sh\n');
      await chmod(join(source, 'bin', 'tool'), 0o755);
      const result = await materialiseTree(source, join(root, 'pkg'), root);
      expect(result.files).toBe(2);
      expect(await readFile(join(root, 'pkg', 'index.js'), 'utf8')).toBe(
        'module.exports = 1;\n',
      );
      expect((await stat(join(root, 'pkg', 'bin', 'tool'))).mode & 0o777).toBe(
        0o755,
      );
      await removeTree(join(root, 'pkg'));
      await expect(stat(join(root, 'pkg'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });

    it('refuses to walk through a symlinked directory', async () => {
      const here = await scratch();
      const target = join(here, 'real');
      await mkdir(target);
      await symlink(target, join(here, 'alias'));
      const parent = await open(
        here,
        constants.O_RDONLY | constants.O_DIRECTORY,
      );
      try {
        const code = await openChild(
          parent,
          'alias',
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        ).then(
          () => 'opened',
          (error: NodeJS.ErrnoException) => error.code,
        );
        expect(['ELOOP', 'ENOTDIR']).toContain(code);
      } finally {
        await parent.close();
      }
    });
  },
);
