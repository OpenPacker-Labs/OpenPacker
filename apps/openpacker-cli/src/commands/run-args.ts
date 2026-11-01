/**
 * Arguments of `opm run` and `opm exec`.
 *
 * These two commands pass everything after a point to a program that is not
 * opm, so they do not share the general parser: a flag opm does not know is an
 * error here, never a silent drop, because dropping `--watch` and running the
 * script anyway is the worse failure.
 */
import { usageError as usage } from './run-error.js';
import {
  SelectionParser,
  selectionArity,
  type SelectOptions,
} from './run-select-args.js';

export interface RunRequest {
  /** Absent means "list the scripts". */
  script: string | undefined;
  ifPresent: boolean;
  path: string | undefined;
  /** Everything after `--`, appended to the script as npm appends it. */
  args: string[];
  /** Which workspace members to run in; absent means the project's own package. */
  select?: SelectOptions | undefined;
  /**
   * `opm <word>`: when no script by the name exists, start the executable of
   * that name from `node_modules/.bin`, as pnpm does for a word that is
   * neither a command nor a script.
   */
  fallbackExec?: boolean | undefined;
}

export interface ExecRequest {
  bin: string;
  path: string | undefined;
  args: string[];
  select?: SelectOptions | undefined;
}

/** The spellings of the project directory: opm's own, pnpm's `-C`/`--dir` and npm's `--prefix`. */
const PATH_FLAGS = ['--path', '--dir', '--prefix'] as const;

/**
 * Options opm owns must come after the command: before it they are not seen,
 * and an option dropped without a word is worse than one refused. The process
 * entry moves the pnpm and npm spellings behind the command itself
 * (`run-route.ts`); what reaches here is the rest.
 */
function refuseOptionsBeforeCommand(head: readonly string[]): void {
  const misplaced = head.find((token) => {
    const name = token.split('=')[0] ?? token;
    return (
      name === '--path' ||
      name === '--if-present' ||
      PATH_FLAGS.some((flag) => flag === name) ||
      name === '-C' ||
      selectionArity(token) > 0
    );
  });
  if (misplaced !== undefined)
    throw usage(`Put ${misplaced.split('=')[0]} after the command name`);
}

/** `--path <dir>`, `--path=<dir>` or one of its aliases at `tokens[index]`, else `undefined`. */
function pathOption(
  tokens: readonly string[],
  index: number,
): { value: string; consumed: number } | undefined {
  const token = tokens[index] ?? '';
  for (const flag of PATH_FLAGS)
    if (token.startsWith(`${flag}=`)) {
      const value = token.slice(flag.length + 1);
      if (value === '') throw usage(`${flag} requires a directory`);
      return { value, consumed: 1 };
    }
  if (token !== '-C' && !PATH_FLAGS.some((flag) => flag === token))
    return undefined;
  const value = tokens[index + 1];
  if (value === undefined || value === '' || value.startsWith('--'))
    throw usage(`${token} requires a directory`);
  return { value, consumed: 2 };
}

/**
 * @param head tokens before the command name
 * @param rest tokens after the command name
 */
export function parseRunRequest(
  head: readonly string[],
  rest: readonly string[],
): RunRequest {
  refuseOptionsBeforeCommand(head);
  const separator = rest.indexOf('--');
  const options = separator === -1 ? rest : rest.slice(0, separator);
  const args = separator === -1 ? [] : rest.slice(separator + 1);
  const names: string[] = [];
  const selection = new SelectionParser('run');
  let ifPresent = false;
  let path: string | undefined;
  for (let index = 0; index < options.length; ) {
    const token = options[index] ?? '';
    const found = pathOption(options, index);
    const selected = found === undefined ? selection.accept(options, index) : 0;
    if (found !== undefined) {
      path = found.value;
      index += found.consumed;
    } else if (selected > 0) {
      index += selected;
    } else if (token === '--if-present') {
      ifPresent = true;
      index += 1;
    } else if (token.startsWith('-') && token !== '-') {
      throw usage(
        `Unknown option ${token} for opm run; arguments for the script go after --`,
      );
    } else {
      names.push(token);
      index += 1;
    }
  }
  if (names.length > 1)
    throw usage(
      `opm run takes one script name, not ${names.length}; arguments for the script go after --`,
    );
  const script = names[0];
  if (script === undefined && args.length > 0)
    throw usage('Name the script before --: opm run <script> -- <args>');
  const select = selection.result();
  return select === undefined
    ? { script, ifPresent, path, args }
    : { script, ifPresent, path, args, select };
}

/**
 * `opm exec <bin> [--path <dir>] [-- <args...>]`, the grammar the help shows.
 *
 * A `--path` straight after the bin is opm's, as it is before the bin, so
 * `opm exec tsc --path pkg -- -b` runs `tsc -b` in `pkg`. The program's own
 * arguments start at the first other token, or after a `--`: `opm exec vitest
 * --version` still reaches vitest, and an argument the program calls `--path`
 * is written after `--` (`opm exec tool -- --path x`). One `--` straight after
 * the bin and its options is dropped; any later one is the program's.
 */
export function parseExecRequest(
  head: readonly string[],
  rest: readonly string[],
): ExecRequest {
  refuseOptionsBeforeCommand(head);
  const selection = new SelectionParser('exec');
  let path: string | undefined;
  const request = (bin: string, args: string[]): ExecRequest => {
    const select = selection.result();
    return select === undefined
      ? { bin, path, args }
      : { bin, path, args, select };
  };
  for (let index = 0; index < rest.length; ) {
    const token = rest[index] ?? '';
    const found = pathOption(rest, index);
    if (found !== undefined) {
      path = found.value;
      index += found.consumed;
      continue;
    }
    const selected = selection.accept(rest, index);
    if (selected > 0) {
      index += selected;
      continue;
    }
    if (token === '--') {
      const bin = rest[index + 1];
      if (bin === undefined)
        throw usage('Name the executable: opm exec <bin> [-- <args>]');
      return request(bin, dropSeparator(rest.slice(index + 2)));
    }
    if (token.startsWith('-') && token !== '-')
      throw usage(
        `Unknown option ${token} for opm exec; put options for the executable after its name`,
      );
    let next = index + 1;
    for (
      let found = ownPathOption(rest, next);
      found !== undefined;
      found = ownPathOption(rest, next)
    ) {
      if (path !== undefined)
        throw usage(
          '--path is given twice; an argument for the executable named --path goes after --',
        );
      path = found.value;
      next += found.consumed;
    }
    return request(token, dropSeparator(rest.slice(next)));
  }
  throw usage('opm exec requires an executable: opm exec <bin> [-- <args>]');
}

/** `--path <dir>` or `--path=<dir>` at `tokens[index]`: opm's own spelling only, not pnpm's or npm's. */
function ownPathOption(
  tokens: readonly string[],
  index: number,
): { value: string; consumed: number } | undefined {
  const token = tokens[index] ?? '';
  return token === '--path' || token.startsWith('--path=')
    ? pathOption(tokens, index)
    : undefined;
}

function dropSeparator(args: readonly string[]): string[] {
  return args[0] === '--' ? args.slice(1) : [...args];
}

/** The tokens an option of `exec` takes before the bin, or 0 when `token` is not a value option. */
function optionWidth(token: string): number {
  if (token === '-C' || PATH_FLAGS.some((flag) => flag === token)) return 2;
  const arity = selectionArity(token);
  return arity;
}

/**
 * Whether the person asked opm (not the program) for help.
 *
 * `run` stops reading options at `--`. `exec` hands every flag after the bin
 * to the bin, so `opm exec vitest --help` is vitest's help and only a help flag
 * before the bin name is opm's.
 */
export function asksForHelp(
  command: 'run' | 'exec',
  rest: readonly string[],
): boolean {
  const isHelp = (token: string) => token === '--help' || token === '-h';
  if (command === 'run') {
    const separator = rest.indexOf('--');
    return (separator === -1 ? rest : rest.slice(0, separator)).some(isHelp);
  }
  for (let index = 0; index < rest.length; ) {
    const token = rest[index] ?? '';
    if (isHelp(token)) return true;
    const width = optionWidth(token);
    if (width > 0) index += width;
    else if (token.startsWith('-') && token !== '--') index += 1;
    else return false;
  }
  return false;
}
