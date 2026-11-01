import { describe, expect, it } from 'vitest';
import { parseForTest } from '../src/opmx.js';

/**
 * A bin shim runs `opmx -- <name> [args...]`: with nothing named yet, the
 * argument after `--` is the tool's name, so a name that starts with "-" is
 * never read as one of opmx's options (`--allow-network` would grant network).
 * With a tool already named (`--package`, `--bin`, a name), all of what
 * follows `--` is the tool's, as before.
 */

describe('opmx --', () => {
  it('names the tool with the argument after it, when nothing has', () => {
    expect(
      parseForTest(['--', '--allow-network', '--timeout', '5']),
    ).toMatchObject({
      positionals: ['--allow-network'],
      passthrough: ['--timeout', '5'],
      allowNetwork: false,
    });
    expect(parseForTest(['--'])).toMatchObject({
      positionals: [],
      passthrough: [],
    });
  });

  it('hands all of what follows to a tool already named', () => {
    expect(
      parseForTest(['--package', 'demo', '--', '--version']),
    ).toMatchObject({
      packageAlias: 'demo',
      positionals: [],
      passthrough: ['--version'],
    });
    expect(parseForTest(['--bin=demo', '--', '-x'])).toMatchObject({
      binName: 'demo',
      positionals: [],
      passthrough: ['-x'],
    });
    expect(parseForTest(['demo', '--', '-x'])).toMatchObject({
      positionals: ['demo'],
      passthrough: ['-x'],
    });
  });
});
