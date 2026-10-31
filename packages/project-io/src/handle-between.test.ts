/**
 * A rename between two open directories, a hard link between them, and a link
 * put back as it was: each relative to the directories' handles, through
 * /proc/self/fd and through the C library's *at calls that macOS uses (run
 * here against glibc), so that names swapped since the directories were opened
 * redirect nothing (ADR 0034, "Writes and removals by path").
 */

import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { useChildBackendForTesting } from './handle-path.js';
import { glibcBackend, glibcLinux } from './handle-test-support.js';
import {
  linkChild,
  moveChild,
  removeChild,
  restoreLinkChild,
} from './index.js';

const worlds: string[] = [];
afterEach(async () => {
  for (const world of worlds.splice(0))
    await rm(world, { recursive: true, force: true });
});

async function world(): Promise<string> {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'between-'));
  worlds.push(dir);
  return dir;
}

describe.each([
  ['/proc/self/fd', () => () => undefined],
  [
    'the C library’s *at calls (the macOS road)',
    () => useChildBackendForTesting(glibcBackend()),
  ],
] as const)(
  'moves and links between two open directories, through %s',
  (_, use) => {
    it.runIf(process.platform === 'linux' && glibcLinux())(
      'act in the directories that were opened, whatever their names lead to since',
      async () => {
        const restore = use();
        try {
          const base = await world();
          await mkdir(join(base, 'from'));
          await mkdir(join(base, 'to'));
          await mkdir(join(base, 'elsewhere-from'));
          await mkdir(join(base, 'elsewhere-to'));
          await writeFile(join(base, 'from', 'file'), 'kept');
          await writeFile(join(base, 'from', 'other'), 'linked');
          await mkdir(join(base, 'to', 'empty'));
          const from = await open(
            join(base, 'from'),
            constants.O_RDONLY | constants.O_DIRECTORY,
          );
          const to = await open(
            join(base, 'to'),
            constants.O_RDONLY | constants.O_DIRECTORY,
          );
          try {
            // Both names now lead somewhere else.
            await rename(join(base, 'from'), join(base, 'from-moved'));
            await rename(join(base, 'to'), join(base, 'to-moved'));
            await symlink(join(base, 'elsewhere-from'), join(base, 'from'));
            await symlink(join(base, 'elsewhere-to'), join(base, 'to'));

            await moveChild(from, 'file', to, 'moved');
            await linkChild(from, 'other', to, 'hard');
            await restoreLinkChild(to, 'link', '../anywhere');
            await removeChild(to, 'empty', { emptyDirectory: true });
          } finally {
            await from.close();
            await to.close();
          }
          expect(await readFile(join(base, 'to-moved', 'moved'), 'utf8')).toBe(
            'kept',
          );
          expect((await stat(join(base, 'to-moved', 'hard'))).ino).toBe(
            (await stat(join(base, 'from-moved', 'other'))).ino,
          );
          expect(await readlink(join(base, 'to-moved', 'link'))).toBe(
            '../anywhere',
          );
          expect((await readdir(join(base, 'to-moved'))).sort()).toEqual([
            'hard',
            'link',
            'moved',
          ]);
          expect(await readdir(join(base, 'elsewhere-from'))).toEqual([]);
          expect(await readdir(join(base, 'elsewhere-to'))).toEqual([]);
        } finally {
          restore();
        }
      },
    );

    it.runIf(process.platform === 'linux' && glibcLinux())(
      'link a source that is a link as the link itself, never what it points at',
      async () => {
        const restore = use();
        try {
          const base = await world();
          await mkdir(join(base, 'from'));
          await mkdir(join(base, 'to'));
          await writeFile(join(base, 'secret'), 'outside');
          await symlink(join(base, 'secret'), join(base, 'from', 'swapped'));
          const from = await open(
            join(base, 'from'),
            constants.O_RDONLY | constants.O_DIRECTORY,
          );
          const to = await open(
            join(base, 'to'),
            constants.O_RDONLY | constants.O_DIRECTORY,
          );
          try {
            await linkChild(from, 'swapped', to, 'placed');
          } finally {
            await from.close();
            await to.close();
          }
          expect(
            (await lstat(join(base, 'to', 'placed'))).isSymbolicLink(),
          ).toBe(true);
          expect((await stat(join(base, 'secret'))).nlink).toBe(1);
        } finally {
          restore();
        }
      },
    );
  },
);
