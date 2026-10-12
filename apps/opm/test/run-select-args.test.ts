import { describe, expect, it } from 'vitest';
import {
  asksForHelp,
  parseExecRequest,
  parseRunRequest,
} from '../src/commands/run-args.js';
import { selectionArity } from '../src/commands/run-select-args.js';

const run = (...rest: string[]) => parseRunRequest([], rest);
const exec = (...rest: string[]) => parseExecRequest([], rest);

describe('selection options of opm run', () => {
  it('has no selection when none is given, so the project runs as before', () => {
    expect(run('build').select).toBeUndefined();
    expect(run('build', '--silent', '-s').select).toBeUndefined();
  });

  it('reads --filter, -F and --filter= in order, repeated', () => {
    expect(
      run('build', '--filter', 'a', '-F', 'b...', '--filter=!c').select
        ?.filters,
    ).toEqual(['a', 'b...', '!c']);
  });

  it('reads -r and --recursive', () => {
    expect(run('build', '-r').select?.recursive).toBe(true);
    expect(run('build', '--recursive').select?.recursive).toBe(true);
  });

  it("reads npm's -w, --workspace and --workspaces", () => {
    expect(
      run('build', '-w', 'a', '--workspace', 'b', '--workspace=c').select
        ?.workspaces,
    ).toEqual(['a', 'b', 'c']);
    expect(run('build', '--workspaces').select?.allWorkspaces).toBe(true);
    expect(run('build', '-ws').select?.allWorkspaces).toBe(true);
  });

  it('reads --workspace-root and --include-workspace-root', () => {
    expect(run('build', '--workspace-root').select?.workspaceRoot).toBe(true);
    expect(
      run('build', '-r', '--include-workspace-root').select?.includeRoot,
    ).toBe(true);
  });

  it('reads the order and output options', () => {
    expect(run('build', '-r', '--no-sort', '--stream').select).toMatchObject({
      noSort: true,
      stream: true,
    });
    expect(run('build', '-r', '--reverse').select?.reverse).toBe(true);
    expect(run('build', '--parallel', '-r').select?.parallel).toBe(true);
    expect(run('build', '-r', '--aggregate-output').select).toMatchObject({
      stream: false,
    });
  });

  it.each([
    [['--workspace-concurrency', '3'], 3],
    [['--workspace-concurrency=3'], 3],
    [['--workspace-concurrency=0'], 0],
    [['--workspace-concurrency=-1'], -1],
    [['--workspace-concurrency', '-2'], -2],
  ])('reads %j as a concurrency of %i', (tokens, expected) => {
    expect(run('build', '-r', ...tokens).select?.concurrency).toBe(expected);
  });

  it('refuses a concurrency that is not a whole number, and options without a value', () => {
    expect(() => run('build', '-r', '--workspace-concurrency=many')).toThrow(
      /whole number/u,
    );
    expect(() => run('build', '--filter')).toThrow(
      /--filter requires a value/u,
    );
    expect(() => run('build', '--filter', '--if-present')).toThrow(
      /--filter requires a value/u,
    );
    expect(() => run('build', '--filter=')).toThrow(
      /--filter requires a value/u,
    );
  });

  it('keeps reading the script, --if-present and --path with a selection', () => {
    expect(
      run('build', '-r', '--if-present', '--path', 'x', '--', 'a'),
    ).toMatchObject({
      script: 'build',
      ifPresent: true,
      path: 'x',
      args: ['a'],
    });
  });

  it('does not read selection options after --', () => {
    expect(run('build', '--', '-r', '--filter', 'a')).toMatchObject({
      args: ['-r', '--filter', 'a'],
    });
    expect(run('build', '--', '-r').select).toBeUndefined();
  });

  it('reads pnpm and npm spellings of the project directory as --path', () => {
    expect(run('build', '-C', 'x').path).toBe('x');
    expect(run('build', '--dir', 'x').path).toBe('x');
    expect(run('build', '--dir=x').path).toBe('x');
    expect(run('build', '--prefix', 'x').path).toBe('x');
    expect(run('build', '--prefix=x').path).toBe('x');
    expect(() => run('build', '-C')).toThrow(/-C requires a directory/u);
    expect(() => run('build', '--dir=')).toThrow(/--dir requires a directory/u);
  });
});

describe('what a selection refuses', () => {
  it.each([
    [['--include-workspace-root'], '--include-workspace-root'],
    [['--parallel'], '--parallel'],
    [['--stream'], '--stream'],
    [['--no-sort'], '--no-sort'],
    [['--reverse'], '--reverse'],
    [['--workspace-concurrency=2'], '--workspace-concurrency'],
  ])('%j without -r, --filter, --workspace or --workspaces', (tokens, flag) => {
    expect(() => run('build', ...tokens)).toThrow(
      new RegExp(`${flag} needs members to act on`, 'u'),
    );
  });

  it.each([
    [['--filter', 'a', '-w', 'b'], /two ways to choose members/u],
    [['--filter', 'a', '--workspaces'], /two ways to choose members/u],
    [['-r', '-w', 'a'], /dependency order and --workspace/u],
    [['-r', '--workspaces'], /dependency order and --workspace/u],
    [['--workspace-root', '-r'], /workspace root alone/u],
    [['--workspace-root', '--filter', 'a'], /workspace root alone/u],
    [
      ['-r', '--parallel', '--no-sort'],
      /--parallel starts every member at once/u,
    ],
    [
      ['-r', '--parallel', '--workspace-concurrency=2'],
      /--parallel starts every member at once/u,
    ],
    [
      ['-r', '--no-sort', '--reverse'],
      /--reverse reverses the dependency order/u,
    ],
  ])('%j, which contradict each other', (tokens, message) => {
    expect(() => run('build', ...tokens)).toThrow(message);
  });

  it('says what -w means here when it has no name to take, and names the pnpm spelling', () => {
    expect(() => run('build', '-w')).toThrow(/--workspace-root for the root/u);
    expect(() => run('build', '-w', '--if-present')).toThrow(/-w <name>/u);
  });

  it.each([
    ['--no-bail', /no --no-bail/u],
    ['--filter-prod', /--filter-prod is not supported/u],
    ['--resume-from=a', /--resume-from is not supported/u],
    ['--report-summary', /--report-summary is not supported/u],
    ['--reporter=silent', /one output format/u],
    ['--test-pattern', /git history/u],
    ['--sequential', /--workspace-concurrency=1/u],
  ])('names the pnpm option %s instead of dropping it', (flag, message) => {
    expect(() => run('build', '-r', flag)).toThrow(message);
  });

  it('still refuses an option it has never heard of', () => {
    expect(() => run('build', '-r', '--watch')).toThrow(
      /Unknown option --watch for opm run/u,
    );
  });
});

describe('selection options of opm exec', () => {
  it('reads them before the bin and hands everything after the bin to it', () => {
    const request = exec(
      '--filter',
      'a...',
      '-r',
      '--workspace-concurrency=2',
      'vitest',
      'run',
      '--filter',
      'x',
      '-r',
    );
    expect(request.bin).toBe('vitest');
    expect(request.args).toEqual(['run', '--filter', 'x', '-r']);
    expect(request.select).toMatchObject({
      filters: ['a...'],
      recursive: true,
      concurrency: 2,
    });
  });

  it('has no selection when none is given', () => {
    expect(exec('vitest').select).toBeUndefined();
  });

  it('reads --workspace-root and the npm spellings before the bin', () => {
    expect(
      exec('--workspace-root', 'biome', 'format').select?.workspaceRoot,
    ).toBe(true);
    expect(exec('-w', 'a', 'tsc').select?.workspaces).toEqual(['a']);
    expect(exec('--workspaces', 'tsc').select?.allWorkspaces).toBe(true);
  });

  it('refuses pnpm shell mode: exec starts a program, never a line', () => {
    expect(() => exec('-c', 'echo hi')).toThrow(/never a shell line/u);
    expect(() => exec('--shell-mode', 'echo')).toThrow(/never a shell line/u);
  });

  it('reads -C and --dir before the bin', () => {
    expect(exec('-C', 'pkg', 'tsc').path).toBe('pkg');
    expect(exec('--dir=pkg', 'tsc').path).toBe('pkg');
  });

  it('asks for opm help only before the bin, skipping the values of its options', () => {
    expect(asksForHelp('exec', ['--filter', 'a', '-h'])).toBe(true);
    expect(asksForHelp('exec', ['--filter', '-h'])).toBe(false);
    expect(asksForHelp('exec', ['-r', '--help'])).toBe(true);
    expect(asksForHelp('exec', ['-C', 'x', '--help'])).toBe(true);
    expect(asksForHelp('exec', ['-r', 'vitest', '--help'])).toBe(false);
  });
});

describe('selectionArity', () => {
  it('is the number of tokens an option takes, and 0 for what is not one', () => {
    expect(selectionArity('-r')).toBe(1);
    expect(selectionArity('--filter')).toBe(2);
    expect(selectionArity('--filter=a')).toBe(1);
    expect(selectionArity('--parallel=1')).toBe(0);
    expect(selectionArity('--offline')).toBe(0);
    expect(selectionArity('build')).toBe(0);
  });
});
