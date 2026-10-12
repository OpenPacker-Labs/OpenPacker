import { describe, expect, it } from 'vitest';
import { parseShebang, renderCmdShim, renderPosixShim } from './layout-bins.js';

describe('parseShebang', () => {
  it.each([
    ['#!/usr/bin/env node', { program: 'node', args: [] }],
    ['#!/usr/bin/node', { program: 'node', args: [] }],
    ['#!/usr/bin/env nodejs', { program: 'node', args: [] }],
    [
      '#!/usr/bin/env -S node --no-warnings',
      { program: 'node', args: ['--no-warnings'] },
    ],
    ['#!/bin/sh', { program: 'sh', args: [] }],
    ['#!/usr/bin/env bash', { program: 'bash', args: [] }],
    ['#!/usr/bin/env python3', { program: 'python3', args: [] }],
    ['#!/usr/bin/env node\r', { program: 'node', args: [] }],
    ['// not a shebang', { program: 'node', args: [] }],
    ['', { program: 'node', args: [] }],
  ])('reads %j', (line, expected) => {
    expect(parseShebang(line)).toEqual(expected);
  });

  it.each([
    '#!/usr/bin/env $(touch pwned)',
    '#!/usr/bin/env `id`',
    "#!/usr/bin/env 'node; id'",
    '#!/usr/bin/env ../../../bin/evil',
  ])('does not trust the interpreter in %j', (line) => {
    expect(parseShebang(line)).toEqual({ program: 'node', args: [] });
  });

  it('drops interpreter arguments that are not plain flags', () => {
    expect(parseShebang('#!/usr/bin/env node --ok $(id) ;rm')).toEqual({
      program: 'node',
      args: ['--ok'],
    });
  });
});

describe('shims', () => {
  it('quotes the target so nothing in it is interpreted', () => {
    const shim = renderPosixShim("../it's/a $(b)/cli.js", {
      program: 'node',
      args: [],
    });
    expect(shim.split('\n')[0]).toBe('#!/bin/sh');
    expect(shim).toContain(`"$basedir"'/../it'\\''s/a $(b)/cli.js'`);
    expect(shim).toContain("exec 'node' ");
    expect(shim.endsWith('"$@"\n')).toBe(true);
  });

  it('puts the interpreter flags before the script', () => {
    expect(
      renderPosixShim('../x/cli.js', {
        program: 'node',
        args: ['--no-warnings'],
      }),
    ).toContain(
      "exec 'node' '--no-warnings' \"$basedir\"'/../x/cli.js' \"$@\"",
    );
  });

  it('writes a Windows shim with backslashes and CRLF', () => {
    const shim = renderCmdShim('../@s/n/bin/cli.js', {
      program: 'node',
      args: [],
    });
    expect(shim).toBe(
      '@ECHO off\r\nSETLOCAL\r\nnode "%~dp0\\..\\@s\\n\\bin\\cli.js" %*\r\n',
    );
  });
});
