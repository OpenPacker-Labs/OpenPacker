/**
 * Where `symlinkChild` lets a link point, beyond the text of its target: the
 * same walk of the nearest existing prefix `placeMemberLink` relies on
 * (`member-link.prefix.test.ts` has the path-based cases), asked of the handle
 * API directly, so that a caller of `symlinkChild` cannot make a link the
 * path-based API would have refused.
 *
 * `handle-link.libc-at.test.ts` runs this file again through libc bound to
 * glibc; the macOS and Windows legs run it against libSystem and NT.
 */

import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readlinkChild, symlinkChild } from './handle-link.js';
import {
  MEMBER,
  cleanup,
  failure,
  project,
  remember,
} from './handle-link-support.js';

afterEach(cleanup);

async function outsideTheProject(root: string) {
  const outside = await mkdtemp(
    join(dirname(root), `${basename(root)}-outside-`),
  );
  remember(outside);
  await mkdir(join(outside, 'pkg'));
  return outside;
}

describe('symlinkChild and the target it points through', () => {
  it('refuses a target through a directory that is a link out of the project, and makes nothing', async () => {
    const p = await project();
    const outside = await outsideTheProject(p.root);
    await rm(join(p.root, 'packages'), { recursive: true });
    await symlink(outside, join(p.root, 'packages'), 'junction');

    const refusal = await failure(() =>
      symlinkChild(p.modules, 'pkg', MEMBER, p.site),
    );

    expect(
      refusal,
      'symlinkChild(node_modules, pkg, ../packages/pkg) with packages a link to a directory outside the project',
    ).toMatchObject({
      code: 'UNSAFE_PATH',
      path: 'node_modules/pkg',
    });
    expect(refusal?.message).toContain('packages');
    await expect(lstat(p.link('pkg'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await readdir(outside)).toEqual(['pkg']);
  });

  it('refuses it for a link in a scope directory, resolving the target from there', async () => {
    const p = await project();
    const outside = await outsideTheProject(p.root);
    await rm(join(p.root, 'packages'), { recursive: true });
    await symlink(outside, join(p.root, 'packages'), 'junction');

    expect(
      await failure(() =>
        symlinkChild(p.scope, 'pkg', '../../packages/pkg', p.scopeSite),
      ),
      'symlinkChild(node_modules/@scope, pkg, ../../packages/pkg) with packages a link',
    ).toMatchObject({ code: 'UNSAFE_PATH' });
  });

  it('checks again over a link that is already there', async () => {
    const p = await project();
    expect(await symlinkChild(p.modules, 'pkg', MEMBER, p.site)).toBe(
      'created',
    );
    const outside = await outsideTheProject(p.root);
    await rename(join(p.root, 'packages'), join(p.root, 'packages-real'));
    await symlink(outside, join(p.root, 'packages'), 'junction');

    expect(
      await failure(() => symlinkChild(p.modules, 'pkg', MEMBER, p.site)),
      'symlinkChild(node_modules, pkg, ../packages/pkg) over its own link after packages became a link outside the project',
    ).toMatchObject({ code: 'UNSAFE_PATH' });
    expect(await readlinkChild(p.modules, 'pkg', p.site)).toBe(MEMBER);
  });

  it('allows a target that does not exist yet, and one blocked by a file', async () => {
    const p = await project();
    await writeFile(join(p.root, 'blocker'), 'a file');

    expect(
      await symlinkChild(p.modules, 'ghost', '../packages/ghost', p.site),
    ).toBe('created');
    expect(
      await symlinkChild(p.modules, 'blocked', '../blocker/inside', p.site),
    ).toBe('created');
  });
});
