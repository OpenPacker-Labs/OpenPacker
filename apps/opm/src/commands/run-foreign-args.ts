/**
 * A command line of `npm`, `pnpm` or `yarn`, read as the tool reads it and
 * said again in `opm run`'s grammar (ADR 0061).
 *
 * Only what runs a script is translated: npm's `run` (`run-script`, `rum`,
 * `urn`), `test` (`t`, `tst`), `start`, `stop` and `restart`; pnpm's `run`,
 * those four, and `pnpm <script>`; yarn's `run <script>` and `yarn <script>`.
 * Each tool's arguments for the script go where it puts them:
 *
 * - npm: the positional words after the script's name and everything after
 *   `--`. Any other option before `--` is npm's own setting, which opm does not
 *   read, so it is refused rather than dropped.
 * - pnpm: everything after the script's name, verbatim, `--` included
 *   (measured on pnpm 10.28.0); its own options come before the name.
 * - yarn: plain words only. Yarn 1 drops a `--` and reads options before it
 *   (measured on 1.22.22) and later releases do not, so a `--` or an option
 *   after the name is refused: no one translation is faithful to both.
 *
 * Every other command, and every option opm does not read, is refused with
 * what to run instead; nothing is passed on to the tool.
 */
import { usageError } from './run-error.js';
import {
  isRefusedCommand,
  refusal,
  type ForeignTool,
} from './run-foreign-refusals.js';

export type { ForeignTool } from './run-foreign-refusals.js';

export interface ForeignRun {
  /** What follows `opm run`: options, the script, then `--` and its arguments. */
  rest: string[];
  /** A word that names a script or else an installed executable (`pnpm <x>`, `yarn <x>`). */
  fallbackExec: boolean;
  /** The project directory the command line named (`--prefix`, `-C`, `--dir`, `--cwd`). */
  path?: string;
  /** Whether options chose workspace members, which are the workspace root's. */
  selects: boolean;
}

interface OptionSpec {
  value: boolean;
  /** opm's spelling, where it differs. */
  opm?: string;
  /** The project directory, not an option opm passes on. */
  path?: boolean;
  /** It chooses workspace members. */
  selects?: boolean;
}

const flag = (extra: Partial<OptionSpec> = {}): OptionSpec => ({
  value: false,
  ...extra,
});
const valued = (extra: Partial<OptionSpec> = {}): OptionSpec => ({
  value: true,
  ...extra,
});

/** The options of each tool that `opm run` reads, under the tool's own spelling. */
const OPTIONS: Readonly<
  Record<ForeignTool, Readonly<Record<string, OptionSpec>>>
> = {
  npm: {
    '-w': valued({ selects: true }),
    '--workspace': valued({ selects: true }),
    '--workspaces': flag({ selects: true }),
    '-ws': flag({ selects: true }),
    '--include-workspace-root': flag(),
    '--if-present': flag(),
    '-s': flag(),
    '--silent': flag(),
    '--prefix': valued({ path: true }),
    '-C': valued({ path: true }),
  },
  pnpm: {
    '--filter': valued({ selects: true }),
    '-F': valued({ selects: true }),
    '-r': flag({ selects: true }),
    '--recursive': flag({ selects: true }),
    // pnpm's -w is the workspace root; opm's -w is npm's.
    '-w': flag({ opm: '--workspace-root', selects: true }),
    '--workspace-root': flag({ selects: true }),
    '--include-workspace-root': flag(),
    '--parallel': flag(),
    '--stream': flag(),
    '--aggregate-output': flag(),
    '--no-sort': flag(),
    '--reverse': flag(),
    '--workspace-concurrency': valued(),
    '--if-present': flag(),
    '-s': flag(),
    '--silent': flag(),
    '-C': valued({ path: true }),
    '--dir': valued({ path: true }),
  },
  yarn: {
    '-s': flag(),
    '--silent': flag(),
    '--cwd': valued({ path: true }),
  },
};

/** The options read so far, and where the project is. */
interface Read {
  options: string[];
  path?: string;
  selects: boolean;
}

/**
 * Read the option at `tokens[at]` into `read`; returns the tokens it took.
 * An option the tool has that opm does not read is refused, by name.
 */
function readOption(
  tool: ForeignTool,
  tokens: readonly string[],
  at: number,
  read: Read,
  where: string,
): number {
  const token = tokens[at]!;
  const eq = token.startsWith('--') ? token.indexOf('=') : -1;
  const name = eq === -1 ? token : token.slice(0, eq);
  const spec = OPTIONS[tool][name];
  if (spec === undefined || (eq !== -1 && !spec.value))
    throw refusal(
      tool,
      where === '' ? name : `${where} ${name}`,
      `opm does not read ${tool}'s ${name}` +
        (tool === 'npm' && where !== ''
          ? ", which npm takes as its own setting, not the script's; an argument for the script goes after --"
          : ''),
    );
  let value: string | undefined;
  let taken = 1;
  if (spec.value) {
    value = eq === -1 ? tokens[at + 1] : token.slice(eq + 1);
    taken = eq === -1 ? 2 : 1;
    const negative =
      name === '--workspace-concurrency' && /^-\d+$/u.test(value ?? '');
    if (
      value === undefined ||
      value === '' ||
      (value.startsWith('-') && !negative)
    )
      throw usageError(`${tool} ${name} requires a value`);
  }
  if (spec.path === true && value !== undefined) read.path = value;
  else
    read.options.push(
      spec.opm ?? name,
      ...(value === undefined ? [] : [value]),
    );
  if (spec.selects === true) read.selects = true;
  return taken;
}

const isOption = (token: string | undefined): token is string =>
  token !== undefined &&
  token.startsWith('-') &&
  token !== '-' &&
  token !== '--';

/** The options at the start of `tokens`; returns where the first other token is. */
function readLeading(
  tool: ForeignTool,
  tokens: readonly string[],
  read: Read,
  where: string,
): number {
  let at = 0;
  while (isOption(tokens[at])) at += readOption(tool, tokens, at, read, where);
  return at;
}

function routed(
  read: Read,
  script: string | undefined,
  args: readonly string[],
  fallbackExec = false,
): ForeignRun {
  return {
    rest: [
      ...read.options,
      ...(script === undefined ? [] : [script]),
      ...(args.length === 0 ? [] : ['--', ...args]),
    ],
    fallbackExec,
    ...(read.path !== undefined && { path: read.path }),
    selects: read.selects,
  };
}

const NPM_RUN = new Set(['run', 'run-script', 'rum', 'urn']);
const NPM_TEST = new Set(['test', 't', 'tst']);
const LIFECYCLE = new Set(['start', 'stop', 'restart']);

/** npm: options anywhere before `--`, the script's name, then its arguments. */
function npm(argv: readonly string[]): ForeignRun {
  const read: Read = { options: [], selects: false };
  const at = readLeading('npm', argv, read, '');
  const word = argv[at];
  if (word === undefined || word === '--')
    throw refusal('npm', '', 'name the script: npm run <script>');
  let script: string | undefined;
  if (NPM_TEST.has(word)) script = 'test';
  else if (LIFECYCLE.has(word)) script = word;
  else if (!NPM_RUN.has(word)) throw refusal('npm', word);
  const after = argv.slice(at + 1);
  const separator = after.indexOf('--');
  const before = separator === -1 ? after : after.slice(0, separator);
  const args: string[] = [];
  for (let index = 0; index < before.length; ) {
    const token = before[index]!;
    if (isOption(token)) {
      index += readOption('npm', before, index, read, word);
      continue;
    }
    if (script === undefined) script = token;
    else args.push(token);
    index += 1;
  }
  if (separator !== -1) args.push(...after.slice(separator + 1));
  return routed(read, script, args);
}

/** pnpm: its options before the script's name, then everything verbatim. */
function pnpm(argv: readonly string[]): ForeignRun {
  const read: Read = { options: [], selects: false };
  const at = readLeading('pnpm', argv, read, '');
  const word = argv[at];
  if (word === undefined || word === '--')
    throw refusal('pnpm', '', 'name the script: pnpm run <script>');
  const after = argv.slice(at + 1);
  if (word === 'run' || word === 'run-script') {
    const named = readLeading('pnpm', after, read, word);
    const script = after[named];
    if (script === '--')
      throw refusal(
        'pnpm',
        `${word} --`,
        'name the script before its arguments',
      );
    return routed(read, script, after.slice(named + 1));
  }
  if (NPM_TEST.has(word)) return routed(read, 'test', after);
  if (LIFECYCLE.has(word)) return routed(read, word, after);
  if (isRefusedCommand('pnpm', word)) throw refusal('pnpm', word);
  return routed(read, word, after, true);
}

/** yarn: `[workspace <name>] [run] <script> [words]`, with nothing it reads two ways. */
function yarn(argv: readonly string[]): ForeignRun {
  const read: Read = { options: [], selects: false };
  let at = readLeading('yarn', argv, read, '');
  let word = argv[at];
  if (word === 'workspace') {
    const member = argv[at + 1];
    if (member === undefined || isOption(member))
      throw refusal(
        'yarn',
        'workspace',
        'name the member: yarn workspace <name> <script>',
      );
    read.options.push('--workspace', member);
    read.selects = true;
    at += 2;
    word = argv[at];
  }
  if (word === undefined)
    throw refusal('yarn', '', 'install the lock with opm ci');
  let rest = argv.slice(at + 1);
  let fallbackExec = true;
  if (word === 'run') {
    const script = rest[0];
    if (script === undefined || isOption(script) || script === '--')
      throw refusal('yarn', 'run', 'name the script: yarn run <script>');
    word = script;
    rest = rest.slice(1);
    fallbackExec = false;
  } else if (isRefusedCommand('yarn', word)) throw refusal('yarn', word);
  const odd = rest.find((token) => token === '--' || token.startsWith('-'));
  if (odd !== undefined)
    throw refusal(
      'yarn',
      `${word} ${odd}`,
      `Yarn 1 and later releases pass ${odd === '--' ? 'a --' : 'an option'} after the script's name differently, so opm does not guess; write the script as opm run ${word} -- <args>`,
    );
  return routed(read, word, rest, fallbackExec);
}

/** `argv` of `tool`, as `opm run` takes it; a refusal is a `USAGE` RunError. */
export function translateForeign(
  tool: ForeignTool,
  argv: readonly string[],
): ForeignRun {
  switch (tool) {
    case 'npm':
      return npm(argv);
    case 'pnpm':
      return pnpm(argv);
    case 'yarn':
      return yarn(argv);
  }
}
