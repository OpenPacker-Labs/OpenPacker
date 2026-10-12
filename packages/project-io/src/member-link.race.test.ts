/**
 * Removal that does not act on what it looked at.
 *
 * Linux with glibc only: the libc backend is wrapped so that something happens
 * to the directory at exactly the moment between a look and an act, which no
 * test could otherwise hit. The wrapper acts on the look of the old shape of the
 * code (a listing, a read of the link) and on the act of the new shape (the
 * `rmdir`), so each case says the same thing of any implementation: whatever
 * arrives is not removed.
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChildBackend } from './handle-libc.js';
import { useChildBackendForTesting } from './handle-path.js';
import { glibcBackend, glibcLinux } from './handle-test-support.js';
import {
  placeMemberLink,
  readMemberLink,
  removeEmptyScope,
  removeMemberLink,
} from './member-link.js';
import { MEMBER, cleanup, project } from './member-link-support.js';

let restore: (() => void) | undefined;
afterEach(async () => {
  restore?.();
  restore = undefined;
  await cleanup();
});

/** Run `once` the first time `trigger` says it is time, however many times that is asked. */
function once(work: () => Promise<void>): () => Promise<void> {
  let fired = false;
  return async () => {
    if (fired) return;
    fired = true;
    await work();
  };
}

function wrap(changes: Partial<ChildBackend>): ChildBackend {
  const backend = { ...glibcBackend(), ...changes };
  restore = useChildBackendForTesting(backend);
  return backend;
}

describe.skipIf(!glibcLinux())(
  'removal and the instant between a look and an act',
  () => {
    it('never removes a scope directory something has arrived in, however late', async () => {
      const p = await project();
      const scope = join(p.modules, '@scope');
      await mkdir(scope);
      const arrive = once(() => writeFile(join(scope, 'late'), 'precious'));
      const inner = glibcBackend();
      wrap({
        // Looked at, found empty, and then somebody writes into it.
        readDirChild: async (handle) => {
          const names = await inner.readDirChild(handle);
          await arrive();
          return names;
        },
        // Just before the system looks.
        rmdirChild: async (handle, name) => {
          await arrive();
          return inner.rmdirChild(handle, name);
        },
      });

      expect(
        await removeEmptyScope(p.root, 'node_modules/@scope'),
        'removeEmptyScope(node_modules/@scope) with a file written into it between the look and the removal',
      ).toBe(false);

      expect(await readFile(join(scope, 'late'), 'utf8')).toBe('precious');
    });

    it('walks to the link once to remove it, not once to look and again to act', async () => {
      const p = await project();
      await placeMemberLink(p.root, 'node_modules/pkg', MEMBER);
      const inner = glibcBackend();
      let walks = 0;
      wrap({
        openChild: async (handle, name, flags, mode) => {
          if (name === 'node_modules') walks += 1;
          return inner.openChild(handle, name, flags, mode);
        },
      });

      expect(await removeMemberLink(p.root, 'node_modules/pkg', MEMBER)).toBe(
        'removed',
      );

      expect(
        walks,
        'opens of "node_modules" made by one removeMemberLink: one walk to the link, not a second after it was looked at',
      ).toBe(1);
    });

    it("keeps a directory that takes the link's place after the link was read, with what is in it", async () => {
      const p = await project();
      await placeMemberLink(p.root, 'node_modules/pkg', MEMBER);
      const link = join(p.modules, 'pkg');
      const inner = glibcBackend();
      const swap = once(async () => {
        await rm(link);
        await mkdir(link);
        await writeFile(join(link, 'precious'), 'x');
      });
      wrap({
        readlinkChild: async (handle, name) => {
          const text = await inner.readlinkChild(handle, name);
          await swap();
          return text;
        },
      });

      expect(await removeMemberLink(p.root, 'node_modules/pkg', MEMBER)).toBe(
        'kept',
      );

      expect(await readFile(join(link, 'precious'), 'utf8')).toBe('x');
      restore?.();
      restore = undefined;
      expect(await readMemberLink(p.root, 'node_modules/pkg')).toEqual({
        kind: 'directory',
      });
    });
  },
);
