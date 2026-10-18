/**
 * A patched package is made in a directory 120 bytes deeper than the archive's
 * entry it is copied from, and the store the system sees is the canonical one
 * (ADR 0056 §13). A package that already holds a long path, or a store behind a
 * symlink, used to meet an `ENAMETOOLONG` the check of the patch's own paths
 * could not see: a plain error, exit 9. It is a refusal now: `UNSAFE_PATH`,
 * naming the numbers, with nothing published and the temporary removed.
 */

import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanStores, publish, store } from './frozen-patch-fixture.js';
import {
  cleanLong,
  pathOfBytes,
  shortcutStore,
  symlinkedStore,
} from './frozen-patch-long-fixture.js';
import { onPosix } from './frozen-workspace-fixture.js';

afterEach(async () => {
  await cleanStores();
  await cleanLong();
});

const BASE = `sha256-${'a'.repeat(64)}`;

/** The directory a patched package is made in, for a store of `storeBytes` bytes. */
const madeIn = (storeBytes: number) => storeBytes + 201;

/** A file at `rel` below the package of the unpatched entry in `root`. */
async function baseFile(root: string, rel: string): Promise<void> {
  const file = join(root, BASE, 'package', ...rel.split('/'));
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, 'x\n');
}

/** A format that patches `package.json` only, as a patch that touches one file does. */
const touchesManifest = {
  async applyFrozenPatch(dir: string) {
    await writeFile(join(dir, 'package.json'), '{"patched":true}\n');
  },
};

const tooLong = () =>
  Object.assign(new Error('ENAMETOOLONG: name too long, lstat'), {
    code: 'ENAMETOOLONG',
  });

const outcomeOf = (run: Promise<unknown>) =>
  run.then(
    () => 'published',
    (error: unknown) => error,
  );

const leftovers = async (root: string) =>
  (await readdir(root)).filter(
    (name) => name.includes('.materialize-') || name.includes('-patch-'),
  );

describe.runIf(onPosix)('a package that already holds a long path', () => {
  it('is patched when its longest path comes to 4,095 bytes in the patched copy', async () => {
    const root = await store();
    await baseFile(root, pathOfBytes(4_094 - madeIn(Buffer.byteLength(root))));
    const made = await publish(root, touchesManifest);
    expect(made.patched).toEqual({ packages: 1, patches: 1 });
  }, 60_000);

  it('is refused as UNSAFE_PATH one byte past it, with the numbers, and leaves nothing in the store', async () => {
    const root = await store();
    const directory = madeIn(Buffer.byteLength(root));
    const past = 4_095 - directory;
    await baseFile(root, pathOfBytes(past));
    const outcome = await outcomeOf(publish(root, touchesManifest));
    expect(outcome).toMatchObject({
      code: 'UNSAFE_PATH',
      message: expect.stringContaining(
        `is ${past} bytes long, and below the ${directory}-byte directory it is made in comes to 4096 bytes, more than the 4095 a system call takes in a path`,
      ),
    });
    expect(String((outcome as Error).message)).not.toMatch(/ENAMETOOLONG/u);
    expect(await leftovers(root)).toEqual([]);
  }, 60_000);
});

describe.runIf(onPosix)(
  'a format that meets ENAMETOOLONG applying a patch',
  () => {
    it('is a refusal, UNSAFE_PATH, with the temporary removed', async () => {
      const root = await store();
      const outcome = await outcomeOf(
        publish(root, {
          async applyFrozenPatch() {
            throw tooLong();
          },
        }),
      );
      expect(outcome).toMatchObject({ code: 'UNSAFE_PATH' });
      expect(await leftovers(root)).toEqual([]);
    });
  },
);

describe.runIf(onPosix)('a store behind a symlink', () => {
  it('is counted at its canonical path: a base path that is 4,096 bytes there is refused though the string is shorter', async () => {
    const { store: root, canonical } = await symlinkedStore(408);
    const directory = madeIn(Buffer.byteLength(canonical));
    const past = 4_095 - directory;
    await baseFile(canonical, pathOfBytes(past));
    const outcome = await outcomeOf(publish(root, touchesManifest));
    expect(outcome).toMatchObject({
      code: 'UNSAFE_PATH',
      message: expect.stringContaining(
        `below the ${directory}-byte directory it is made in comes to 4096 bytes`,
      ),
    });
    expect(await leftovers(canonical)).toEqual([]);
  }, 60_000);

  it('is refused, not met as an ENAMETOOLONG from the realpath of a directory, when the base path is 100 bytes past it', async () => {
    const { store: root, canonical } = await symlinkedStore(408);
    const directory = madeIn(Buffer.byteLength(canonical));
    await baseFile(canonical, `${pathOfBytes(4_095 - directory + 100)}/f.js`);
    const outcome = await outcomeOf(publish(root, touchesManifest));
    expect(outcome).toMatchObject({ code: 'UNSAFE_PATH' });
    expect(String((outcome as Error).message)).not.toMatch(/^ENAMETOOLONG/u);
    expect(await leftovers(canonical)).toEqual([]);
  }, 60_000);

  it('is patched when the base path comes to 4,095 bytes at the canonical path', async () => {
    const { store: root, canonical } = await symlinkedStore(408);
    await baseFile(
      canonical,
      pathOfBytes(4_094 - madeIn(Buffer.byteLength(canonical))),
    );
    const made = await publish(root, touchesManifest);
    expect(made.patched).toEqual({ packages: 1, patches: 1 });
  }, 60_000);

  it('turns the ENAMETOOLONG of a tree a patch made deeper than the canonical path takes into UNSAFE_PATH', async () => {
    const { store: root, canonical } = await symlinkedStore(408);
    await baseFile(canonical, 'package.json');
    const room = 4_094 - madeIn(Buffer.byteLength(root));
    const outcome = await outcomeOf(
      publish(root, {
        async applyFrozenPatch(dir: string) {
          // Within 4,095 bytes as written, past them once the link is followed.
          const deep = join(dir, pathOfBytes(room - 40));
          await mkdir(deep, { recursive: true });
          await writeFile(join(deep, 'f.js'), 'x\n');
        },
      }),
    );
    expect(outcome).toMatchObject({ code: 'UNSAFE_PATH' });
    expect(String((outcome as Error).message)).not.toMatch(/^ENAMETOOLONG/u);
    expect(await leftovers(canonical)).toEqual([]);
  }, 60_000);
});

describe.runIf(onPosix)('the directory a format is handed to patch', () => {
  /** What `applyFrozenPatch` is called with. */
  const recording = () => {
    const seen: string[] = [];
    return {
      seen,
      format: {
        async applyFrozenPatch(dir: string) {
          seen.push(dir);
          await writeFile(join(dir, 'package.json'), '{"patched":true}\n');
        },
      },
    };
  };

  it('is in the canonical form of the store when that is longer, so the format counts the path the host works on', async () => {
    const { store: root, canonical } = await symlinkedStore(408);
    await baseFile(canonical, 'package.json');
    const { seen, format } = recording();
    await publish(root, format);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.startsWith(`${canonical}/`)).toBe(true);
    expect(seen[0]!.endsWith('/package')).toBe(true);
  });

  it('is in the form as written when that is longer', async () => {
    const { store: root, canonical } = await shortcutStore(200);
    await baseFile(canonical, 'package.json');
    const { seen, format } = recording();
    await publish(root, format);
    expect(seen[0]!.startsWith(`${root}/`)).toBe(true);
  });
});
