import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  escapeCmdArgument,
  firstWord,
  isBatchFile,
  planBin,
  planScript,
} from '../src/commands/run-command-line.js';

describe('escapeCmdArgument', () => {
  // The expected strings are what cmd.exe /d /s /c must be given so that the
  // program (or a batch file's %*) receives the argument unchanged. They were
  // derived from the C runtime's quoting rule plus caret-escaping of
  // cmd.exe's metacharacters; they have not been run on Windows here.
  const single: [string, string][] = [
    ['plain', 'plain'],
    ['--flag=value', '--flag=value'],
    ['', '""'],
    ['a b', '^"a^ b^"'],
    ['a&b', 'a^&b'],
    ['a|b>c<d', 'a^|b^>c^<d'],
    ['a^b', 'a^^b'],
    ['100%', '100^%'],
    ['%PATH%', '^%PATH^%'],
    ['(x)', '^(x^)'],
    ['hi!', 'hi^!'],
    ['say "hi"', '^"say^ \\^"hi\\^"^"'],
    ['C:\\dir with space\\', '^"C:\\dir^ with^ space\\\\^"'],
    ['C:\\plain\\dir\\', 'C:\\plain\\dir\\'],
    ['a\\"b', '^"a\\\\\\^"b^"'],
    ['tab\there', '^"tab\there^"'],
  ];

  it.each(single)('escapes %j for a program', (input, expected) => {
    expect(escapeCmdArgument(input)).toBe(expected);
  });

  it('escapes a second time for a batch file, which reads the line again', () => {
    expect(escapeCmdArgument('a b', true)).toBe('^^^"a^^^ b^^^"');
    expect(escapeCmdArgument('a&b', true)).toBe('a^^^&b');
    expect(escapeCmdArgument('plain', true)).toBe('plain');
    expect(escapeCmdArgument('', true)).toBe('""');
  });

  it('leaves no unescaped metacharacter in what it returns', () => {
    const hostile = [
      'a b',
      'x&calc',
      'x|y',
      '"x"',
      '%COMSPEC%',
      '^',
      '(a)',
      'a<b>c',
      '\\"',
      'trailing\\',
      '!x!',
    ];
    for (const input of hostile) {
      for (const twice of [false, true]) {
        const escaped = escapeCmdArgument(input, twice);
        // Every metacharacter is directly preceded by a caret; a caret that
        // follows another caret is itself the escaped one.
        const bare = escaped.replace(/\^./gu, '');
        expect(bare, `${input} / ${twice}`).not.toMatch(/[ !%&()<>|"]/u);
      }
    }
  });

  it.each(['a\nb', 'a\rb', 'a\0b'])(
    'refuses %j, which cmd.exe cannot carry',
    (input) => {
      expect(() => escapeCmdArgument(input)).toThrow(/line break or a NUL/u);
    },
  );
});

describe('firstWord', () => {
  it.each([
    ['vitest run', 'vitest'],
    ['  node -e x', 'node'],
    ['"C:\\Program Files\\x.cmd" a b', 'C:\\Program Files\\x.cmd'],
    ['tsc&&vitest', 'tsc&&vitest'],
    ['', ''],
  ])('reads %j as %j', (script, word) => {
    expect(firstWord(script)).toBe(word);
  });
});

describe('isBatchFile', () => {
  it('is true for .cmd and .bat in any case, false for others', () => {
    expect(isBatchFile('C:\\x\\a.CMD')).toBe(true);
    expect(isBatchFile('a.bat')).toBe(true);
    expect(isBatchFile('a.exe')).toBe(false);
    expect(isBatchFile('a.cmd.exe')).toBe(false);
    expect(isBatchFile('cmd')).toBe(false);
  });
});

describe('planScript', () => {
  it('runs a script under /bin/sh -c on POSIX', () => {
    expect(planScript('vitest run', [], { platform: 'linux' })).toEqual({
      file: '/bin/sh',
      args: ['-c', 'vitest run'],
      windowsVerbatimArguments: false,
    });
  });

  it('hands extra arguments to the shell as parameters, never as text', () => {
    const plan = planScript('vitest run', ['-t', 'a b', '$(id)'], {
      platform: 'darwin',
    });
    expect(plan.args).toEqual([
      '-c',
      'vitest run "$@"',
      'sh',
      '-t',
      'a b',
      '$(id)',
    ]);
  });

  it('refuses a script with a NUL on POSIX', () => {
    expect(() => planScript('a\0b', [], { platform: 'linux' })).toThrow(/NUL/u);
  });

  it('runs a script under cmd.exe /d /s /c with the line quoted whole on Windows', () => {
    expect(planScript('vitest run', [], { platform: 'win32' })).toEqual({
      file: 'cmd.exe',
      args: ['/d', '/s', '/c', '"vitest run"'],
      windowsVerbatimArguments: true,
    });
  });

  it('uses ComSpec when it is set', () => {
    const plan = planScript('x', [], {
      platform: 'win32',
      comspec: 'C:\\Windows\\System32\\cmd.exe',
    });
    expect(plan.file).toBe('C:\\Windows\\System32\\cmd.exe');
  });

  it('appends Windows arguments escaped for a program', () => {
    const plan = planScript('vitest run', ['-t', 'a b'], {
      platform: 'win32',
    });
    expect(plan.args[3]).toBe('"vitest run -t ^"a^ b^""');
  });

  it('escapes twice when the script starts with a batch file', () => {
    const plan = planScript('vitest run', ['-t', 'a b'], {
      platform: 'win32',
      firstIsBatch: true,
    });
    expect(plan.args[3]).toBe('"vitest run -t ^^^"a^^^ b^^^""');
  });
});

describe('planBin', () => {
  it('executes the file directly on POSIX', () => {
    expect(
      planBin('/p/node_modules/.bin/vitest', ['--version'], {
        platform: 'linux',
      }),
    ).toEqual({
      file: '/p/node_modules/.bin/vitest',
      args: ['--version'],
      windowsVerbatimArguments: false,
    });
  });

  it('executes a real .exe directly on Windows, with no shell', () => {
    expect(
      planBin('C:\\p\\node_modules\\.bin\\esbuild.exe', ['a b'], {
        platform: 'win32',
      }),
    ).toEqual({
      file: 'C:\\p\\node_modules\\.bin\\esbuild.exe',
      args: ['a b'],
      windowsVerbatimArguments: false,
    });
  });

  it('runs a .cmd shim through cmd.exe with a doubly escaped line', () => {
    expect(
      planBin('C:\\p q\\node_modules\\.bin\\vitest.cmd', ['--version', 'a b'], {
        platform: 'win32',
      }),
    ).toEqual({
      file: 'cmd.exe',
      args: [
        '/d',
        '/s',
        '/c',
        '""C:\\p q\\node_modules\\.bin\\vitest.cmd" --version ^^^"a^^^ b^^^""',
      ],
      windowsVerbatimArguments: true,
    });
  });

  it.each(['C:\\100%\\vitest.cmd', 'C:\\a"b\\vitest.cmd'])(
    'refuses a batch file at %j, which no quoting can protect',
    (file) => {
      expect(() => planBin(file, [], { platform: 'win32' })).toThrow(
        /cmd\.exe/u,
      );
    },
  );
});

describe.skipIf(process.platform === 'win32')(
  'the POSIX plan against a real shell',
  () => {
    it('delivers every argument byte for byte', () => {
      const extra = [
        'a b',
        "it's",
        '$(echo pwned)',
        ';echo pwned',
        '"q"',
        '\\n',
        'line\nbreak',
        '`id`',
        '*',
        '-n',
        '',
      ];
      const plan = planScript("printf '%s\\0'", extra, {
        platform: process.platform,
      });
      const result = spawnSync(plan.file, plan.args, { encoding: 'utf8' });
      expect(result.status).toBe(0);
      expect(result.stdout.split('\0').slice(0, -1)).toEqual(extra);
    });
  },
);
