import { describe, expect, it } from 'vitest';
import { runOpm } from '../src/opm.js';
import { parseExecRequest } from '../src/commands/run-args.js';
import { capture, makeProject, report } from './run-fixture.js';

/**
 * `opm exec <bin> [--path <dir>] [-- <args...>]` is what the help says, and
 * `opm exec tsc --path pkg -- -b` handed `--path pkg` to tsc ("error: unknown
 * option '--path'"); only `opm exec --path pkg tsc -- -b` worked. A `--path`
 * straight after the bin is opm's now; the program's arguments are what
 * follows it, or what follows `--`.
 */

const exec = (...rest: string[]) => parseExecRequest([], rest);

describe('opm exec --path after the bin', () => {
  it('is opm’s, in either order', () => {
    const expected = { bin: 'tsc', path: 'pkg', args: ['-b'] };
    expect(exec('tsc', '--path', 'pkg', '--', '-b')).toEqual(expected);
    expect(exec('--path', 'pkg', 'tsc', '--', '-b')).toEqual(expected);
    expect(exec('tsc', '--path=pkg', '--', '-b')).toEqual(expected);
    expect(exec('tsc', '--path', 'pkg', '-b')).toEqual(expected);
    expect(exec('tsc', '--path', 'pkg')).toEqual({
      bin: 'tsc',
      path: 'pkg',
      args: [],
    });
  });

  it('leaves a --path after -- to the program', () => {
    expect(exec('tool', '--', '--path', 'x')).toEqual({
      bin: 'tool',
      path: undefined,
      args: ['--path', 'x'],
    });
    expect(exec('tool', '--path', 'pkg', '--', '--path', 'x')).toEqual({
      bin: 'tool',
      path: 'pkg',
      args: ['--path', 'x'],
    });
  });

  it('leaves a --path after the program’s first argument to the program', () => {
    expect(exec('tsc', '-b', '--path', 'x')).toEqual({
      bin: 'tsc',
      path: undefined,
      args: ['-b', '--path', 'x'],
    });
  });

  it('is not read as pnpm’s or npm’s spelling after the bin', () => {
    expect(exec('make', '-C', 'sub').args).toEqual(['-C', 'sub']);
    expect(exec('tool', '--dir', 'd').args).toEqual(['--dir', 'd']);
  });

  it('refuses a --path given twice, and one with no directory', () => {
    expect(() => exec('--path', 'a', 'tsc', '--path', 'b')).toThrow(
      /--path is given twice/u,
    );
    expect(() => exec('tsc', '--path')).toThrow(/--path requires a directory/u);
    expect(() => exec('tsc', '--path', '--', 'x')).toThrow(
      /--path requires a directory/u,
    );
  });
});

describe('opm exec --path, run', () => {
  it('finds the bin in that project and passes the arguments after --', async () => {
    const root = await makeProject({ name: 'there', version: '1.0.0' });
    // Has a fake-tool of its own and no package.json: only --path names 'there'.
    const elsewhere = await makeProject({ noPackage: true });
    for (const argv of [
      ['exec', 'fake-tool', '--path', root, '--', '--path', 'x'],
      ['exec', '--path', root, 'fake-tool', '--', '--path', 'x'],
    ]) {
      const cap = capture();
      expect(await runOpm(argv, cap.io, elsewhere), cap.err).toBe(0);
      expect(report(cap.out)).toMatchObject({
        argv: ['--path', 'x'],
        name: 'there',
      });
    }
  });
});
