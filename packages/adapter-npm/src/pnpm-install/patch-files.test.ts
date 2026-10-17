/**
 * A pnpm lock's `patchedDependencies` held to the project's patch files, as
 * `pnpm install --frozen-lockfile` holds them (ADR 0056): the hash of either
 * pnpm, the path, the keys; and what opm refuses that pnpm would read.
 */

import { symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { worldOf, type Tweaks } from './frozen-support.js';
import {
  hashes,
  PATCH_FILE,
  PATCH_TEXT,
  patchedLock,
  writeBelow,
} from './patch-support.js';

const declared = (
  paths: Record<string, string> = { 'a@1.0.0': PATCH_FILE },
) => ({
  root: { pnpm: { patchedDependencies: paths } },
});

async function worldWith(
  lock: string,
  tweaks: Tweaks = declared(),
  /** The patch file's text; null for no file. */
  file: string | null = PATCH_TEXT,
) {
  const world = await worldOf(lock, tweaks);
  if (file !== null) await writeBelow(world.project.root, PATCH_FILE, file);
  return world;
}

describe('a patched pnpm lock, read for a frozen install', () => {
  it("gives the patched package its patch, read once, with pnpm 10's hash or pnpm 9's", async () => {
    const { pnpm10, pnpm9 } = hashes();
    for (const hash of [pnpm10, pnpm9]) {
      const read = await (await worldWith(patchedLock(hash))).read();
      expect(read.refused).toEqual([]);
      const a = read.packages.find((item) => item.packageName === 'a')!;
      const b = read.packages.find((item) => item.packageName === 'b')!;
      expect(a.patch).toEqual({
        key: 'a@1.0.0',
        file: PATCH_FILE,
        hash,
        digest: pnpm10,
        text: PATCH_TEXT,
      });
      expect(b.patch).toBeUndefined();
    }
  });

  it('takes the patches from pnpm-workspace.yaml when package.json names none', async () => {
    const read = await (
      await worldWith(patchedLock(hashes().pnpm10), {
        workspaceYaml: `patchedDependencies:\n  a@1.0.0: ${PATCH_FILE}\n`,
      })
    ).read();
    expect(
      read.packages.find((item) => item.packageName === 'a')!.patch,
    ).toMatchObject({ file: PATCH_FILE });
  });

  it('reads a CRLF checkout of the patch as the lock hashed it', async () => {
    const crlf = PATCH_TEXT.replace(/\n/gu, '\r\n');
    const read = await (
      await worldWith(patchedLock(hashes().pnpm9), declared(), crlf)
    ).read();
    expect(
      read.packages.find((item) => item.packageName === 'a')!.patch,
    ).toMatchObject({ text: crlf, digest: hashes().pnpm10 });
  });

  it('refuses a patch file that is not there (NOT_FOUND), as pnpm cannot install either', async () => {
    const world = await worldWith(
      patchedLock(hashes().pnpm10),
      declared(),
      null,
    );
    await expect(world.read()).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: expect.stringContaining(
        'the patch file "patches/a@1.0.0.patch" does not exist',
      ),
    });
  });

  it('refuses a patch file edited since the lock was written, as a stale lock', async () => {
    for (const hash of [hashes().pnpm10, hashes().pnpm9]) {
      const world = await worldWith(
        patchedLock(hash),
        declared(),
        PATCH_TEXT.replace('patched', 'edited'),
      );
      await expect(world.read()).rejects.toMatchObject({
        code: 'INVALID_LOCKFILE',
        message: expect.stringMatching(
          /pnpm install --frozen-lockfile would refuse too\): the patch file "patches\/a@1\.0\.0\.patch" for "a@1\.0\.0" has changed: it hashes to "[0-9a-z]+" and pnpm-lock\.yaml records "[0-9a-z]+"/u,
        ),
      });
    }
  });

  it('refuses a lock whose patches are not the keys or paths the project declares', async () => {
    const hash = hashes().pnpm10;
    const unrecorded = await worldWith(patchedLock(hash), {
      root: {
        pnpm: {
          patchedDependencies: { 'a@1.0.0': PATCH_FILE, 'a@2.0.0': PATCH_FILE },
        },
      },
    });
    await expect(unrecorded.read()).rejects.toThrow(
      'the project declares a patch for "a@2.0.0" ("patches/a@1.0.0.patch") and pnpm-lock.yaml records none',
    );
    const undeclared = await worldWith(patchedLock(hash), {});
    await expect(undeclared.read()).rejects.toThrow(
      'pnpm-lock.yaml records a patch for "a@1.0.0", which the project does not declare',
    );
    const moved = await worldWith(
      patchedLock(hash),
      declared({ 'a@1.0.0': `./${PATCH_FILE}` }),
    );
    await expect(moved.read()).resolves.toMatchObject({ refused: [] });
    await writeBelow(moved.project.root, 'other/a.patch', PATCH_TEXT);
    const elsewhere = await worldWith(
      patchedLock(hash),
      declared({ 'a@1.0.0': 'other/a.patch' }),
    );
    await writeBelow(elsewhere.project.root, 'other/a.patch', PATCH_TEXT);
    await expect(elsewhere.read()).rejects.toThrow(
      'the patch for "a@1.0.0" is "other/a.patch" in the project and "patches/a@1.0.0.patch" in pnpm-lock.yaml',
    );
  });

  it('refuses a patch path that leaves the project (UNSAFE_PATH)', async () => {
    for (const path of [
      '../a.patch',
      '/etc/a.patch',
      'patches/../../a.patch',
    ]) {
      const world = await worldWith(
        patchedLock(hashes().pnpm10),
        declared({ 'a@1.0.0': path }),
      );
      await expect(world.read()).rejects.toMatchObject({
        code: 'UNSAFE_PATH',
        message: expect.stringContaining(
          `package.json pnpm.patchedDependencies["a@1.0.0"] is ${JSON.stringify(path)}`,
        ),
      });
    }
  });

  it('refuses a patch file reached through a link, which could point out of the project', async () => {
    const outside = await worldOf(patchedLock(hashes().pnpm10));
    await writeBelow(outside.project.root, 'elsewhere/a.patch', PATCH_TEXT);
    const linkedFile = await worldWith(
      patchedLock(hashes().pnpm10),
      declared(),
      null,
    );
    await writeBelow(linkedFile.project.root, 'patches/.keep', '');
    await symlink(
      join(outside.project.root, 'elsewhere/a.patch'),
      join(linkedFile.project.root, PATCH_FILE),
    );
    await expect(linkedFile.read()).rejects.toMatchObject({
      code: 'UNSAFE_PATH',
    });
    const linkedDirectory = await worldWith(
      patchedLock(hashes().pnpm10),
      declared({ 'a@1.0.0': 'linked/a.patch' }),
      null,
    );
    await symlink(
      join(outside.project.root, 'elsewhere'),
      join(linkedDirectory.project.root, 'linked'),
    );
    await expect(linkedDirectory.read()).rejects.toMatchObject({
      code: 'UNSAFE_PATH',
    });
  });

  it('refuses a patch that names a path outside its package, and one pnpm cannot read', async () => {
    const escape = PATCH_TEXT.replaceAll('index.js', '../../escape.js');
    const outside = await worldWith(
      patchedLock(hashes(escape).pnpm10),
      declared(),
      escape,
    );
    await expect(outside.read()).rejects.toMatchObject({
      code: 'UNSAFE_PATH',
      message: expect.stringContaining(
        'names the path "../../escape.js", which leaves the package',
      ),
    });
    const broken = PATCH_TEXT.replace('@@ -1 +1 @@', '@@ -x +1 @@');
    const unreadable = await worldWith(
      patchedLock(hashes(broken).pnpm10),
      declared(),
      broken,
    );
    await expect(unreadable.read()).rejects.toMatchObject({
      code: 'INVALID_PATCH',
      message: expect.stringContaining('ERR_PNPM_INVALID_PATCH'),
    });
  });
});
