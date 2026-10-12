import { execFileSync } from 'node:child_process';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { NativeLockEntry } from '@openpacker/adapter-core';
import { removeTree } from '@openpacker/project-io';
import { LayoutLinksError, type LayoutLink } from './layout-links.js';
import {
  LAYOUT_RECORD,
  writeNodeModules,
  type LayoutOutcome,
} from './layout-write.js';
import { assertNoUndeclaredSymlinks } from './layout-write-links.js';

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

/** A project with a workspace member and a place to keep extracted packages. */
async function project() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'npm-links-')));
  temps.push(dir);
  const root = join(dir, 'project');
  const member = join(root, 'packages', 'member');
  await mkdir(member, { recursive: true });
  await writeFile(
    join(member, 'package.json'),
    '{"name":"member","version":"1.0.0","main":"index.js"}',
  );
  await writeFile(join(member, 'index.js'), "module.exports = 'one';\n");
  let counter = 0;
  const modules = join(root, 'node_modules');
  return {
    dir,
    root,
    member,
    modules,
    async store(
      name: string,
      files: Record<string, string> = {},
      extra: Record<string, unknown> = {},
    ): Promise<NativeLockEntry> {
      counter += 1;
      const storePath = join(dir, 'store', `sha256-${counter}`);
      const all: Record<string, string> = {
        'package.json': JSON.stringify({ name, version: '1.0.0', ...extra }),
        'index.js': `module.exports = ${JSON.stringify(name)};\n`,
        ...files,
      };
      for (const [path, contents] of Object.entries(all)) {
        const target = join(storePath, 'package', path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, contents);
      }
      return {
        purl: `pkg:npm/${name}`,
        exactPurl: `pkg:npm/${name}@1.0.0`,
        name,
        version: '1.0.0',
        scope: 'runtime',
        source: `file:${storePath}`,
        digest: `sha256:${String(counter).padStart(64, '0')}`,
        size: 1,
        storePath,
        transitive: false,
        alias: `${name}@1.0.0`,
      };
    },
    write: (
      entries: NativeLockEntry[],
      links: readonly LayoutLink[],
    ): Promise<LayoutOutcome> => writeNodeModules(root, entries, { links }),
    run(script: string): string {
      return execFileSync(process.execPath, ['-e', script], {
        cwd: root,
        encoding: 'utf8',
      }).trim();
    },
    async record(): Promise<Record<string, unknown>> {
      return JSON.parse(
        await readFile(join(modules, LAYOUT_RECORD), 'utf8'),
      ) as Record<string, unknown>;
    },
  };
}

const MEMBER: LayoutLink = {
  path: 'node_modules/member',
  target: '../packages/member',
};
const SCOPED: LayoutLink = {
  path: 'node_modules/@scope/scoped',
  target: '../../packages/member',
};

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
