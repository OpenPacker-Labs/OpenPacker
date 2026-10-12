/**
 * What the layout writer refuses to write or to keep: links the rules do not
 * allow, a symlink in a package's store tree, a hand-edited record, and the
 * check that no placed package is an undeclared symlink.
 */

import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LayoutLinksError } from './layout-links.js';
import { LAYOUT_RECORD } from './layout-write.js';
import { assertNoUndeclaredSymlinks } from './layout-write-links.js';
import { MEMBER, cleanup, project } from './layout-write-links-support.js';

afterEach(cleanup);

describe('what the writer refuses to write', () => {
  it.each([
    [
      'a link in .bin',
      { path: 'node_modules/.bin/tool', target: '../../packages/member' },
    ],
    ['an absolute target', { path: 'node_modules/member', target: '/etc' }],
    [
      'a target that leaves the project',
      { path: 'node_modules/member', target: '../../outside' },
    ],
    [
      'a link into node_modules',
      { path: 'node_modules/member', target: '../node_modules/dep' },
    ],
    [
      'a link where a package is installed',
      { path: 'node_modules/dep', target: '../packages/member' },
    ],
  ])('writes nothing at all for %s', async (_label, link) => {
    const p = await project();
    const dep = await p.store('dep');

    await expect(p.write([dep], [link])).rejects.toBeInstanceOf(
      LayoutLinksError,
    );

    await expect(lstat(p.modules)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a link whose target goes through a directory that is a symlink out of the project, and makes no link', async () => {
    const p = await project();
    const outside = join(p.dir, 'outside');
    await mkdir(join(outside, 'member'), { recursive: true });
    await rm(join(p.root, 'packages'), { recursive: true });
    await symlink(outside, join(p.root, 'packages'), 'junction');

    await expect(
      p.write([], [MEMBER]),
      'writeNodeModules with packages a symlink to a directory outside the project',
    ).rejects.toMatchObject({ code: 'UNSAFE_PATH' });

    await expect(lstat(join(p.modules, 'member'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await readdir(outside)).toEqual(['member']);
  });

  it('refuses a package whose store holds a symlink, and leaves no symlink behind', async () => {
    const p = await project();
    const poisoned = await p.store('poisoned');
    await symlink(
      p.member,
      join(poisoned.storePath!, 'package', 'escape'),
      'junction',
    );

    await expect(p.write([poisoned], [MEMBER])).rejects.toMatchObject({
      code: 'UNSAFE_PATH',
    });

    const names = await readdir(p.modules).catch(() => []);
    for (const name of names)
      if (name !== 'member')
        expect((await lstat(join(p.modules, name))).isSymbolicLink()).toBe(
          false,
        );
  });

  it('refuses a package whose bin target is a symlink in the store, and writes no shim for it', async () => {
    const p = await project();
    const tool = await p.store('tool', {}, { bin: { tool: 'cli.js' } });
    await symlink(
      join(p.member, 'index.js'),
      join(tool.storePath!, 'package', 'cli.js'),
      'file',
    );

    await expect(p.write([tool], [MEMBER])).rejects.toMatchObject({
      code: 'UNSAFE_PATH',
    });

    await expect(lstat(join(p.modules, '.bin', 'tool'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('ignores an entry of a hand-edited record that is not a member link', async () => {
    const p = await project();
    await p.write([await p.store('dep')], [MEMBER]);
    const victim = join(p.root, 'victim');
    await writeFile(victim, 'precious');
    const record = await p.record();
    await writeFile(
      join(p.modules, LAYOUT_RECORD),
      JSON.stringify({
        ...record,
        links: [
          { path: 'node_modules/../victim', target: 'x' },
          { path: '../victim', target: 'x' },
          { path: 'node_modules/dep', target: '/etc' },
          { path: 5, target: 'x' },
          'node_modules/dep',
          null,
          MEMBER,
        ],
      }),
    );

    await p.write([await p.store('dep')], [MEMBER]);

    expect(await readFile(victim, 'utf8')).toBe('precious');
    expect(await readFile(join(p.modules, 'dep', 'index.js'), 'utf8')).toBe(
      'module.exports = "dep";\n',
    );
    expect(await p.record()).toMatchObject({ links: [MEMBER] });
  });
});

describe('assertNoUndeclaredSymlinks', () => {
  it('fails on a placed package that is a symlink nobody declared, and not on a declared one', async () => {
    const p = await project();
    await mkdir(p.modules, { recursive: true });
    await symlink(p.member, join(p.modules, 'sneaky'), 'junction');
    await symlink(p.member, join(p.modules, 'member'), 'junction');

    await expect(
      assertNoUndeclaredSymlinks(p.root, [{ chain: ['sneaky'] }], []),
    ).rejects.toMatchObject({
      code: 'UNSAFE_PATH',
      path: 'node_modules/sneaky',
    });
    await expect(
      assertNoUndeclaredSymlinks(p.root, [{ chain: ['member'] }], [MEMBER]),
    ).resolves.toBeUndefined();
    expect((await stat(join(p.modules, 'sneaky'))).isDirectory()).toBe(true);
  });
});
