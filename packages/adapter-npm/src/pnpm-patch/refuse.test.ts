/**
 * What opm refuses of a patch that pnpm would apply (ADR 0057): a path that
 * leaves the package, a link in the package, a directory renamed or made
 * executable. pnpm follows each of them; the oracle cannot show them, so they
 * are written here.
 */

import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyPnpmPatch,
  patchHashForm,
  patchHashLike,
  readPatchText,
} from './index.js';
import { readTree } from './tree-fixture.js';

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pnpm-patch-refuse-'));
  temps.push(dir);
  return dir;
}

const patch = (text: string) => ({
  key: 'a@1.0.0',
  file: 'patches/a.patch',
  hash: '',
  digest: '',
  text,
});

const create = (path: string) =>
  [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${path}`,
    '@@ -0,0 +1 @@',
    '+escaped',
    '',
  ].join('\n');

const modify = (path: string) =>
  [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -1 +1 @@',
    '-a',
    '+b',
    '',
  ].join('\n');

describe('a patch opm refuses although pnpm would apply it', () => {
  it.each([
    ['../outside.js', 'leaves the package'],
    ['lib/../../outside.js', 'leaves the package'],
    ['/tmp/outside.js', 'is absolute'],
    ['lib\\..\\outside.js', 'holds a backslash'],
    ['lib//x.js', 'an empty or "." segment'],
    ['./x.js', 'an empty or "." segment'],
    ['lib/\u0000x.js', 'holds a NUL character'],
  ])('names %j, which %s (UNSAFE_PATH)', (path, problem) => {
    expect(() => readPatchText(create(path), 'patches/a.patch')).toThrow(
      expect.objectContaining({
        code: 'UNSAFE_PATH',
        message: expect.stringContaining(problem),
      }),
    );
  });

  it('refuses the path a rename or a header names, not only a new file', () => {
    const rename = [
      'diff --git a/a.js b/a.js',
      'rename from a.js',
      'rename to ../a.js',
      '',
    ].join('\n');
    expect(() => readPatchText(rename, 'p')).toThrow(
      expect.objectContaining({ code: 'UNSAFE_PATH' }),
    );
    expect(() =>
      readPatchText(modify('x').replace('+++ b/x', '+++ b/../x'), 'p'),
    ).toThrow(expect.objectContaining({ code: 'UNSAFE_PATH' }));
  });

  it('writes nothing outside the package when a patch names a path that leaves it', async () => {
    const root = await scratch();
    const pkg = join(root, 'package');
    await mkdir(pkg);
    await expect(
      applyPnpmPatch(pkg, patch(create('../outside.js')), 'a@1.0.0'),
    ).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
    expect(await readTree(root)).toEqual({});
  });

  it('does not follow a link in the package, to a file or through a directory', async () => {
    const root = await scratch();
    const pkg = join(root, 'package');
    await mkdir(join(root, 'elsewhere'), { recursive: true });
    await mkdir(pkg);
    await writeFile(join(root, 'elsewhere', 'target.js'), 'a\n');
    await symlink(join(root, 'elsewhere', 'target.js'), join(pkg, 'index.js'));
    await symlink(join(root, 'elsewhere'), join(pkg, 'lib'));
    await expect(
      applyPnpmPatch(pkg, patch(modify('index.js')), 'a@1.0.0'),
    ).rejects.toMatchObject({
      code: 'UNSAFE_PATH',
      message: expect.stringContaining('is a link or not a regular file'),
    });
    await expect(
      applyPnpmPatch(pkg, patch(create('lib/new.js')), 'a@1.0.0'),
    ).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
    expect(await readFile(join(root, 'elsewhere', 'target.js'), 'utf8')).toBe(
      'a\n',
    );
    expect(await readTree(join(root, 'elsewhere'))).toEqual({
      'target.js': { text: 'a\n', executable: false },
    });
  });

  it('refuses to rename a directory or change its mode, which a git diff never does', async () => {
    const pkg = await scratch();
    await mkdir(join(pkg, 'lib'));
    await writeFile(join(pkg, 'lib', 'x.js'), 'x\n');
    await chmod(join(pkg, 'lib', 'x.js'), 0o644);
    const rename = [
      'diff --git a/lib b/src',
      'rename from lib',
      'rename to src',
      '',
    ].join('\n');
    await expect(
      applyPnpmPatch(pkg, patch(rename), 'a@1.0.0'),
    ).rejects.toMatchObject({
      code: 'PATCH_FAILED',
      message: expect.stringContaining('opm renames files only'),
    });
    const mode = [
      'diff --git a/lib b/lib',
      'old mode 100644',
      'new mode 100755',
      '',
    ].join('\n');
    await expect(
      applyPnpmPatch(pkg, patch(mode), 'a@1.0.0'),
    ).rejects.toMatchObject({ code: 'PATCH_FAILED' });
    expect(await readTree(pkg)).toEqual({
      'lib/x.js': { text: 'x\n', executable: false },
    });
  });
});

describe("the form of a lock's patch hash", () => {
  it("tells pnpm 10's sha256 from pnpm 9's md5 in base32, and neither", () => {
    const bytes = Buffer.from('x\n');
    expect(patchHashForm('a'.repeat(64))).toBe('pnpm10');
    expect(patchHashForm('wbmb7dwhiv66et2i6bbymnlkhi')).toBe('pnpm9');
    expect(patchHashForm('abc123')).toBeUndefined();
    expect(patchHashForm('A'.repeat(64))).toBeUndefined();
    expect(patchHashLike('abc123', bytes)).toBeUndefined();
    expect(patchHashLike('a'.repeat(64), bytes)).toMatch(/^[0-9a-f]{64}$/u);
    expect(patchHashLike('wbmb7dwhiv66et2i6bbymnlkhi', bytes)).toMatch(
      /^[a-z2-7]{26}$/u,
    );
  });
});
