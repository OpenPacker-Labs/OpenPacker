/**
 * The roots opm judges before it uses them (ADR 0034, amendment of
 * 2026-10-31): a store root a link appears at while it is made, and a tool
 * cache others may write to. Each is refused, and is no base.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { forgetBases } from '@openpacker/project-io';
import {
  enableDefaultSharedStore,
  fetchTool,
  usableSharedRoot,
} from '../src/index.js';
import { ensureStableDirectory } from '../src/paths.js';
import { NpmRegistryFixture } from './npm-registry-fixture.js';

const POSIX = process.platform === 'linux' || process.platform === 'darwin';
const ROOT = process.geteuid?.() === 0;
const NOBODY = 65534;
const REFUSED = /^(ENOTDIR|ELOOP|UNSAFE_PATH)$/u;

const worlds: string[] = [];
const mounts: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  enableDefaultSharedStore(false);
  forgetBases();
  for (const mount of mounts.splice(0))
    execFileSync('umount', [mount], { stdio: 'ignore' });
  for (const world of worlds.splice(0))
    await rm(world, { recursive: true, force: true });
});

async function world(): Promise<string> {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'opm-fences-'));
  worlds.push(dir);
  vi.stubEnv('OPM_STORE_HOME', '');
  return dir;
}

const registry = () =>
  new NpmRegistryFixture([
    {
      name: 'tool',
      versions: {
        '1.0.0': {
          bin: { 'tool-cli': 'cli.js' },
          files: { 'cli.js': '#!/usr/bin/env node\n' },
        },
      },
    },
  ]);

describe.runIf(POSIX && ROOT)('a store root a link appears at', () => {
  /**
   * The race of a store root in a directory anyone may write to: another user
   * puts `opm-store -> <victim>` there at the first moment opm touches the
   * name, whether that is a look (`lstat`) or the `mkdir`, made deterministic
   * by intercepting both.
   */
  function racing(store: string, victim: string): () => void {
    const promises = fs.promises;
    const { lstat, mkdir: makeDirectory } = promises;
    let planted = false;
    const plant = () => {
      if (planted) return;
      planted = true;
      fs.symlinkSync(victim, store);
      fs.lchownSync(store, NOBODY, NOBODY);
    };
    const named = (path: unknown) => String(path).endsWith('/opm-store');
    promises.lstat = (async (...args: Parameters<typeof lstat>) => {
      if (!named(args[0]) || planted) return lstat(...args);
      try {
        return await lstat(...args);
      } finally {
        plant();
      }
    }) as typeof lstat;
    promises.mkdir = (async (...args: Parameters<typeof makeDirectory>) => {
      if (named(args[0])) plant();
      return makeDirectory(...args);
    }) as typeof makeDirectory;
    syncBuiltinESMExports();
    return () => {
      promises.lstat = lstat;
      promises.mkdir = makeDirectory;
      syncBuiltinESMExports();
    };
  }

  it('is refused, and no base: nothing of the store lands where the link points', async () => {
    const base = await world();
    const shared = join(base, 'shared');
    await mkdir(shared);
    await chmod(shared, 0o1777);
    const victim = join(base, 'victim-private');
    await mkdir(victim, { mode: 0o700 });
    const store = join(shared, 'opm-store');

    const restore = racing(store, victim);
    try {
      await expect(
        usableSharedRoot(join(base, 'project'), { OPM_STORE_HOME: store }),
      ).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
    } finally {
      restore();
    }
    await expect(
      ensureStableDirectory(join(store, 'sha256-entry')),
    ).rejects.toMatchObject({ code: expect.stringMatching(REFUSED) });
    expect(await readdir(victim)).toEqual([]);
  });
});

describe.runIf(POSIX)('a tool cache', () => {
  it('that others may write to is refused, and nothing is put in it', async () => {
    const base = await world();
    const cacheRoot = join(base, 'shared-cache');
    await mkdir(cacheRoot);
    await chmod(cacheRoot, 0o777);

    await expect(
      fetchTool({
        purl: 'pkg:npm/tool@1.0.0',
        cacheRoot,
        registryOptions: { transport: registry() },
      }),
    ).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
    expect(await readdir(cacheRoot)).toEqual([]);
  });
});
