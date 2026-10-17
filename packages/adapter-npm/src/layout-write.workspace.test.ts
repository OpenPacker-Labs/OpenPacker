import { execFileSync } from 'node:child_process';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  NativeLayoutMember,
  NativeLockEntry,
} from '@openpacker/adapter-core';
import { LAYOUT_RECORD, writeNodeModules } from './layout-write.js';
import { MEMBER, cleanup, project } from './layout-write-links-support.js';

afterEach(cleanup);

/** Shims are run through `sh`; the Windows leg writes `.cmd` files and does not run them here. */
const onPosix = it.skipIf(process.platform === 'win32');

const DIR = 'packages/member';
const member: NativeLayoutMember = { dir: DIR, name: 'member', bin: {} };

/** A store entry placed where a lock puts it. */
async function placed(
  p: Awaited<ReturnType<typeof project>>,
  name: string,
  at: string,
  version = '1.0.0',
  files: Record<string, string> = {},
  extra: Record<string, unknown> = {},
): Promise<NativeLockEntry> {
  const entry = await p.store(
    name,
    {
      'index.js': `module.exports = ${JSON.stringify(`${name}@${version}`)};\n`,
      ...files,
    },
    { version, ...extra },
  );
  return { ...entry, version, layoutPath: at, alias: at };
}

const write = (
  p: Awaited<ReturnType<typeof project>>,
  entries: NativeLockEntry[],
  members: readonly NativeLayoutMember[] = [member],
  links = [MEMBER],
) => writeNodeModules(p.root, entries, { links, members });

const resolveIn = (cwd: string, script: string) =>
  execFileSync(process.execPath, ['-e', script], {
    cwd,
    encoding: 'utf8',
  }).trim();

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  );
}

describe('the node_modules of a workspace member', () => {
  it('holds the versions only the member wants, and Node finds each where the lock says', async () => {
    const p = await project();
    const entries = [
      await placed(p, 'left', 'node_modules/left', '1.0.0'),
      await placed(p, 'left', `${DIR}/node_modules/left`, '0.9.0'),
      await placed(p, 'deep', `${DIR}/node_modules/left/node_modules/deep`),
    ];
    const outcome = await write(p, entries);
    expect(outcome.packages).toBe(3);
    expect(outcome.memberModules).toBe(1);
    expect(resolveIn(p.root, "console.log(require('left'))")).toBe(
      'left@1.0.0',
    );
    expect(resolveIn(p.member, "console.log(require('left'))")).toBe(
      'left@0.9.0',
    );
    expect(
      resolveIn(
        join(p.member, 'node_modules', 'left'),
        "console.log(require('deep'))",
      ),
    ).toBe('deep@1.0.0');
    // The member itself is reached through its link, and it is the only symlink.
    expect(resolveIn(p.root, "console.log(require('member'))")).toBe('one');
    expect((await lstat(join(p.modules, 'member'))).isSymbolicLink()).toBe(
      true,
    );
    for (const path of [
      join(p.member, 'node_modules', 'left'),
      join(p.member, 'node_modules', 'left', 'node_modules', 'deep'),
      join(p.modules, 'left'),
    ])
      expect((await lstat(path)).isSymbolicLink(), path).toBe(false);
  });

  it("is recorded where it is, apart from the project's", async () => {
    const p = await project();
    await write(p, [
      await placed(p, 'left', 'node_modules/left'),
      await placed(p, 'own', `${DIR}/node_modules/own`),
    ]);
    const inMember = JSON.parse(
      await readFile(join(p.member, 'node_modules', LAYOUT_RECORD), 'utf8'),
    );
    expect(inMember).toEqual({ layoutVersion: 1, packages: ['own'], bins: [] });
    expect(await p.record()).toMatchObject({
      packages: ['left'],
      links: [{ path: 'node_modules/member', target: '../packages/member' }],
    });
  });

  it('takes away what an earlier layout wrote there and leaves what it did not', async () => {
    const p = await project();
    await write(p, [
      await placed(p, 'old', `${DIR}/node_modules/old`),
      await placed(p, 'kept', `${DIR}/node_modules/kept`),
    ]);
    await mkdir(join(p.member, 'node_modules', 'by-hand'));
    await writeFile(join(p.member, 'node_modules', 'by-hand', 'x'), 'mine');
    await write(p, [await placed(p, 'kept', `${DIR}/node_modules/kept`)]);
    expect(await readdir(join(p.member, 'node_modules'))).toEqual([
      '.opm-layout.json',
      'by-hand',
      'kept',
    ]);
  });

  it('is not written for a directory the layout was not given', async () => {
    const p = await project();
    await expect(
      write(p, [await placed(p, 'x', 'packages/other/node_modules/x')]),
    ).rejects.toThrow(
      /lives in packages\/other, which is not a workspace member the layout was given/u,
    );
    expect(await exists(join(p.root, 'packages', 'other'))).toBe(false);
  });

  it('is not written through a link in the way', async () => {
    const p = await project();
    const outside = join(p.dir, 'outside');
    await mkdir(outside);
    await symlink(outside, join(p.root, 'packages', 'linked'));
    await expect(
      write(
        p,
        [await placed(p, 'x', 'packages/linked/node_modules/x')],
        [{ dir: 'packages/linked', name: 'linked', bin: {} }],
        [],
      ),
    ).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
    expect(await readdir(outside)).toEqual([]);
  });

  onPosix('has a .bin for the executables of the packages in it', async () => {
    const p = await project();
    await write(p, [
      await placed(
        p,
        'tool',
        `${DIR}/node_modules/tool`,
        '1.0.0',
        {
          'cli.js':
            "#!/usr/bin/env node\nconsole.log('tool', process.argv.slice(2).join())\n",
        },
        { bin: { tool: 'cli.js' } },
      ),
    ]);
    const shim = join(p.member, 'node_modules', '.bin', 'tool');
    expect(execFileSync('sh', [shim, 'a', 'b'], { encoding: 'utf8' })).toBe(
      'tool a,b\n',
    );
    expect(await exists(join(p.modules, '.bin', 'tool'))).toBe(false);
    expect(
      JSON.parse(
        await readFile(join(p.member, 'node_modules', LAYOUT_RECORD), 'utf8'),
      ).bins,
    ).toEqual(['tool']);
  });
});

describe('the executables of a workspace member', () => {
  const withBins = (bin: Record<string, string>): NativeLayoutMember => ({
    ...member,
    bin,
  });

  onPosix(
    "are shimmed where npm links them, and run the member's own script",
    async () => {
      const p = await project();
      await mkdir(join(p.member, 'bin'));
      await writeFile(
        join(p.member, 'bin', 'cli.js'),
        "#!/usr/bin/env node\nconsole.log('member', process.argv.slice(2).join())\n",
      );
      const outcome = await write(p, [], [withBins({ mem: 'bin/cli.js' })]);
      expect(outcome.bins).toBe(1);
      const shim = join(p.modules, '.bin', 'mem');
      expect(await readFile(shim, 'utf8')).toContain(
        "'/../../packages/member/bin/cli.js'",
      );
      expect(execFileSync('sh', [shim, 'x', 'y'], { encoding: 'utf8' })).toBe(
        'member x,y\n',
      );
      // A shim, never a link.
      expect((await lstat(shim)).isSymbolicLink()).toBe(false);
      expect(await p.record()).toMatchObject({ bins: ['mem'] });
    },
  );

  onPosix(
    'are shimmed before the script is built, and run once it is',
    async () => {
      const p = await project();
      const outcome = await write(p, [], [withBins({ built: 'dist/main.js' })]);
      expect(outcome.skipped).toEqual([]);
      await mkdir(join(p.member, 'dist'));
      await writeFile(
        join(p.member, 'dist', 'main.js'),
        "console.log('built')\n",
      );
      expect(
        execFileSync('sh', [join(p.modules, '.bin', 'built')], {
          encoding: 'utf8',
        }),
      ).toBe('built\n');
    },
  );

  onPosix(
    'use the interpreter the script asks for, once it is there',
    async () => {
      const p = await project();
      await mkdir(join(p.member, 'bin'));
      await writeFile(
        join(p.member, 'bin', 'run'),
        '#!/bin/sh\necho shell "$@"\n',
      );
      await write(p, [], [withBins({ run: 'bin/run' })]);
      expect(
        execFileSync('sh', [join(p.modules, '.bin', 'run'), 'z'], {
          encoding: 'utf8',
        }),
      ).toBe('shell z\n');
    },
  );

  // The rule is the one the packages themselves have (a direct requirement
  // keeps a contested name, then the owner whose name sorts first), and a
  // member counts as direct: it does not always win, and the rival's name
  // decides when both are direct.
  describe.each([
    ['a package nobody requires directly', 'rival', true, 'member', 'rival'],
    [
      'a direct package whose name sorts after the member',
      'rival',
      false,
      'member',
      'rival',
    ],
    [
      'a direct package whose name sorts before the member',
      'aaa',
      false,
      'aaa',
      'member',
    ],
  ])(
    'a name also declared by %s',
    (_label, rival, transitive, keeper, loser) => {
      onPosix('goes to the one that outranks, and says who lost', async () => {
        const p = await project();
        await mkdir(join(p.member, 'bin'));
        await writeFile(
          join(p.member, 'bin', 'cli.js'),
          "console.log('member')\n",
        );
        const outcome = await write(
          p,
          [
            {
              ...(await placed(
                p,
                rival,
                `node_modules/${rival}`,
                '1.0.0',
                { 'cli.js': `console.log(${JSON.stringify(rival)})\n` },
                { bin: { tool: 'cli.js' } },
              )),
              transitive,
            },
          ],
          [withBins({ tool: 'bin/cli.js' })],
        );
        expect(
          execFileSync('sh', [join(p.modules, '.bin', 'tool')], {
            encoding: 'utf8',
          }),
        ).toBe(`${keeper}\n`);
        expect(outcome.skipped.map((entry) => entry.reason)).toEqual([
          `${loser} also declares tool; ${keeper} keeps it`,
        ]);
      });
    },
  );

  it.each([
    [
      'a name that is not a file name',
      { '../x': 'bin/a.js' },
      /not a safe file name/u,
    ],
    [
      'a script outside the member',
      { x: '../escape.js' },
      /not a path inside the package/u,
    ],
    ['an absolute script', { x: '/bin/sh' }, /not a path inside the package/u],
  ])('are not shimmed for %s', async (_label, bin, reason) => {
    const p = await project();
    const outcome = await write(p, [], [withBins(bin)]);
    expect(outcome.bins).toBe(0);
    expect(outcome.skipped.map((entry) => entry.reason)).toEqual([
      expect.stringMatching(reason),
    ]);
    expect(await exists(join(p.modules, '.bin'))).toBe(false);
  });

  it('are not shimmed from a directory a shim cannot name', async () => {
    const p = await project();
    const odd: NativeLayoutMember = {
      dir: "packages/it's here",
      name: 'odd',
      bin: { odd: 'bin/odd.js' },
    };
    const outcome = await writeNodeModules(p.root, [], { members: [odd] });
    expect(outcome.bins).toBe(0);
    expect(outcome.skipped.map((entry) => entry.reason)).toEqual([
      expect.stringMatching(/a path a shim cannot carry/u),
    ]);
  });
});
