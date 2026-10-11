/**
 * The libc `*at()` backend (bound to glibc) must behave exactly as the
 * /proc/self/fd backend does. Linux only: macOS has no /proc/self/fd to compare
 * with, and checks the same transcripts in handle-darwin.test.ts.
 */

import { constants, readdirSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, open, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectedTranscripts } from './handle-conformance.expected.js';
import { scenarioNames, transcript } from './handle-conformance.js';
import {
  lstatChild,
  mkdirChild,
  openChild,
  readDirChildWithTypes,
  useChildBackendForTesting,
} from './handle-path.js';
import { counting, glibcBackend, glibcLinux } from './handle-test-support.js';

function openDescriptors(): number {
  return readdirSync('/proc/self/fd').length;
}

describe.skipIf(!glibcLinux())('libc *at() matches /proc/self/fd', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(await realpath(tmpdir()), 'handle-parity-'));
    await mkdir(join(dir, 'proc'));
    await mkdir(join(dir, 'libc'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe.each(scenarioNames)('%s', (name) => {
    it('has the recorded transcript under /proc/self/fd', async () => {
      expect(await transcript(name, join(dir, 'proc'))).toEqual(
        expectedTranscripts[name],
      );
    });

    it('has the same transcript through libc', async () => {
      const { backend, calls } = counting(glibcBackend());
      const restore = useChildBackendForTesting(backend);
      try {
        expect(await transcript(name, join(dir, 'libc'))).toEqual(
          expectedTranscripts[name],
        );
      } finally {
        restore();
      }
      // Unsafe segments are refused before any backend is reached.
      expect(calls() > 0).toBe(name !== 'segments');
    });
  });

  it('names no /proc/self/fd path in its errors, the other backend does', async () => {
    const root = await mkdtemp(join(dir, 'routing-'));
    const handle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      await mkdirChild(handle, 'taken');
      const viaProc = await mkdirChild(handle, 'taken').catch(
        (error: Error) => error.message,
      );
      expect(viaProc).toMatch(/\/proc\/self\/fd\/\d+\/taken/u);
      const restore = useChildBackendForTesting(glibcBackend());
      try {
        const viaLibc = await mkdirChild(handle, 'taken').catch(
          (error: Error) => error.message,
        );
        expect(viaLibc).toBe("EEXIST: file already exists, mkdir 'taken'");
      } finally {
        restore();
      }
    } finally {
      await handle.close();
    }
  });

  it('leaves no descriptor open after listing, opening, statting and removing', async () => {
    const root = await mkdtemp(join(dir, 'leaks-'));
    const handle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY);
    const restore = useChildBackendForTesting(glibcBackend());
    try {
      await mkdirChild(handle, 'tree');
      const before = openDescriptors();
      for (let round = 0; round < 200; round += 1) {
        const child = await openChild(
          handle,
          'tree',
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        await readDirChildWithTypes(child);
        await lstatChild(handle, 'tree');
        await child.close();
        await child.close();
        await mkdirChild(handle, 'tree').catch(() => undefined);
      }
      expect(openDescriptors()).toBeLessThanOrEqual(before + 1);
    } finally {
      restore();
      await handle.close();
    }
  });

  it('opens every descriptor close-on-exec, as Node does', async () => {
    const root = await mkdtemp(join(dir, 'cloexec-'));
    const handle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY);
    const CLOEXEC = 0o2000000;
    const flagsOf = (fd: number): number => {
      const info = readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8');
      return Number.parseInt(/flags:\s*(\d+)/u.exec(info)?.[1] ?? '0', 8);
    };
    try {
      await mkdirChild(handle, 'child');
      const viaProc = await openChild(handle, 'child', constants.O_RDONLY);
      const restore = useChildBackendForTesting(glibcBackend());
      try {
        const viaLibc = await openChild(handle, 'child', constants.O_RDONLY);
        try {
          expect(flagsOf(viaProc.fd) & CLOEXEC).toBe(CLOEXEC);
          expect(flagsOf(viaLibc.fd) & CLOEXEC).toBe(CLOEXEC);
        } finally {
          await viaLibc.close();
        }
      } finally {
        restore();
        await viaProc.close();
      }
    } finally {
      await handle.close();
    }
  });
});
