/**
 * How `opm run` and `opm exec` hand a command to the operating system
 * (ADR 0047).
 *
 * POSIX: a script goes to `/bin/sh -c`, its extra arguments as positional
 * parameters so the shell never re-reads them; a bin is executed directly.
 *
 * Windows: Node refuses to start a `.cmd` or `.bat` file without a shell, so a
 * script, and any bin that is a batch file, goes to
 * `cmd.exe /d /s /c "<line>"`. `cmd.exe` and then the program (or the batch
 * file's own `%*`) each read the line, so an argument is quoted for the C
 * runtime and every `cmd.exe` metacharacter in it is escaped with `^`; a
 * target that is a batch file reads the line twice, so it is escaped twice.
 * A real `.exe` is started directly, with no shell at all.
 *
 * The planners are pure and take the platform as a value, so their output is
 * tested on every host. The Windows plans have been checked against the
 * quoting rules only; they have not been run on Windows here.
 */
import { RunError } from './run-error.js';

export interface SpawnPlan {
  file: string;
  args: string[];
  /** Pass `args` to `CreateProcess` as written; the line is already quoted. */
  windowsVerbatimArguments: boolean;
}

/** Characters `cmd.exe` acts on outside quotes, and the quote that opens a quoted run. */
const CMD_META = /[ !%^&()<>|"]/gu;

/**
 * One argument, safe inside a `cmd.exe /d /s /c` line.
 *
 * Step one is the C runtime's rule (backslashes are literal except before a
 * quote, where they double; a quote becomes `\"`; the whole thing is wrapped in
 * quotes when it holds white space or a quote). Step two caret-escapes every
 * metacharacter, quotes included, so `cmd.exe` never enters quote mode and
 * never sees an operator. `doubleEscape` repeats step two for a batch file,
 * which reads the same text again through `%*`.
 */
export function escapeCmdArgument(arg: string, doubleEscape = false): string {
  if (/[\r\n\0]/u.test(arg))
    throw new RunError(
      'USAGE',
      'An argument holds a line break or a NUL, which cmd.exe cannot carry to a program',
    );
  if (arg === '') return '""';
  let quoted = arg;
  if (/[ \t\v"]/u.test(arg)) {
    quoted = '"';
    for (let index = 0; index <= arg.length; index += 1) {
      let backslashes = 0;
      while (arg[index] === '\\') {
        index += 1;
        backslashes += 1;
      }
      if (index === arg.length) {
        quoted += '\\'.repeat(backslashes * 2);
        break;
      }
      quoted +=
        arg[index] === '"'
          ? `${'\\'.repeat(backslashes * 2 + 1)}"`
          : `${'\\'.repeat(backslashes)}${arg[index]}`;
    }
    quoted += '"';
  }
  let escaped = quoted.replace(CMD_META, '^$&');
  if (doubleEscape) escaped = escaped.replace(CMD_META, '^$&');
  return escaped;
}

/** The first word of a script, as `cmd.exe` would read it (quotes group). */
export function firstWord(script: string): string {
  let word = '';
  let quoted = false;
  for (const character of script.trimStart()) {
    if (character === '"') quoted = !quoted;
    else if (/\s/u.test(character) && !quoted) break;
    else word += character;
  }
  return word;
}

/** Whether a resolved file is a batch file, which `cmd.exe` must run. */
export function isBatchFile(file: string): boolean {
  return /\.(?:cmd|bat)$/iu.test(file);
}

function commandInterpreter(comspec: string | undefined): string {
  return comspec && comspec !== '' ? comspec : 'cmd.exe';
}

function cmdLine(line: string, comspec: string | undefined): SpawnPlan {
  return {
    file: commandInterpreter(comspec),
    args: ['/d', '/s', '/c', `"${line}"`],
    windowsVerbatimArguments: true,
  };
}

export interface ScriptPlanInput {
  platform: NodeJS.Platform;
  /** `ComSpec` on Windows. */
  comspec?: string | undefined;
  /** Whether the script's first command is a batch file (see {@link isBatchFile}). */
  firstIsBatch?: boolean;
}

/**
 * A `scripts` entry plus the arguments after `--`, appended to the script as
 * npm appends them: they reach whatever the script's last command is.
 */
export function planScript(
  script: string,
  extra: readonly string[],
  input: ScriptPlanInput,
): SpawnPlan {
  if (input.platform === 'win32') {
    const escaped = extra.map((arg) =>
      escapeCmdArgument(arg, input.firstIsBatch === true),
    );
    return cmdLine([script, ...escaped].join(' '), input.comspec);
  }
  if (script.includes('\0'))
    throw new RunError('INVALID_MANIFEST', 'A script contains a NUL byte');
  return {
    file: '/bin/sh',
    // `$0` is `sh`, as it is under `sh -c` from npm. The arguments stay
    // positional parameters, so no quoting of theirs is ever needed.
    args:
      extra.length === 0
        ? ['-c', script]
        : ['-c', `${script} "$@"`, 'sh', ...extra],
    windowsVerbatimArguments: false,
  };
}

export interface BinPlanInput {
  platform: NodeJS.Platform;
  comspec?: string | undefined;
}

/** An executable found in `.bin`, run with the arguments after `--`. */
export function planBin(
  file: string,
  extra: readonly string[],
  input: BinPlanInput,
): SpawnPlan {
  if (input.platform !== 'win32' || !isBatchFile(file))
    return { file, args: [...extra], windowsVerbatimArguments: false };
  // Inside quotes `cmd.exe` still expands `%`, and nothing escapes it there.
  if (/[%"\r\n\0]/u.test(file))
    throw new RunError(
      'UNSAFE_PATH',
      `Cannot run a batch file whose path contains % or a quote through cmd.exe: ${file}`,
    );
  return cmdLine(
    [`"${file}"`, ...extra.map((arg) => escapeCmdArgument(arg, true))].join(
      ' ',
    ),
    input.comspec,
  );
}
