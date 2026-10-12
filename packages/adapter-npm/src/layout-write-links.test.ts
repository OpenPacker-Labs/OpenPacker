import {
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  writeFile,
  symlink,
} from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { removeTree } from '@openpacker/project-io';
import { LAYOUT_RECORD } from './layout-write.js';
import {
  MEMBER,
  SCOPED,
  cleanup,
  project,
} from './layout-write-links-support.js';

afterEach(cleanup);

describe('writeNodeModules with workspace links', () => {
  it('leaves a link beside the packages, and Node resolves it to the member live', async () => {
    const p = await project();
    const dep = await p.store('dep');

    const outcome = await p.write([dep], [MEMBER]);

    expect(outcome.memberLinks).toEqual({
      declared: 1,
      created: 1,
      unchanged: 0,
      removed: 0,
    });
    expect((await lstat(join(p.modules, 'member'))).isSymbolicLink()).toBe(
      true,
    );
    // A junction (Windows) holds an absolute path, so the text is only read
    // back as written where links are relative.
    if (process.platform !== 'win32')
      expect(await readlink(join(p.modules, 'member'))).toBe(
        '../packages/member',
      );
    expect(p.run("console.log(require('member'), require('dep'))")).toBe(
      'one dep',
    );
    // The member is the live source: an edit shows through the link at once.
    await writeFile(join(p.member, 'index.js'), "module.exports = 'two';\n");
    expect(p.run("console.log(require('member'))")).toBe('two');
  });

  it('records the links, and says nothing of them when there are none', async () => {
    const p = await project();

    await p.write([await p.store('dep')], []);
    expect(await p.record()).toEqual({
      layoutVersion: 1,
      packages: ['dep'],
      bins: [],
    });

    await p.write([await p.store('dep')], [SCOPED, MEMBER]);
    expect(await p.record()).toEqual({
      layoutVersion: 1,
      packages: ['dep'],
      bins: [],
      links: [SCOPED, MEMBER],
    });
  });

  it('changes nothing when the same links are written again', async () => {
    const p = await project();
    const entries = [await p.store('dep')];
    await p.write(entries, [MEMBER, SCOPED]);
    const before = await Promise.all(
      ['member', join('@scope', 'scoped')].map((name) =>
        lstat(join(p.modules, name), { bigint: true }),
      ),
    );

    const outcome = await p.write(entries, [MEMBER, SCOPED]);

    expect(outcome.memberLinks).toEqual({
      declared: 2,
      created: 0,
      unchanged: 2,
      removed: 0,
    });
    const after = await Promise.all(
      ['member', join('@scope', 'scoped')].map((name) =>
        lstat(join(p.modules, name), { bigint: true }),
      ),
    );
    expect(after.map((info) => [info.dev, info.ino, info.mtimeNs])).toEqual(
      before.map((info) => [info.dev, info.ino, info.mtimeNs]),
    );
  });

  it('writes a link when there are no packages at all', async () => {
    const p = await project();

    await p.write([], [MEMBER]);

    expect(p.run("console.log(require('member'))")).toBe('one');
    expect(await p.record()).toMatchObject({ packages: [], links: [MEMBER] });
  });

  it('removes a link that is no longer wanted without touching the member, and the emptied scope with it', async () => {
    const p = await project();
    const entries = [await p.store('dep')];
    await p.write(entries, [MEMBER, SCOPED]);

    const outcome = await p.write(entries, [MEMBER]);

    expect(outcome.memberLinks).toMatchObject({ removed: 1, unchanged: 1 });
    expect((await readdir(p.modules)).sort()).toEqual(
      [LAYOUT_RECORD, 'dep', 'member'].sort(),
    );
    expect(await readFile(join(p.member, 'index.js'), 'utf8')).toBe(
      "module.exports = 'one';\n",
    );
    expect(await p.record()).toMatchObject({ links: [MEMBER] });
  });

  it('removes the last link, and the record stops listing links', async () => {
    const p = await project();
    await p.write([await p.store('dep')], [MEMBER]);

    await p.write([await p.store('dep')], []);

    await expect(lstat(join(p.modules, 'member'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await p.record()).toEqual({
      layoutVersion: 1,
      packages: ['dep'],
      bins: [],
    });
  });

  it('moves a link to a new target: the old one is removed and the new one made', async () => {
    const p = await project();
    await mkdir(join(p.root, 'packages', 'moved'));
    await p.write([], [MEMBER]);

    const outcome = await p.write(
      [],
      [{ path: MEMBER.path, target: '../packages/moved' }],
    );

    expect(outcome.memberLinks).toMatchObject({ created: 1, removed: 1 });
    expect(await realpath(join(p.modules, 'member'))).toBe(
      await realpath(join(p.root, 'packages', 'moved')),
    );
  });

  it('puts a link in the node_modules of a package it installs', async () => {
    const p = await project();
    const host = await p.store('host');

    await p.write(
      [host],
      [
        {
          path: 'node_modules/host/node_modules/member',
          target: '../../../packages/member',
        },
      ],
    );

    expect(
      await realpath(join(p.modules, 'host', 'node_modules', 'member')),
    ).toBe(await realpath(p.member));
  });

  it('refuses a name that holds something that is not a link, and leaves it', async () => {
    const p = await project();
    await mkdir(join(p.modules, 'member'), { recursive: true });
    await writeFile(join(p.modules, 'member', 'mine'), 'precious');

    await expect(p.write([], [MEMBER])).rejects.toMatchObject({
      code: 'LINK_CONFLICT',
      path: 'node_modules/member',
    });

    expect(await readFile(join(p.modules, 'member', 'mine'), 'utf8')).toBe(
      'precious',
    );
  });

  it('records a link before it makes it, so a link made before a later one fails is not left behind', async () => {
    const p = await project();
    await mkdir(join(p.modules, 'z-taken'), { recursive: true });
    await writeFile(join(p.modules, 'z-taken', 'mine'), 'precious');
    const first = {
      path: 'node_modules/a-first',
      target: '../packages/member',
    };
    const second = {
      path: 'node_modules/z-taken',
      target: '../packages/member',
    };

    await expect(p.write([], [first, second])).rejects.toMatchObject({
      code: 'LINK_CONFLICT',
      path: 'node_modules/z-taken',
    });

    expect(
      (await lstat(join(p.modules, 'a-first'))).isSymbolicLink(),
      'node_modules/a-first, made before node_modules/z-taken was refused',
    ).toBe(true);
    expect(
      (await p.record()).links,
      'links in .opm-layout.json after the write that stopped at the second link',
    ).toEqual([first, second]);

    // The next layout, which wants no links, takes away what the failed one made.
    const outcome = await p.write([], []);

    await expect(
      lstat(join(p.modules, 'a-first')),
      'node_modules/a-first after a layout that wants no links',
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(p.modules, 'z-taken', 'mine'), 'utf8')).toBe(
      'precious',
    );
    expect(outcome.memberLinks.removed).toBe(1);
    expect(outcome.skipped.map((entry) => entry.path)).toEqual([
      join(p.modules, 'z-taken'),
    ]);
  });

  it('refuses a link somebody else made to another place, and leaves it', async () => {
    const p = await project();
    await mkdir(join(p.root, 'elsewhere'));
    await mkdir(p.modules, { recursive: true });
    await symlink(
      join(p.root, 'elsewhere'),
      join(p.modules, 'member'),
      'junction',
    );

    await expect(p.write([], [MEMBER])).rejects.toMatchObject({
      code: 'LINK_CONFLICT',
    });

    expect((await lstat(join(p.modules, 'member'))).isSymbolicLink()).toBe(
      true,
    );
  });

  it('leaves a link of somebody else alone when it is not in the layout or its record', async () => {
    const p = await project();
    await mkdir(p.modules, { recursive: true });
    await symlink(p.member, join(p.modules, 'npm-linked'), 'junction');

    await p.write([await p.store('dep')], [MEMBER]);

    expect((await lstat(join(p.modules, 'npm-linked'))).isSymbolicLink()).toBe(
      true,
    );
  });

  it('replaces a package it wrote earlier with a link of that name', async () => {
    const p = await project();
    await p.write([await p.store('member')], []);
    expect(await readFile(join(p.modules, 'member', 'index.js'), 'utf8')).toBe(
      'module.exports = "member";\n',
    );

    await p.write([], [MEMBER]);

    expect((await lstat(join(p.modules, 'member'))).isSymbolicLink()).toBe(
      true,
    );
    expect(await p.record()).toMatchObject({ packages: [], links: [MEMBER] });
  });

  it('replaces a link it wrote earlier with a package of that name, without following it', async () => {
    const p = await project();
    await p.write([], [MEMBER]);
    await writeFile(join(p.member, 'sentinel'), 'keep');

    const outcome = await p.write([await p.store('member')], []);

    expect((await lstat(join(p.modules, 'member'))).isDirectory()).toBe(true);
    expect(await readFile(join(p.modules, 'member', 'index.js'), 'utf8')).toBe(
      'module.exports = "member";\n',
    );
    expect(await readFile(join(p.member, 'sentinel'), 'utf8')).toBe('keep');
    expect(await readFile(join(p.member, 'index.js'), 'utf8')).toBe(
      "module.exports = 'one';\n",
    );
    expect(outcome.skipped).toEqual([]);
    expect(await p.record()).toEqual({
      layoutVersion: 1,
      packages: ['member'],
      bins: [],
    });
  });

  it('keeps a recorded link that has since become a directory, and says so', async () => {
    const p = await project();
    await p.write([], [MEMBER]);
    await rm(join(p.modules, 'member'), { recursive: true, force: true });
    await mkdir(join(p.modules, 'member'));
    await writeFile(join(p.modules, 'member', 'mine'), 'precious');

    const outcome = await p.write([], []);

    expect(outcome.memberLinks.removed).toBe(0);
    expect(outcome.skipped).toEqual([
      {
        path: join(p.modules, 'member'),
        reason:
          'node_modules/member is no longer the link opm wrote (../packages/member), so it is left as it is',
      },
    ]);
    expect(await readFile(join(p.modules, 'member', 'mine'), 'utf8')).toBe(
      'precious',
    );
  });

  it('survives the whole node_modules being removed, as opm ci does, and written again', async () => {
    const p = await project();
    await p.write([await p.store('dep')], [MEMBER]);

    await removeTree(p.modules);

    await expect(lstat(p.modules)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(p.member, 'index.js'), 'utf8')).toBe(
      "module.exports = 'one';\n",
    );
    await p.write([await p.store('dep')], [MEMBER]);
    expect(p.run("console.log(require('member'))")).toBe('one');
  });
});
