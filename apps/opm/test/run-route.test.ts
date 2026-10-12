import { describe, expect, it } from 'vitest';
import { routeRun, unknownCommandHint } from '../src/commands/run-route.js';
import { makeDirectory, makeProject } from './run-fixture.js';

async function project() {
  return await makeProject({
    scripts: { build: 'true', 'test:file': 'true', list: 'true' },
  });
}

describe('routeRun: run and exec by name', () => {
  it('reads run and exec at the start as they are', async () => {
    const root = await project();
    expect(await routeRun(['run', 'build', '--', 'x'], root)).toEqual({
      command: 'run',
      rest: ['build', '--', 'x'],
      fallbackExec: false,
    });
    expect(await routeRun(['exec', 'tsc', '-b'], root)).toEqual({
      command: 'exec',
      rest: ['tsc', '-b'],
      fallbackExec: false,
    });
  });

  it('leaves a request for help, and anything else, to the full command line', async () => {
    const root = await project();
    for (const argv of [
      [],
      ['--help'],
      ['run', '--help'],
      ['exec', '-h'],
      ['list'],
      ['install', 'x'],
      ['--offline', 'run', 'x'],
      ['-r'],
      ['-r', 'run', '--help'],
    ])
      expect(await routeRun(argv, root), argv.join(' ')).toBeUndefined();
    expect((await routeRun(['exec', 'tsc', '--help'], root))?.command).toBe(
      'exec',
    );
  });
});

describe('routeRun: options before the command, as pnpm and npm write them', () => {
  it.each([
    [['--filter', 'a', 'run', 'build'], 'run', ['--filter', 'a', 'build']],
    [['-r', 'run', 'build', '--', 'x'], 'run', ['-r', 'build', '--', 'x']],
    [
      ['--filter=a', '-F', 'b', 'exec', 'tsc', '-b'],
      'exec',
      ['--filter=a', '-F', 'b', 'tsc', '-b'],
    ],
    [['-C', 'dir', 'exec', 'tsc'], 'exec', ['-C', 'dir', 'tsc']],
    [['--dir=dir', 'run', 'build'], 'run', ['--dir=dir', 'build']],
    [['--prefix', 'dir', 'run', 'build'], 'run', ['--prefix', 'dir', 'build']],
    [['-w', 'pkg', 'run', 'build'], 'run', ['-w', 'pkg', 'build']],
    [['--workspaces', 'run', 'build'], 'run', ['--workspaces', 'build']],
    [
      ['--workspace-concurrency', '2', '-r', 'exec', 'tsc'],
      'exec',
      ['--workspace-concurrency', '2', '-r', 'tsc'],
    ],
    [['--silent', 'run', 'build'], 'run', ['--silent', 'build']],
  ] as const)('%j is %s %j', async (argv, command, rest) => {
    const root = await project();
    expect(await routeRun([...argv], root)).toEqual({
      command,
      rest,
      fallbackExec: false,
    });
  });

  it("refuses -w with no name before run or exec, because pnpm's -w means the root", async () => {
    const root = await project();
    await expect(routeRun(['-w', 'run', 'build'], root)).rejects.toMatchObject({
      code: 'USAGE',
      message: expect.stringContaining('--workspace-root for the root'),
    });
    await expect(routeRun(['-w', 'exec', 'tsc'], root)).rejects.toMatchObject({
      code: 'USAGE',
    });
  });

  it('leaves an option it does not read before the command to the full command line', async () => {
    const root = await project();
    expect(
      await routeRun(['-r', '--offline', 'run', 'build'], root),
    ).toBeUndefined();
    expect(await routeRun(['--filter'], root)).toBeUndefined();
  });
});

describe('routeRun: a word where a command goes', () => {
  it('is a script or executable of the project when pnpm-style options came first', async () => {
    const root = await project();
    expect(await routeRun(['--filter', 'a', 'build'], root)).toEqual({
      command: 'run',
      rest: ['--filter', 'a', 'build'],
      fallbackExec: true,
    });
    expect(await routeRun(['-r', 'nothing-here'], root)).toMatchObject({
      command: 'run',
      fallbackExec: true,
    });
  });

  it('is a script of the project, with what follows going to it', async () => {
    const root = await project();
    expect(await routeRun(['build'], root)).toEqual({
      command: 'run',
      rest: ['build'],
      fallbackExec: true,
    });
    expect(await routeRun(['test:file', 'a.test.ts', '--watch'], root)).toEqual(
      {
        command: 'run',
        rest: ['test:file', '--', 'a.test.ts', '--watch'],
        fallbackExec: true,
      },
    );
  });

  it('drops one -- straight after the word and keeps the rest', async () => {
    const root = await project();
    expect((await routeRun(['build', '--', '--base=x'], root))?.rest).toEqual([
      'build',
      '--',
      '--base=x',
    ]);
    expect((await routeRun(['build', '--', '--', 'y'], root))?.rest).toEqual([
      'build',
      '--',
      '--',
      'y',
    ]);
    expect((await routeRun(['-s', 'build', '--', '--x'], root))?.rest).toEqual([
      '-s',
      'build',
      '--',
      '--x',
    ]);
  });

  it('is an executable of the project when no script has the name', async () => {
    const root = await project();
    expect((await routeRun(['fake-tool', 'x'], root))?.rest).toEqual([
      'fake-tool',
      '--',
      'x',
    ]);
  });

  it('is a mistyped command when the project has nothing by the name', async () => {
    const root = await project();
    expect(await routeRun(['biuld'], root)).toBeUndefined();
    expect(await routeRun(['a/b'], root)).toBeUndefined();
  });

  it('never takes the place of a command, even for a script that has its name', async () => {
    const root = await project();
    expect(await routeRun(['list'], root)).toBeUndefined();
    expect(await routeRun(['--filter', 'a', 'list'], root)).toBeUndefined();
  });

  it('finds an executable in the .bin of a parent directory', async () => {
    const root = await project();
    const nested = await makeDirectory(root, 'nested');
    expect((await routeRun(['fake-tool'], nested))?.fallbackExec).toBe(true);
    expect(await routeRun(['not-installed'], nested)).toBeUndefined();
  });
});

describe('unknownCommandHint', () => {
  it('points dlx, npx and create at opm exec and opmx', () => {
    for (const word of ['dlx', 'npx', 'pnpx', 'x', 'create'])
      expect(unknownCommandHint(word), word).toMatch(/opmx <package>/u);
    expect(unknownCommandHint('dlx')).toContain('opm exec <bin>');
  });

  it('has nothing to say about other words', () => {
    expect(unknownCommandHint('frobnicate')).toBeUndefined();
  });
});
