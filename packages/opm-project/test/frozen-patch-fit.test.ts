import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { patchedStoreKey } from '../src/frozen-patch.js';
import { patchedPackageDirectoryBytes } from '../src/frozen-patch-fit.js';
import { planFrozen } from '../src/index.js';
import {
  cleanStores,
  DIGEST,
  PATCH,
  patchedWorld,
} from './frozen-patch-fixture.js';
import { cleanup, pnpmWorld } from './frozen-pnpm-fixture.js';
import { onPosix } from './frozen-workspace-fixture.js';

afterEach(async () => {
  await cleanup();
  await cleanStores();
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

/**
 * The directory a patched package is made in is part of every path in it, and
 * a system call takes 4,095 bytes of path (ADR 0056 §13). A path of 3,900
 * bytes below a store directory of 210 passed every bound of its own and was
 * `ENAMETOOLONG` from an `lstat`, an internal error naming a store temporary.
 * `opm ci --plan` now says so before anything is fetched, from the longest
 * store directory the install could use; the install says it again with the
 * directory it really has.
 */

const temps: string[] = [];

/** A directory whose path is `bytes` bytes long, to stand for a store under a deep home. */
async function directoryOfBytes(bytes: number): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), 'opm-fit-'));
  temps.push(base);
  let dir = base;
  while (Buffer.byteLength(dir) < bytes) {
    const room = bytes - Buffer.byteLength(dir) - 1;
    dir = join(dir, 'd'.repeat(Math.max(Math.min(room, 99), 1)));
  }
  await mkdir(dir, { recursive: true });
  return dir;
}

/** A path of exactly `bytes` bytes in segments of at most 50. */
function pathOfBytes(bytes: number): string {
  let path = '';
  while (path.length < bytes) {
    const room = bytes - path.length;
    path +=
      (path === '' ? '' : '/') +
      's'.repeat(Math.min(room - (path === '' ? 0 : 1), 50));
  }
  return path;
}

const create = (path: string) =>
  [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${path}`,
    '@@ -0,0 +1 @@',
    '+x',
    '',
  ].join('\n');

/** The directory a patched package is made in, for a store at `storeBytes` bytes. */
const madeIn = (storeBytes: number) => storeBytes + 201;
const longest = (storeBytes: number) => 4_095 - madeIn(storeBytes) - 1;

describe('the directory a patched package is made in', () => {
  it('is the store, the temporary entry named by both digests and a uuid, and package/', () => {
    const key = patchedStoreKey(DIGEST, PATCH.digest);
    expect(key).toHaveLength(142);
    const dir = join('/s', `.${key}.materialize-${'0'.repeat(36)}`, 'package');
    expect(Buffer.byteLength(dir)).toBe(madeIn(2));
    expect(
      patchedPackageDirectoryBytes('/home/u/project', {
        OPM_STORE_HOME: '/s',
      }),
    ).toBeGreaterThanOrEqual(madeIn(2));
  });
});

describe.runIf(onPosix)('opm ci over a patch whose path is long', () => {
  const storeBytes = 3_500;

  async function inputs(path: string) {
    const w = await patchedWorld(create(path));
    const home = await directoryOfBytes(storeBytes);
    const env = { OPM_STORE_HOME: home };
    return { w, home, env };
  }

  it('plans and installs a path whose whole path is 4,095 bytes', async () => {
    const path = pathOfBytes(longest(storeBytes));
    const { w, home, env } = await inputs(path);
    const plan = await planFrozen({
      root: w.dir,
      env,
      now: () => '2026-10-12T12:00:00.000Z',
      target: { os: 'linux', architecture: 'x64', libc: 'glibc' },
    });
    expect(plan.patched).toEqual({ packages: 1, patches: 1 });
    const result = await w.install({ env });
    expect(result.patched).toEqual({ packages: 1, patches: 1 });
    const entry = (await readdir(home)).find(
      (name) => name.includes('-patch-') && !name.includes('.'),
    )!;
    expect((await stat(join(home, entry, 'package', path))).isFile()).toBe(
      true,
    );
  }, 120_000);

  it('refuses a path one byte longer at --plan, with the numbers, before anything is fetched or written', async () => {
    const path = pathOfBytes(longest(storeBytes) + 1);
    const { w, home, env } = await inputs(path);
    const outcome = await planFrozen({
      root: w.dir,
      env,
      now: () => '2026-10-12T12:00:00.000Z',
      target: { os: 'linux', architecture: 'x64', libc: 'glibc' },
    }).then(
      () => 'planned',
      (error: unknown) => error,
    );
    expect(outcome).toMatchObject({
      code: 'UNSAFE_PATH',
      message: expect.stringContaining(
        `the patch "patches/x.patch" (patchedDependencies "x@1.0.0") names a path that is ${longest(storeBytes) + 1} bytes long, and below the ${madeIn(storeBytes)}-byte directory it is made in comes to 4096 bytes, more than the 4095 a system call takes in a path`,
      ),
    });
    expect(String((outcome as Error).message)).toContain('OPM_STORE_HOME');
    expect(await readdir(home)).toEqual([]);
  });

  it('refuses it at install too, as a typed error and not an ENAMETOOLONG, leaving the store without a patched entry', async () => {
    const path = pathOfBytes(longest(storeBytes) + 1);
    const { w, home, env } = await inputs(path);
    const outcome = await w.install({ env }).then(
      () => 'installed',
      (error: unknown) => error,
    );
    expect(outcome).toMatchObject({ code: 'UNSAFE_PATH' });
    expect(String((outcome as Error).message)).not.toMatch(/ENAMETOOLONG/u);
    expect(
      (await readdir(home)).filter((name) => name.includes('-patch-')),
    ).toEqual([]);
  }, 120_000);
});

describe.runIf(onPosix)('opm ci --plan and the store setting', () => {
  const target = { os: 'linux', architecture: 'x64', libc: 'glibc' } as const;

  it("does not read it for a lock that patches nothing: a relative OPM_STORE_HOME is the install's to refuse, as before patches", async () => {
    const w = await pnpmWorld();
    w.pkg({ name: 'a', version: '1.0.0' });
    w.importer('.', { dependencies: { a: ['^1.0.0', '1.0.0'] } });
    await w.write();
    const plan = await planFrozen({
      root: w.dir,
      transport: w.registry,
      env: { OPM_STORE_HOME: 'relative/store' },
      target,
    });
    expect(plan).toMatchObject({ instances: 1, archives: 1 });
  });

  it('reads it for a lock that patches a package, because the answer depends on where the store is', async () => {
    const w = await patchedWorld(create('lib/new.js'));
    const outcome = await planFrozen({
      root: w.dir,
      env: { OPM_STORE_HOME: 'relative/store' },
      target,
    }).then(
      () => 'planned',
      (error: unknown) => error,
    );
    expect(outcome).toMatchObject({
      code: 'UNSAFE_PATH',
      message: expect.stringContaining(
        'OPM_STORE_HOME must be an absolute path',
      ),
    });
  });
});
