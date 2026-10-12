/**
 * Arguments of `opm run` and `opm exec`.
 *
 * These two commands pass everything after a point to a program that is not
 * opm, so they do not share the general parser: a flag opm does not know is an
 * error here, never a silent drop, because dropping `--watch` and running the
 * script anyway is the worse failure.
 */
import { RunError } from './run-error.js';

export interface RunRequest {
  /** Absent means "list the scripts". */
  script: string | undefined;
  ifPresent: boolean;
  path: string | undefined;
  /** Everything after `--`, appended to the script as npm appends it. */
  args: string[];
}

export interface ExecRequest {
  bin: string;
  path: string | undefined;
  args: string[];
}

function usage(message: string): RunError {
  return new RunError('USAGE', `${message} (opm --help shows the usage)`);
}

/** Options opm owns must come after the command: before it they are not seen. */
function refuseOptionsBeforeCommand(head: readonly string[]): void {
  const misplaced = head.find(
    (token) =>
      token === '--path' ||
      token.startsWith('--path=') ||
      token === '--if-present',
  );
  if (misplaced !== undefined)
    throw usage(`Put ${misplaced.split('=')[0]} after the command name`);
}

/** `--path <dir>` or `--path=<dir>` at `tokens[index]`, else `undefined`. */
function pathOption(
  tokens: readonly string[],
  index: number,
): { value: string; consumed: number } | undefined {
  const token = tokens[index] ?? '';
  if (token.startsWith('--path=')) {
    const value = token.slice('--path='.length);
    if (value === '') throw usage('--path requires a directory');
    return { value, consumed: 1 };
  }
  if (token !== '--path') return undefined;
  const value = tokens[index + 1];
  if (value === undefined || value === '' || value.startsWith('--'))
    throw usage('--path requires a directory');
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
  let ifPresent = false;
  let path: string | undefined;
  for (let index = 0; index < options.length; ) {
    const token = options[index] ?? '';
    const found = pathOption(options, index);
    if (found !== undefined) {
      path = found.value;
      index += found.consumed;
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
  return { script, ifPresent, path, args };
}

/**
 * `exec` hands everything after the bin name to the bin, `--` or not, so
 * `opm exec vitest --version` reaches vitest. One `--` straight after the bin
 * is dropped, which keeps `opm exec vitest -- --version` working too.
 */
export function parseExecRequest(
  head: readonly string[],
  rest: readonly string[],
): ExecRequest {
  refuseOptionsBeforeCommand(head);
  let path: string | undefined;
  for (let index = 0; index < rest.length; ) {
    const token = rest[index] ?? '';
    const found = pathOption(rest, index);
    if (found !== undefined) {
      path = found.value;
      index += found.consumed;
      continue;
    }
    if (token === '--') {
      const bin = rest[index + 1];
      if (bin === undefined)
        throw usage('Name the executable: opm exec <bin> [-- <args>]');
      return { bin, path, args: dropSeparator(rest.slice(index + 2)) };
    }
    if (token.startsWith('-') && token !== '-')
      throw usage(
        `Unknown option ${token} for opm exec; put options for the executable after its name`,
      );
    return { bin: token, path, args: dropSeparator(rest.slice(index + 1)) };
  }
  throw usage('opm exec requires an executable: opm exec <bin> [-- <args>]');
}

function dropSeparator(args: readonly string[]): string[] {
  return args[0] === '--' ? args.slice(1) : [...args];
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
    if (token === '--path') index += 2;
    else if (token.startsWith('-') && token !== '--') index += 1;
    else return false;
  }
  return false;
}
