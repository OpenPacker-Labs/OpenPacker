/**
 * The renames, links and removals in a project or a store that still acted by
 * path once their base was taken (ADR 0034, "What this guarantees"), each
 * with a directory swapped for a link, or its base retargeted, at the moment
 * it acts: the links an approved install script leaves made hard links, a
 * patched entry published, `opm gc --shared` moving a record or an entry
 * aside, and the scratch directory a tool's run is laid out in. Each acted
 * where the link pointed; now each acts where its directory was opened, or is
 * refused, and what the link points at is left as it was.
 *
 * The moment is the system call itself: the swap runs just before the first
 * `link` or `rename` of `node:fs/promises` whose target matches, which opm
 * makes by path before and through a directory's handle
 * (`/proc/self/fd/N/<name>`) now.
 */

import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { cpSync, renameSync, symlinkSync, unlinkSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { forgetBases } from '@openpacker/project-io';
import { linksToFiles } from '../src/frozen-builds.js';
import { patchArchives } from '../src/frozen-patch.js';
import { layOutTool } from '../src/ephemeral-layout.js';
import { makeScratch } from '../src/run-scratch.js';
import { collectSharedStoreWith } from '../src/shared-store-gc.js';
import { openToolCache, usableSharedRoot } from '../src/shared-store-root.js';
import { DIGEST, PATCH } from './frozen-patch-fixture.js';

const POSIX = process.platform === 'linux' || process.platform === 'darwin';
const REFUSED = /^(ENOTDIR|ELOOP|UNSAFE_PATH|INPUT_CHANGED)$/u;
const KEY = `sha256-${'a'.repeat(64)}`;

const worlds: string[] = [];
const restores: (() => void)[] = [];
afterEach(async () => {
  for (const restore of restores.splice(0)) restore();
  vi.unstubAllEnvs();
  forgetBases();
  for (const world of worlds.splice(0))
    await rm(world, { recursive: true, force: true });
});

async function world(): Promise<string> {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'opm-handles-'));
  worlds.push(dir);
  vi.stubEnv('OPM_STORE_HOME', '');
  return dir;
}

/** `link` and `rename` of `node:fs/promises`, as this test replaces them. */
type Promises = Record<'link' | 'rename', (...args: string[]) => Promise<void>>;

/**
 * Run `swap` once, just before the first call of `name` in `node:fs/promises`
 * whose target (its second argument) `matches`, by whatever path or handle
 * the caller names it.
 */
function swapBefore(
  name: 'link' | 'rename',
  matches: (target: string) => boolean,
  swap: (args: string[]) => void,
): void {
  const promises = createRequire(import.meta.url)(
    'node:fs/promises',
  ) as Promises;
  const real = promises[name];
  let swapped = false;
  promises[name] = (...args: string[]) => {
    if (!swapped && matches(String(args[1]))) {
      swapped = true;
      swap(args.map(String));
    }
    return real(...args);
  };
  syncBuiltinESMExports();
  restores.push(() => {
    promises[name] = real;
    syncBuiltinESMExports();
  });
}

/** Everything below `dir`, sorted, with each file's text: what a test compares before and after. */
async function contents(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const name of (await readdir(dir, { recursive: true })).sort()) {
    const info = await stat(join(dir, name));
    found.push(
      info.isFile()
        ? `${name}=${await readFile(join(dir, name), 'utf8')}`
        : `${name}/`,
    );
  }
  return found;
}

/**
 * A store root at `<base>/link/store`, `link` a link of the person's to
 * `<base>/real`, taken as the shared store; and `<base>/other/store`, where
 * the link is pointed while the store is in use, holding `files`.
 */
async function retargetableStore(
  base: string,
  files: (store: string) => Promise<void>,
) {
  await mkdir(join(base, 'real', 'store'), { recursive: true, mode: 0o700 });
  await mkdir(join(base, 'other', 'store'), { recursive: true, mode: 0o700 });
  await files(join(base, 'real', 'store'));
  await files(join(base, 'other', 'store'));
  await symlink(join(base, 'real'), join(base, 'link'));
  const root = join(base, 'link', 'store');
  await usableSharedRoot(root, { OPM_STORE_HOME: root });
  const retarget = async () => {
    await unlink(join(base, 'link'));
    await symlink(join(base, 'other'), join(base, 'link'));
  };
  const retargetNow = () => {
    unlinkSync(join(base, 'link'));
    symlinkSync(join(base, 'other'), join(base, 'link'));
  };
  return {
    root,
    real: join(base, 'real', 'store'),
    other: join(base, 'other', 'store'),
    retarget,
    retargetNow,
  };
}

describe.runIf(POSIX)(
  'a link swapped in where opm renamed, linked or removed by path',
  () => {
    it('acts where the package was opened when a directory of it is swapped for a link as the hard link is made', async () => {
      const base = await world();
      const pkg = join(base, 'project', 'node_modules', 'pkg');
      await mkdir(join(pkg, 'lib'), { recursive: true });
      await writeFile(join(pkg, 'lib', 'b.js'), 'b');
      await symlink('b.js', join(pkg, 'lib', 'a.js'));
      const outside = join(base, 'outside', 'lib');
      await mkdir(outside, { recursive: true });
      await writeFile(join(outside, 'a.js'), 'theirs');
      await writeFile(join(outside, 'b.js'), 'theirs too');
      const before = await contents(join(base, 'outside'));
      swapBefore(
        'link',
        (target) => target.includes('.opm-link'),
        () => {
          renameSync(join(pkg, 'lib'), join(pkg, 'lib.moved'));
          symlinkSync(outside, join(pkg, 'lib'));
        },
      );

      await linksToFiles(pkg, 'pkg@1.0.0').catch(() => undefined);
      expect(await contents(join(base, 'outside'))).toEqual(before);
      expect((await stat(join(outside, 'b.js'))).nlink).toBe(1);
    });

    it('makes each link a script left, a chain of them included, a hard link through the handles', async () => {
      const base = await world();
      const pkg = join(base, 'project', 'node_modules', 'pkg');
      await mkdir(join(pkg, 'lib'), { recursive: true });
      await writeFile(join(pkg, 'lib', 'libx.so.1.2'), 'x');
      await symlink('libx.so.1.2', join(pkg, 'lib', 'libx.so.1'));
      await symlink('lib/libx.so.1', join(pkg, 'libx.so'));

      await linksToFiles(pkg, 'pkg@1.0.0');
      const real = await stat(join(pkg, 'lib', 'libx.so.1.2'));
      for (const name of [join('lib', 'libx.so.1'), 'libx.so']) {
        const info = await stat(join(pkg, name));
        expect([info.isFile(), info.ino]).toEqual([true, real.ino]);
      }
      expect(real.nlink).toBe(3);
    });

    it('publishes a patched entry in no store root but the one it opened when the root is retargeted as it is renamed into place', async () => {
      const base = await world();
      const { root, real, other, retargetNow } = await retargetableStore(
        base,
        async (store) => {
          await mkdir(join(store, KEY, 'package'), { recursive: true });
          await writeFile(
            join(store, KEY, 'package', 'index.js'),
            'original\n',
          );
        },
      );
      const patched = `${KEY}-patch-${PATCH.digest}`;
      swapBefore(
        'rename',
        (target) => target.endsWith(patched),
        (args) => {
          // What the move would find there, had it followed the link again.
          const made = basename(args[0]!);
          cpSync(join(real, made), join(other, made), { recursive: true });
          retargetNow();
        },
      );

      await expect(
        patchArchives({
          lock: {
            packages: [
              {
                path: 'node_modules/x',
                packageName: 'x',
                version: '1.0.0',
                patch: PATCH,
              },
            ],
          },
          byPath: new Map([
            [
              'node_modules/x',
              {
                path: join(root, KEY),
                digest: DIGEST,
                fetchedBytes: 0,
                fetched: false,
              },
            ],
          ]),
          storeRoot: root,
          shared: true,
          recordWaitMs: 0,
          format: { applyFrozenPatch: async () => undefined },
        }),
      ).rejects.toMatchObject({ code: expect.stringMatching(REFUSED) });
      expect(await readdir(other)).not.toContain(patched);
    });

    it('is refused where opm gc --shared moves an old record aside once the store root leads elsewhere, and the record there stays', async () => {
      const base = await world();
      const old = new Date(Date.now() - 3_600_000);
      const { root, other, retarget } = await retargetableStore(
        base,
        async (store) => {
          await writeFile(
            join(store, `${KEY}.tree`),
            `sha256:${'c'.repeat(64)}\n`,
          );
          await utimes(join(store, `${KEY}.tree`), old, old);
        },
      );
      const before = await contents(other);

      await collectSharedStoreWith(
        {
          env: { OPM_STORE_HOME: root },
          minimumAgeMs: 0,
          now: () => Date.now() + 60_000,
        },
        { orphan: { judged: retarget } },
      ).catch((error: unknown) => {
        expect(error).toMatchObject({ code: expect.stringMatching(REFUSED) });
      });
      expect(await contents(other)).toEqual(before);
    });

    it('unpublishes no entry but the one in the store root it opened when the root is retargeted as the entry is moved aside', async () => {
      const base = await world();
      const { root, other, retargetNow } = await retargetableStore(
        base,
        async (store) => {
          await mkdir(join(store, KEY, 'package'), { recursive: true });
          await writeFile(join(store, KEY, 'package', 'index.js'), 'x');
          await writeFile(
            join(store, `${KEY}.tree`),
            `sha256:${'c'.repeat(64)}\n`,
          );
        },
      );
      const before = await contents(other);
      swapBefore(
        'rename',
        (target) => target.includes('.collect-'),
        retargetNow,
      );

      await collectSharedStoreWith(
        {
          env: { OPM_STORE_HOME: root },
          minimumAgeMs: 0,
          now: () => Date.now() + 60_000,
        },
        {},
      ).catch((error: unknown) => {
        expect(error).toMatchObject({ code: expect.stringMatching(REFUSED) });
      });
      expect(await contents(other)).toEqual(before);
    });

    it('is refused where a run’s scratch directory is made, and nothing is made where it points', async () => {
      const base = await world();
      const cache = join(base, 'cache');
      await openToolCache(cache);
      const outside = join(base, 'outside');
      await mkdir(join(outside, 'runs'), { recursive: true });
      await symlink(outside, join(cache, '.opm'));

      await expect(
        makeScratch(join(cache, '.opm', 'runs'), 'run-'),
      ).rejects.toMatchObject({ code: expect.stringMatching(REFUSED) });
      expect(await readdir(join(outside, 'runs'))).toEqual([]);
    });

    it('is refused where a tool’s layout directory is made in the tool cache, and nothing is made where it points', async () => {
      const base = await world();
      const cache = join(base, 'cache');
      await openToolCache(cache);
      const outside = join(base, 'outside');
      await mkdir(outside);
      await symlink(outside, join(cache, '.opm'));
      const storePath = join(base, 'store', KEY);
      await mkdir(join(storePath, 'package'), { recursive: true });
      await writeFile(
        join(storePath, 'package', 'package.json'),
        JSON.stringify({ name: 'tool', version: '1.0.0', bin: 'cli.js' }),
      );
      await writeFile(join(storePath, 'package', 'cli.js'), '');

      await expect(
        layOutTool({
          cacheRoot: cache,
          tool: 'pkg:npm/tool@1.0.0',
          closure: [
            {
              exactPurl: 'pkg:npm/tool@1.0.0',
              digest: `sha256:${'a'.repeat(64)}`,
              size: 1,
              source: 'https://registry.npmjs.org/tool/-/tool-1.0.0.tgz',
              storePath,
            },
          ],
        }),
      ).rejects.toMatchObject({ code: expect.stringMatching(REFUSED) });
      expect(await readdir(outside, { recursive: true })).toEqual([]);
    });
  },
);
