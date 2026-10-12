/**
 * Where a member link may point, beyond the text of its target.
 *
 * `linkTargetProblem` keeps the text of a target inside the project root. That
 * is a statement about a string: if a component the target passes through
 * already exists and is itself a link, the link resolves wherever that one
 * leads. A committed `packages -> ../outside` is enough. So before a link is
 * made, or found already there, the nearest existing prefix of its target is
 * walked with the same no-follow opens the link's own directory is, and a link
 * or a reparse point on the way refuses the request. A target that does not
 * exist yet is allowed, and only the part that exists is walked.
 *
 * `member-link.libc-at.test.ts` runs this file again through libc bound to
 * glibc; the macOS and Windows legs run it against libSystem and NT.
 */

import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { placeMemberLink, readMemberLink } from './member-link.js';
import {
  MEMBER,
  cleanup,
  failure,
  project,
  remember,
} from './member-link-support.js';

afterEach(cleanup);

/** A directory beside the project that a link must never reach, holding `pkg/index.js`. */
async function outsideTheProject(root: string) {
  const outside = await mkdtemp(
    join(dirname(root), `${basename(root)}-outside-`),
  );
  remember(outside);
  await mkdir(join(outside, 'pkg'));
  await writeFile(join(outside, 'pkg', 'index.js'), 'secret');
  return outside;
}

/** `packages` becomes a link to `outside`, as a committed `packages -> ../outside` would be. */
async function packagesLinkedTo(root: string, outside: string) {
  await rm(join(root, 'packages'), { recursive: true });
  await symlink(outside, join(root, 'packages'), 'junction');
}

describe('placeMemberLink and the target it points through', () => {
  it('refuses a target whose directory is a link out of the project, and makes nothing', async () => {
    const p = await project();
    const outside = await outsideTheProject(p.root);
    await packagesLinkedTo(p.root, outside);

    const refusal = await failure(() =>
      placeMemberLink(p.root, 'node_modules/pkg', MEMBER),
    );

    expect(
      refusal,
      'placeMemberLink(node_modules/pkg -> ../packages/pkg) with packages a link to a directory outside the project',
    ).toMatchObject({ code: 'UNSAFE_PATH' });
    expect(refusal?.message).toContain('packages');
    await expect(lstat(join(p.modules, 'pkg'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await readdir(outside)).toEqual(['pkg']);
    expect(await readFile(join(outside, 'pkg', 'index.js'), 'utf8')).toBe(
      'secret',
    );
  });

  it('refuses a target whose last component is itself a link', async () => {
    const p = await project();
    const outside = await outsideTheProject(p.root);
    await rm(p.member, { recursive: true });
    await symlink(join(outside, 'pkg'), p.member, 'junction');

    const refusal = await failure(() =>
      placeMemberLink(p.root, 'node_modules/pkg', MEMBER),
    );

    expect(
      refusal,
      'placeMemberLink(node_modules/pkg -> ../packages/pkg) with packages/pkg a link outside the project',
    ).toMatchObject({ code: 'UNSAFE_PATH' });
    expect(refusal?.message).toContain('packages/pkg');
    await expect(lstat(join(p.modules, 'pkg'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('refuses it for a scoped link and for a link inside a package of its own', async () => {
    const p = await project();
    const outside = await outsideTheProject(p.root);
    await packagesLinkedTo(p.root, outside);
    await mkdir(join(p.modules, 'host', 'node_modules'), { recursive: true });

    expect(
      await failure(() =>
        placeMemberLink(
          p.root,
          'node_modules/@scope/pkg',
          '../../packages/pkg',
        ),
      ),
      'placeMemberLink(node_modules/@scope/pkg -> ../../packages/pkg) with packages a link',
    ).toMatchObject({ code: 'UNSAFE_PATH' });
    expect(
      await failure(() =>
        placeMemberLink(
          p.root,
          'node_modules/host/node_modules/pkg',
          '../../../packages/pkg',
        ),
      ),
      'placeMemberLink(node_modules/host/node_modules/pkg -> ../../../packages/pkg) with packages a link',
    ).toMatchObject({ code: 'UNSAFE_PATH' });
  });

  it('checks again when the link is already there, so a prefix swapped since is found at the next write', async () => {
    const p = await project();
    expect(await placeMemberLink(p.root, 'node_modules/pkg', MEMBER)).toBe(
      'created',
    );
    const outside = await outsideTheProject(p.root);
    await rename(join(p.root, 'packages'), join(p.root, 'packages-real'));
    await symlink(outside, join(p.root, 'packages'), 'junction');

    const refusal = await failure(() =>
      placeMemberLink(p.root, 'node_modules/pkg', MEMBER),
    );

    expect(
      refusal,
      'placeMemberLink(node_modules/pkg -> ../packages/pkg) over its own link after packages became a link outside the project',
    ).toMatchObject({ code: 'UNSAFE_PATH' });
    expect(await readMemberLink(p.root, 'node_modules/pkg')).toEqual({
      kind: 'link',
      target: MEMBER,
    });
  });

  it('allows a target that does not exist yet, however much of the way to it is missing', async () => {
    const p = await project();

    expect(
      await placeMemberLink(p.root, 'node_modules/ghost', '../packages/ghost'),
    ).toBe('created');
    expect(
      await placeMemberLink(p.root, 'node_modules/nowhere', '../no/such/dir'),
    ).toBe('created');
  });

  it('allows a target whose way is blocked by a file, which resolves to nothing', async () => {
    const p = await project();
    await rm(join(p.root, 'packages'), { recursive: true });
    await writeFile(join(p.root, 'packages'), 'not a directory');

    expect(await placeMemberLink(p.root, 'node_modules/pkg', MEMBER)).toBe(
      'created',
    );
  });

  it('allows the ordinary case: every component is a plain directory', async () => {
    const p = await project();
    await mkdir(join(p.root, 'tools', 'cli'), { recursive: true });

    expect(
      await placeMemberLink(p.root, 'node_modules/cli', '../tools/cli'),
    ).toBe('created');
    expect(await readMemberLink(p.root, 'node_modules/cli')).toEqual({
      kind: 'link',
      target: '../tools/cli',
    });
  });

  it('works from a project root that is itself reached through a link', async () => {
    const p = await project();
    const alias = join(await mkdtemp(join(tmpdir(), 'alias-')), 'project');
    remember(dirname(alias));
    await symlink(p.root, alias, 'junction');

    expect(await placeMemberLink(alias, 'node_modules/pkg', MEMBER)).toBe(
      'created',
    );
  });
});
