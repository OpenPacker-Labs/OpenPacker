import { constants, readFileSync } from 'node:fs';
import { mkdtemp, open, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as entry from './index.js';
import { symlinkChild } from './handle-link.js';
import {
  StableHandleError,
  childBackendKind,
  mkdirChild,
  useChildBackendForTesting,
} from './handle-path.js';
import type { ChildBackend } from './handle-libc.js';
import { counting, glibcBackend, glibcLinux } from './handle-test-support.js';

describe('which backend a platform gets', () => {
  it.each([
    ['linux', 'proc-fd'],
    ['darwin', 'libc-at'],
    ['win32', 'nt'],
    ['freebsd', 'unsupported'],
    ['aix', 'unsupported'],
    ['sunos', 'unsupported'],
  ] as const)('%s uses %s', (platform, kind) => {
    expect(childBackendKind(platform)).toBe(kind);
  });

  it('reads the running platform by default', () => {
    expect(childBackendKind()).toBe(childBackendKind(process.platform));
  });
});

describe('child operations on this platform', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(await realpath(tmpdir()), 'handle-select-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function spoofPlatform(value: NodeJS.Platform): () => void {
    const original = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value });
    return () => {
      if (original) Object.defineProperty(process, 'platform', original);
    };
  }

  /** A backend that must never be reached. */
  const forbidden: ChildBackend = {
    id: 'forbidden',
    openChild: () => Promise.reject(new Error('backend reached')),
    mkdirChild: () => Promise.reject(new Error('backend reached')),
    renameChild: () => Promise.reject(new Error('backend reached')),
    removeChild: () => Promise.reject(new Error('backend reached')),
    lstatChild: () => Promise.reject(new Error('backend reached')),
    readDirChild: () => Promise.reject(new Error('backend reached')),
    readDirChildWithTypes: () => Promise.reject(new Error('backend reached')),
    readDirChildBounded: () => Promise.reject(new Error('backend reached')),
    symlinkChild: () => Promise.reject(new Error('backend reached')),
    readlinkChild: () => Promise.reject(new Error('backend reached')),
    unlinkNonDirectory: () => Promise.reject(new Error('backend reached')),
    rmdirChild: () => Promise.reject(new Error('backend reached')),
  };

  describe.skipIf(process.platform !== 'linux')('on Linux', () => {
    it('keeps /proc/self/fd as the default', async () => {
      const parent = await open(
        dir,
        constants.O_RDONLY | constants.O_DIRECTORY,
      );
      try {
        await mkdirChild(parent, 'x');
        const message = await mkdirChild(parent, 'x').catch(
          (error: Error) => error.message,
        );
        expect(message).toMatch(/\/proc\/self\/fd\/\d+\/x/u);
      } finally {
        await parent.close();
      }
    });

    it('treats macOS as libc and never falls back to a path walk', async () => {
      // With the platform spoofed, koffi finds no native module for it (and
      // this host has no libSystem either), so the darwin backend cannot
      // bind. The contract is that the call then fails and does not quietly
      // use /proc/self/fd (or /dev/fd) to do the work anyway.
      const parent = await open(
        dir,
        constants.O_RDONLY | constants.O_DIRECTORY,
      );
      const restore = spoofPlatform('darwin');
      try {
        const failure = await mkdirChild(parent, 'x').catch(
          (error: Error) => error,
        );
        expect(failure).toBeInstanceOf(StableHandleError);
        expect((failure as StableHandleError).message).toMatch(
          /could not load (koffi|\/usr\/lib\/libSystem\.B\.dylib)/u,
        );
      } finally {
        restore();
        await parent.close();
      }
      expect(await readdir(dir)).toEqual([]);
    });
  });

  describe.skipIf(process.platform !== 'linux')(
    'a link on a platform whose backend cannot load',
    () => {
      const member = '../packages/pkg';

      it.each([
        [
          'darwin',
          'node_modules',
          /could not load (koffi|\/usr\/lib\/libSystem\.B\.dylib)/u,
        ],
        ['win32', 'C:\\project', /./u],
      ] as const)(
        'refuses on %s and never makes the link through /proc/self/fd',
        async (platform, projectRoot, reason) => {
          const parent = await open(
            dir,
            constants.O_RDONLY | constants.O_DIRECTORY,
          );
          const restore = spoofPlatform(platform);
          try {
            const failure = await symlinkChild(parent, 'pkg', member, {
              directory: 'node_modules',
              projectRoot: platform === 'win32' ? projectRoot : dir,
            }).catch((error: Error) => error);
            expect(failure).toBeInstanceOf(Error);
            expect((failure as Error).message).toMatch(reason);
          } finally {
            restore();
            await parent.close();
          }
          expect(await readdir(dir)).toEqual([]);
        },
      );
    },
  );

  describe.skipIf(!glibcLinux())('the test override', () => {
    it('routes Linux calls through the backend it is given, until restored', async () => {
      const { backend, calls } = counting(glibcBackend());
      const parent = await open(
        dir,
        constants.O_RDONLY | constants.O_DIRECTORY,
      );
      try {
        const restore = useChildBackendForTesting(backend);
        await mkdirChild(parent, 'one');
        expect(calls()).toBe(1);
        restore();
        await mkdirChild(parent, 'two');
        expect(calls()).toBe(1);
        expect((await readdir(dir)).sort()).toEqual(['one', 'two']);
      } finally {
        await parent.close();
      }
    });

    it('nests, and restores the previous override', async () => {
      const outer = counting(glibcBackend());
      const inner = counting(glibcBackend());
      const parent = await open(
        dir,
        constants.O_RDONLY | constants.O_DIRECTORY,
      );
      try {
        const restoreOuter = useChildBackendForTesting(outer.backend);
        const restoreInner = useChildBackendForTesting(inner.backend);
        await mkdirChild(parent, 'a');
        restoreInner();
        await mkdirChild(parent, 'b');
        restoreOuter();
        expect([outer.calls(), inner.calls()]).toEqual([1, 1]);
      } finally {
        await parent.close();
      }
    });

    it('is ignored on Windows, which fails closed on its own', async () => {
      const parent = await open(
        dir,
        constants.O_RDONLY | constants.O_DIRECTORY,
      );
      const restoreBackend = useChildBackendForTesting(forbidden);
      const restorePlatform = spoofPlatform('win32');
      try {
        const failure = await mkdirChild(parent, 'x').catch(
          (error: Error) => error,
        );
        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).not.toBe('backend reached');
      } finally {
        restorePlatform();
        restoreBackend();
        await parent.close();
      }
      expect(await readdir(dir)).toEqual([]);
    });
  });
});

describe('the override cannot weaken a shipped build', () => {
  it('is not part of the package entry', () => {
    expect(Object.keys(entry)).not.toContain('useChildBackendForTesting');
    expect(Object.keys(entry)).not.toContain('createLibcAtBackend');
    expect(Object.keys(entry)).not.toContain('linuxGlibcProfile');
  });

  it('does not export the seams of the link code, only what makes, reads and removes a link', () => {
    for (const internal of [
      'NtJunctions',
      'realNtLinkOps',
      'createJunction',
      'readJunction',
      'inspectReparse',
      'windowsReadReparse',
      'openProjectDirectory',
      'libcBackend',
      'rmdirChild',
      'unlinkNonDirectory',
      'unlinkJunction',
      'linkOnTheWayTo',
      'stepPlainDirectory',
      'lstatOpened',
    ])
      expect(Object.keys(entry)).not.toContain(internal);
    for (const exported of [
      'symlinkChild',
      'readlinkChild',
      'unlinkChild',
      'placeMemberLink',
      'readMemberLink',
      'removeMemberLink',
      'removeEmptyScope',
      'collectTree',
    ])
      expect(Object.keys(entry)).toContain(exported);
  });

  it.each([
    'handle-path.ts',
    'handle-libc.ts',
    'handle-libc-profile.ts',
    'handle-link.ts',
    'handle-nt-link.ts',
    'handle-nt-reparse.ts',
    'member-link.ts',
    'link-rules.ts',
    'reparse-data.ts',
  ])('is not switched by an environment variable in %s', (file) => {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    expect(source).not.toMatch(/process\.env|\benv\[/u);
  });
});
