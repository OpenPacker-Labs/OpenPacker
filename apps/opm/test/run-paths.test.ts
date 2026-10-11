import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  binCandidates,
  binDirectories,
  binNameProblem,
  pathKey,
  resolveBin,
  scriptEnvironment,
  type BinProbe,
} from '../src/commands/run-paths.js';

describe('binDirectories', () => {
  it('lists node_modules/.bin of the root and of every ancestor, nearest first', () => {
    expect(binDirectories('/work/repo/packages/app', path.posix)).toEqual([
      '/work/repo/packages/app/node_modules/.bin',
      '/work/repo/packages/node_modules/.bin',
      '/work/repo/node_modules/.bin',
      '/work/node_modules/.bin',
      '/node_modules/.bin',
    ]);
  });

  it('does the same with Windows paths, drive root last', () => {
    expect(binDirectories('C:\\work\\repo', path.win32)).toEqual([
      'C:\\work\\repo\\node_modules\\.bin',
      'C:\\work\\node_modules\\.bin',
      'C:\\node_modules\\.bin',
    ]);
  });

  it('is one directory at the filesystem root', () => {
    expect(binDirectories('/', path.posix)).toEqual(['/node_modules/.bin']);
  });

  it('normalises a root with a trailing separator or dots', () => {
    expect(binDirectories('/a/b/../c/', path.posix)[0]).toBe(
      '/a/c/node_modules/.bin',
    );
  });
});

describe('pathKey', () => {
  it('is PATH on POSIX, whatever else the environment holds', () => {
    expect(pathKey({ Path: 'x', PATH: 'y' }, 'linux')).toBe('PATH');
  });

  it('keeps the spelling Windows already uses, and defaults to Path', () => {
    expect(pathKey({ PATH: 'x' }, 'win32')).toBe('PATH');
    expect(pathKey({ pAtH: 'x' }, 'win32')).toBe('pAtH');
    expect(pathKey({}, 'win32')).toBe('Path');
  });
});

describe('scriptEnvironment', () => {
  const base = {
    PATH: '/usr/bin:/bin',
    HOME: '/home/someone',
    OPM_TEST_TOKEN: 'vtok_dummy_marker_0123456789abcdef',
    GONE: undefined,
  };
  const dirs = ['/p/node_modules/.bin', '/node_modules/.bin'];

  it('leads PATH with the .bin directories and then the inherited PATH', () => {
    const env = scriptEnvironment({
      base,
      binDirs: dirs,
      event: 'test',
      initCwd: '/p/sub',
      platform: 'linux',
    });
    expect(env.PATH).toBe(
      '/p/node_modules/.bin:/node_modules/.bin:/usr/bin:/bin',
    );
  });

  it('sets only the four names and leaves everything else as inherited', () => {
    const env = scriptEnvironment({
      base,
      binDirs: dirs,
      event: 'pretest',
      packageName: '@scope/app',
      packageVersion: '1.2.3',
      initCwd: '/p/sub',
      platform: 'linux',
    });
    const changed = Object.keys(env).filter(
      (key) => env[key] !== (base as Record<string, string | undefined>)[key],
    );
    expect(changed.sort()).toEqual([
      'INIT_CWD',
      'PATH',
      'npm_lifecycle_event',
      'npm_package_name',
      'npm_package_version',
    ]);
    expect(env).toMatchObject({
      npm_lifecycle_event: 'pretest',
      npm_package_name: '@scope/app',
      npm_package_version: '1.2.3',
      INIT_CWD: '/p/sub',
      HOME: '/home/someone',
      OPM_TEST_TOKEN: 'vtok_dummy_marker_0123456789abcdef',
    });
    expect('GONE' in env).toBe(false);
  });

  it('does not invent a name or version the package lacks', () => {
    const env = scriptEnvironment({
      base: {},
      binDirs: dirs,
      event: 'exec',
      initCwd: '/p',
      platform: 'linux',
    });
    expect('npm_package_name' in env).toBe(false);
    expect('npm_package_version' in env).toBe(false);
  });

  it('keeps an INIT_CWD an outer run already set', () => {
    const env = scriptEnvironment({
      base: { INIT_CWD: '/where/it/began' },
      binDirs: dirs,
      event: 'x',
      initCwd: '/p/sub',
      platform: 'linux',
    });
    expect(env.INIT_CWD).toBe('/where/it/began');
  });

  it('handles an environment with no PATH at all', () => {
    const env = scriptEnvironment({
      base: {},
      binDirs: dirs,
      event: 'x',
      initCwd: '/p',
      platform: 'linux',
    });
    expect(env.PATH).toBe('/p/node_modules/.bin:/node_modules/.bin');
  });

  it('uses the Path spelling and the ; delimiter on Windows', () => {
    const env = scriptEnvironment({
      base: { Path: 'C:\\Windows' },
      binDirs: ['C:\\p\\node_modules\\.bin'],
      event: 'x',
      initCwd: 'C:\\p',
      platform: 'win32',
    });
    expect(env.Path).toBe('C:\\p\\node_modules\\.bin;C:\\Windows');
    expect('PATH' in env).toBe(false);
  });

  it('does not modify the environment it inherits from', () => {
    const before = { ...base };
    scriptEnvironment({
      base,
      binDirs: dirs,
      event: 'x',
      initCwd: '/p',
      platform: 'linux',
    });
    expect(base).toEqual(before);
  });
});

describe('binCandidates', () => {
  it('is the bare name on POSIX', () => {
    expect(binCandidates('vitest', 'linux', undefined)).toEqual(['vitest']);
  });

  it('tries PATHEXT in order on Windows and never the extensionless shim', () => {
    expect(binCandidates('vitest', 'win32', '.COM;.EXE;.BAT;.CMD')).toEqual([
      'vitest.com',
      'vitest.exe',
      'vitest.bat',
      'vitest.cmd',
    ]);
    expect(binCandidates('vitest', 'win32', undefined)).toContain('vitest.cmd');
  });

  it('tries a name that already has a known extension first', () => {
    expect(binCandidates('vitest.CMD', 'win32', '.EXE;.CMD')[0]).toBe(
      'vitest.CMD',
    );
  });

  it('ignores PATHEXT entries that are not extensions', () => {
    expect(binCandidates('t', 'win32', ';;exe; .cmd ')).toEqual(['t.cmd']);
  });
});

describe('resolveBin', () => {
  const fake =
    (files: Record<string, BinProbe>) =>
    async (file: string): Promise<BinProbe> =>
      files[file] ?? 'absent';

  it('returns the nearest runnable match and never looks further', async () => {
    const seen: string[] = [];
    const resolution = await resolveBin(
      'tsc',
      ['/a/b/node_modules/.bin', '/a/node_modules/.bin'],
      {
        platform: 'linux',
        flavor: path.posix,
        probe: async (file) => {
          seen.push(file);
          return file.startsWith('/a/b') ? 'runnable' : 'absent';
        },
      },
    );
    expect(resolution.found).toBe('/a/b/node_modules/.bin/tsc');
    expect(seen).toEqual(['/a/b/node_modules/.bin/tsc']);
  });

  it('falls back to a parent directory', async () => {
    const resolution = await resolveBin(
      'tsc',
      ['/a/b/node_modules/.bin', '/a/node_modules/.bin'],
      {
        platform: 'linux',
        flavor: path.posix,
        probe: fake({ '/a/node_modules/.bin/tsc': 'runnable' }),
      },
    );
    expect(resolution.found).toBe('/a/node_modules/.bin/tsc');
  });

  it('reports a file it cannot execute and keeps looking', async () => {
    const resolution = await resolveBin(
      'tsc',
      ['/a/node_modules/.bin', '/node_modules/.bin'],
      {
        platform: 'linux',
        flavor: path.posix,
        probe: fake({ '/a/node_modules/.bin/tsc': 'present' }),
      },
    );
    expect(resolution.found).toBeUndefined();
    expect(resolution.present).toEqual(['/a/node_modules/.bin/tsc']);
  });

  it('finds the .cmd shim on Windows, in PATHEXT order', async () => {
    const resolution = await resolveBin(
      'vitest',
      ['C:\\p\\node_modules\\.bin'],
      {
        platform: 'win32',
        flavor: path.win32,
        pathext: '.EXE;.CMD',
        probe: fake({
          'C:\\p\\node_modules\\.bin\\vitest': 'runnable',
          'C:\\p\\node_modules\\.bin\\vitest.cmd': 'runnable',
        }),
      },
    );
    expect(resolution.found).toBe('C:\\p\\node_modules\\.bin\\vitest.cmd');
  });

  it('finds nothing when the directories are empty', async () => {
    expect(
      await resolveBin('x', [], { platform: 'linux', probe: fake({}) }),
    ).toEqual({ present: [] });
  });
});

describe('binNameProblem', () => {
  it('accepts a plain name, scoped-package style names included', () => {
    expect(binNameProblem('vitest', 'linux')).toBeUndefined();
    expect(binNameProblem('esbuild.exe', 'win32')).toBeUndefined();
  });

  it.each(['', '.', '..', './x', 'a/b', '/bin/sh', 'a\\b', 'a\0b'])(
    'refuses %j',
    (name) => {
      expect(binNameProblem(name, 'linux')).toBeTypeOf('string');
    },
  );

  it('refuses a colon on Windows only', () => {
    expect(binNameProblem('c:x', 'win32')).toBeTypeOf('string');
    expect(binNameProblem('c:x', 'linux')).toBeUndefined();
  });
});
