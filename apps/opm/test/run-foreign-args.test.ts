/**
 * How the `npm`, `pnpm` and `yarn` shims read a command line (ADR 0061), and
 * what they put in a script's environment, on every platform: the Windows
 * shims are checked by their text and the environment by its value, since
 * they are not run here.
 */
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RunError } from '../src/commands/run-error.js';
import { translateForeign } from '../src/commands/run-foreign-args.js';
import { scriptEnvironment } from '../src/commands/run-paths.js';
import { packageShims } from '../src/commands/run-shims.js';

const appRoot = join(import.meta.dirname, '..');

function refused(run: () => void): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(RunError);
    expect((error as RunError).code).toBe('USAGE');
    return (error as RunError).message;
  }
  throw new Error('not refused');
}

describe('npm, read as npm reads it', () => {
  it.each([
    [['run', 'b'], ['b']],
    [['run-script', 'b'], ['b']],
    [['rum', 'b'], ['b']],
    [['test'], ['test']],
    [
      ['t', 'x'],
      ['test', '--', 'x'],
    ],
    [['tst'], ['test']],
    [
      ['start', '--', '--port', '3'],
      ['start', '--', '--port', '3'],
    ],
    [['stop'], ['stop']],
    [['restart'], ['restart']],
    [
      ['run', 'b', 'one', '--', '--two'],
      ['b', '--', 'one', '--two'],
    ],
    [
      ['run', 'b', '--if-present'],
      ['--if-present', 'b'],
    ],
    [
      ['run', '--if-present', 'b'],
      ['--if-present', 'b'],
    ],
    [
      ['run', 'b', '-w', 'one'],
      ['-w', 'one', 'b'],
    ],
    [
      ['--workspace=one', 'run', 'b'],
      ['--workspace', 'one', 'b'],
    ],
    [
      ['run', 'b', '--workspaces'],
      ['--workspaces', 'b'],
    ],
    [
      ['run', 'b', '-ws', '--include-workspace-root'],
      ['-ws', '--include-workspace-root', 'b'],
    ],
    [
      ['-s', 'run', 'b'],
      ['-s', 'b'],
    ],
    [['run'], []],
  ])('npm %j is opm run %j', (argv, rest) => {
    const run = translateForeign('npm', argv);
    expect(run.rest).toEqual(rest);
    expect(run.fallbackExec).toBe(false);
  });

  it('says which options choose members, and takes --prefix as the project', () => {
    expect(translateForeign('npm', ['run', 'b', '-w', 'x']).selects).toBe(true);
    expect(translateForeign('npm', ['run', 'b']).selects).toBe(false);
    const prefixed = translateForeign('npm', ['--prefix', 'sub', 'run', 'b']);
    expect(prefixed.path).toBe('sub');
    expect(prefixed.rest).toEqual(['b']);
    expect(translateForeign('npm', ['-C', 'sub', 'test']).path).toBe('sub');
  });

  it.each([
    ['install', 'opm ci'],
    ['i', 'opm add <spec>'],
    ['ci', 'opm ci'],
    ['uninstall', 'opm remove'],
    ['update', 'opm update'],
    ['exec', 'opm exec <bin>'],
    ['x', 'opmx <package>'],
    ['publish', 'opm publish'],
    ['pack', 'opm pack npm'],
    ['ls', 'opm list'],
    ['why', 'opm why'],
    ['view', 'opm info'],
    ['init', 'opm init'],
    ['install-test', 'opm run test'],
    ['config', 'no counterpart'],
  ])('refuses npm %s, naming %s', (word, hint) => {
    const message = refused(() => translateForeign('npm', [word, 'arg']));
    expect(message).toContain(`npm ${word} inside opm run`);
    expect(message).toContain(hint);
  });

  it('refuses an option of npm that opm does not read, by name, wherever it is', () => {
    expect(
      refused(() => translateForeign('npm', ['run', 'b', '--watch'])),
    ).toContain("npm's --watch");
    expect(refused(() => translateForeign('npm', ['--version']))).toContain(
      'npm --version',
    );
    expect(refused(() => translateForeign('npm', []))).toContain(
      'npm inside opm run',
    );
    expect(
      refused(() => translateForeign('npm', ['run', 'b', '-w'])),
    ).toContain('-w requires a value');
  });
});

describe('pnpm, read as pnpm reads it', () => {
  it.each([
    [['run', 'b'], ['b'], false],
    [
      ['run', 'b', 'one', '--two', '--', 'x'],
      ['b', '--', 'one', '--two', '--', 'x'],
      false,
    ],
    [['b', '--watch'], ['b', '--', '--watch'], true],
    [['test', '--', '--watch'], ['test', '--', '--', '--watch'], false],
    [['start'], ['start'], false],
    [['--filter', 'one', 'build'], ['--filter', 'one', 'build'], true],
    [['-F', 'one', 'run', 'build'], ['-F', 'one', 'build'], false],
    [
      ['-r', 'run', '--if-present', 'build'],
      ['-r', '--if-present', 'build'],
      false,
    ],
    [['-w', 'build'], ['--workspace-root', 'build'], true],
    [
      ['--workspace-concurrency=2', '-r', 'build'],
      ['--workspace-concurrency', '2', '-r', 'build'],
      true,
    ],
    [['--silent', 'run', 'b'], ['--silent', 'b'], false],
  ])('pnpm %j is opm run %j', (argv, rest, fallbackExec) => {
    const run = translateForeign('pnpm', argv);
    expect(run.rest).toEqual(rest);
    expect(run.fallbackExec).toBe(fallbackExec);
  });

  it('takes -C and --dir as the project', () => {
    expect(translateForeign('pnpm', ['-C', 'pkg', 'build']).path).toBe('pkg');
    expect(translateForeign('pnpm', ['--dir=pkg', 'build']).path).toBe('pkg');
  });

  it.each([
    ['install', 'opm ci'],
    ['add', 'opm add'],
    ['exec', 'opm exec'],
    ['dlx', 'opmx'],
    ['store', 'no counterpart'],
  ])('refuses pnpm %s, naming %s', (word, hint) => {
    expect(refused(() => translateForeign('pnpm', [word]))).toContain(hint);
  });

  it('refuses a pnpm option opm does not read', () => {
    expect(
      refused(() => translateForeign('pnpm', ['--no-bail', '-r', 'build'])),
    ).toContain("pnpm's --no-bail");
  });
});

describe('yarn, read where its releases agree', () => {
  it.each([
    [['b'], ['b'], true],
    [['b', 'one', 'two'], ['b', '--', 'one', 'two'], true],
    [['run', 'b', 'one'], ['b', '--', 'one'], false],
    [['-s', 'b'], ['-s', 'b'], true],
    [['workspace', 'one', 'build'], ['--workspace', 'one', 'build'], true],
    [
      ['workspace', 'one', 'run', 'build'],
      ['--workspace', 'one', 'build'],
      false,
    ],
  ])('yarn %j is opm run %j', (argv, rest, fallbackExec) => {
    const run = translateForeign('yarn', argv);
    expect(run.rest).toEqual(rest);
    expect(run.fallbackExec).toBe(fallbackExec);
  });

  it.each([
    [['b', '--', 'x'], 'a --'],
    [['b', '--watch'], 'an option'],
    [['run', 'b', '-x'], 'an option'],
    [[], 'opm ci'],
    [['install'], 'opm ci'],
    [['add', 'x'], 'opm add'],
    [['dlx', 'x'], 'opmx'],
    [['workspaces', 'run', 'b'], 'opm run --workspaces'],
  ])('refuses yarn %j (%s)', (argv, hint) => {
    expect(refused(() => translateForeign('yarn', argv))).toContain(hint);
  });
});

describe('the shims and the environment they are named in', () => {
  const shims = packageShims('/opt/opm/app', '/opt/node/bin/node');

  it('lead PATH and set npm_execpath and npm_node_execpath', () => {
    const env = scriptEnvironment({
      base: { PATH: '/usr/bin:/bin' },
      binDirs: ['/p/node_modules/.bin'],
      shims,
      event: 'a',
      initCwd: '/p',
      platform: 'linux',
    });
    expect(env.PATH).toBe(
      '/opt/opm/app/shims/bin:/p/node_modules/.bin:/usr/bin:/bin',
    );
    expect(env.npm_execpath).toBe('/opt/opm/app/dist/shims/npm.js');
    expect(env.npm_node_execpath).toBe('/opt/node/bin/node');
  });

  it('are first once in a nested run, the rest of PATH as it was', () => {
    const env = scriptEnvironment({
      base: {
        PATH: '/opt/opm/app/shims/bin:/p/node_modules/.bin:/usr/bin',
      },
      binDirs: ['/p/sub/node_modules/.bin'],
      shims,
      event: 'b',
      initCwd: '/p',
      platform: 'linux',
    });
    expect(env.PATH).toBe(
      '/opt/opm/app/shims/bin:/p/sub/node_modules/.bin:/p/node_modules/.bin:/usr/bin',
    );
  });

  it('lead Path on Windows, by its own spelling and delimiter', () => {
    const windows = packageShims('C:\\opm\\app', 'C:\\node\\node.exe');
    const env = scriptEnvironment({
      base: { Path: 'C:\\Windows\\system32' },
      binDirs: ['C:\\p\\node_modules\\.bin'],
      shims: { ...windows, bin: 'C:\\opm\\app\\shims\\bin' },
      event: 'a',
      initCwd: 'C:\\p',
      platform: 'win32',
    });
    expect(env.Path).toBe(
      'C:\\opm\\app\\shims\\bin;C:\\p\\node_modules\\.bin;C:\\Windows\\system32',
    );
    expect(env.PATH).toBeUndefined();
  });

  it.each(['npm', 'pnpm', 'yarn'])(
    'ship %s as an executable POSIX script and a .cmd that start the same JavaScript',
    async (tool) => {
      const bin = join(appRoot, 'shims', 'bin');
      const posix = await readFile(join(bin, tool), 'utf8');
      expect(posix.startsWith('#!/bin/sh\n')).toBe(true);
      expect(posix).toContain(
        `exec "\${npm_node_execpath:-node}" "\${0%/*}/../../dist/shims/${tool}.js" "$@"`,
      );
      if (process.platform !== 'win32')
        expect((await stat(join(bin, tool))).mode & 0o111).not.toBe(0);
      const cmd = await readFile(join(bin, `${tool}.cmd`), 'utf8');
      expect(cmd).toContain('%npm_node_execpath%');
      expect(cmd).toContain(`"%~dp0..\\..\\dist\\shims\\${tool}.js" %*`);
      expect(cmd.split('\r\n').length).toBeGreaterThan(3);
    },
  );
});
