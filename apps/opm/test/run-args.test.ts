import { describe, expect, it } from 'vitest';
import {
  asksForHelp,
  parseExecRequest,
  parseRunRequest,
} from '../src/commands/run-args.js';

const run = (...rest: string[]) => parseRunRequest([], rest);
const exec = (...rest: string[]) => parseExecRequest([], rest);

describe('parseRunRequest', () => {
  it('has no script when none is named', () => {
    expect(run()).toEqual({
      script: undefined,
      ifPresent: false,
      path: undefined,
      args: [],
    });
  });

  it('takes the script name and the arguments after --', () => {
    expect(run('test', '--', '--watch', 'a b')).toEqual({
      script: 'test',
      ifPresent: false,
      path: undefined,
      args: ['--watch', 'a b'],
    });
  });

  it('keeps a second -- as an argument for the script', () => {
    expect(run('test', '--', '--', 'x').args).toEqual(['--', 'x']);
  });

  it('reads --if-present and --path in either order and form', () => {
    expect(run('--if-present', 'lint', '--path', 'pkg')).toMatchObject({
      script: 'lint',
      ifPresent: true,
      path: 'pkg',
    });
    expect(run('lint', '--path=pkg', '--if-present')).toMatchObject({
      script: 'lint',
      ifPresent: true,
      path: 'pkg',
    });
  });

  it('does not read options after -- as its own', () => {
    expect(run('test', '--', '--if-present', '--path', 'x')).toMatchObject({
      ifPresent: false,
      path: undefined,
      args: ['--if-present', '--path', 'x'],
    });
  });

  it('refuses a flag it does not know instead of dropping it', () => {
    expect(() => run('test', '--watch')).toThrow(
      /Unknown option --watch for opm run; arguments for the script go after --/u,
    );
  });

  it('refuses a second script name', () => {
    expect(() => run('test', 'lint')).toThrow(/one script name/u);
  });

  it('refuses arguments with no script to give them to', () => {
    expect(() => run('--', 'x')).toThrow(/Name the script before --/u);
  });

  it.each([[['--path']], [['--path=']], [['--path', '--if-present']]])(
    'refuses --path without a directory: %j',
    (tokens) => {
      expect(() => run('x', ...tokens)).toThrow(/--path requires a directory/u);
    },
  );

  it('refuses opm options placed before the command name', () => {
    expect(() => parseRunRequest(['--path', 'x'], ['test'])).toThrow(
      /Put --path after the command name/u,
    );
    expect(() => parseRunRequest(['--if-present'], ['test'])).toThrow(
      /Put --if-present after the command name/u,
    );
    expect(parseRunRequest(['--offline'], ['test']).script).toBe('test');
  });
});

describe('parseExecRequest', () => {
  it('takes the bin and the arguments after --', () => {
    expect(exec('vitest', '--', '--version')).toEqual({
      bin: 'vitest',
      path: undefined,
      args: ['--version'],
    });
  });

  it('hands everything after the bin to it when there is no --', () => {
    expect(exec('vitest', 'run', '--path', 'x', '--if-present')).toEqual({
      bin: 'vitest',
      path: undefined,
      args: ['run', '--path', 'x', '--if-present'],
    });
  });

  it('drops one -- right after the bin and no other', () => {
    expect(exec('tsc', '--', '--', 'x').args).toEqual(['--', 'x']);
    expect(exec('tsc', '--', '-p', 'a').args).toEqual(['-p', 'a']);
  });

  it('reads --path before the bin', () => {
    expect(exec('--path', 'pkg', 'tsc', '-b')).toEqual({
      bin: 'tsc',
      path: 'pkg',
      args: ['-b'],
    });
    expect(exec('--path=pkg', 'tsc')).toMatchObject({ path: 'pkg' });
  });

  it('accepts the bin after a leading --', () => {
    expect(exec('--', 'tsc', '--version')).toEqual({
      bin: 'tsc',
      path: undefined,
      args: ['--version'],
    });
  });

  it('refuses a missing bin', () => {
    expect(() => exec()).toThrow(/requires an executable/u);
    expect(() => exec('--')).toThrow(/Name the executable/u);
    expect(() => exec('--path', 'x')).toThrow(/requires an executable/u);
  });

  it('refuses an unknown option before the bin', () => {
    expect(() => exec('--watch', 'tsc')).toThrow(
      /Unknown option --watch for opm exec/u,
    );
  });

  it('refuses opm options placed before the command name', () => {
    expect(() => parseExecRequest(['--path=x'], ['tsc'])).toThrow(
      /Put --path after the command name/u,
    );
  });
});

describe('asksForHelp', () => {
  it("is opm's help for run until --", () => {
    expect(asksForHelp('run', ['--help'])).toBe(true);
    expect(asksForHelp('run', ['test', '-h'])).toBe(true);
    expect(asksForHelp('run', ['test', '--', '--help'])).toBe(false);
    expect(asksForHelp('run', ['test'])).toBe(false);
  });

  it("is opm's help for exec only before the bin", () => {
    expect(asksForHelp('exec', ['--help'])).toBe(true);
    expect(asksForHelp('exec', ['--path', 'x', '-h'])).toBe(true);
    expect(asksForHelp('exec', ['vitest', '--help'])).toBe(false);
    expect(asksForHelp('exec', ['--', '--help'])).toBe(false);
    expect(asksForHelp('exec', [])).toBe(false);
  });
});
