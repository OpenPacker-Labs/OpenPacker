/**
 * Which command line is `opm run` or `opm exec` (ADR 0053), before anything
 * heavy is loaded.
 *
 * `run` and `exec` are answered by the process entry itself. The scripts moved
 * to opm were written for pnpm and npm, which accept their workspace options
 * before the command (`pnpm --filter a run build`, `pnpm -r exec tsc`) and a
 * script or executable name where a command goes (`pnpm build`,
 * `pnpm --filter a build`, `npm test`). This reads those spellings and says
 * what they mean, in opm's own order (`run <options> <script> -- <args>`).
 *
 * Nothing here imports a workspace package or reads a file unless a word that
 * is no command could be a script, so the entry stays as cheap as it was.
 */
import { resolve } from 'node:path';
import { COMMANDS } from './command-names.js';
import { asksForHelp } from './run-args.js';
import { usageError } from './run-error.js';
import { selectionArity } from './run-select-args.js';

export interface RoutedRun {
  command: 'run' | 'exec';
  /** The tokens after the command name, in the order `run` and `exec` read them. */
  rest: string[];
  /** The word was no command: a script by that name, else an executable. */
  fallbackExec: boolean;
}

const PATH_ALIASES = ['-C', '--dir', '--prefix'];

/** The tokens a leading option takes, or 0 when opm does not read it before a command. */
function leadingWidth(token: string): number {
  if (PATH_ALIASES.includes(token)) return 2;
  if (PATH_ALIASES.some((flag) => token.startsWith(`${flag}=`))) return 1;
  return selectionArity(token);
}

const AMBIGUOUS_ROOT =
  "-w means the workspace root to pnpm and selects a workspace by name or directory to npm; opm reads npm's, so write --workspace-root for the root, or -w <name>";

/**
 * pnpm takes its workspace options before any command; here only `run` and
 * `exec` read them. In front of another command the full command line would
 * drop them (or take the command for the option's value: `opm -r install`
 * printed the usage and exited 0), so the entry says so instead.
 */
function refuseBeforeCommand(lead: readonly string[], command: string): Error {
  const option = lead[0] ?? '';
  const name = option.split('=')[0] ?? option;
  return usageError(
    PATH_ALIASES.includes(name)
      ? `${name} sets the project directory for opm run and opm exec; opm ${command} takes --path <dir> after the command name`
      : `${name} selects workspace members for opm run and opm exec; opm ${command} does not take it`,
  );
}

/** A word that could be a script or an executable of the project here. */
async function definedHere(word: string, cwd: string): Promise<boolean> {
  const paths = await import('./run-paths.js');
  if (/[\\/\0]/u.test(word)) return false;
  const root = (await paths.findProjectRoot(cwd)) ?? resolve(cwd);
  const { readPackageFile } = await import('./run-package.js');
  const pkg = await readPackageFile(root).catch(() => undefined);
  if (pkg?.scripts.has(word) === true) return true;
  const found = await paths.resolveBin(word, paths.binDirectories(root), {
    platform: process.platform,
    pathext: process.env.PATHEXT,
  });
  return found.found !== undefined;
}

/** What follows a shorthand word goes to the script, minus one `--` straight after it. */
function shorthand(
  lead: readonly string[],
  word: string,
  after: readonly string[],
): RoutedRun {
  const args = after[0] === '--' ? after.slice(1) : after;
  return {
    command: 'run',
    rest: [...lead, word, ...(args.length === 0 ? [] : ['--', ...args])],
    fallbackExec: true,
  };
}

/** The options before the command that opm reads, and where the command word is; `undefined` when one is not opm's. */
function readLeading(
  argv: readonly string[],
): { lead: string[]; at: number } | undefined {
  const lead: string[] = [];
  let at = 0;
  while ((argv[at] ?? '').startsWith('-')) {
    const token = argv[at] ?? '';
    if (token === '-w' && (argv[at + 1] === 'run' || argv[at + 1] === 'exec'))
      throw usageError(AMBIGUOUS_ROOT);
    const width = leadingWidth(token);
    if (width === 0 || at + width > argv.length) return undefined;
    lead.push(...argv.slice(at, at + width));
    at += width;
  }
  return { lead, at };
}

/** `run` or `exec` named in full; a request for help goes to the full command line. */
function named(
  command: 'run' | 'exec',
  lead: readonly string[],
  after: readonly string[],
): RoutedRun | undefined {
  return asksForHelp(command, after)
    ? undefined
    : { command, rest: [...lead, ...after], fallbackExec: false };
}

/**
 * Decide whether `argv` is a `run` or `exec`, and in what shape. `undefined`
 * means "not one of these": the full command line handles it, and reports an
 * unknown word as unknown.
 */
export async function routeRun(
  argv: readonly string[],
  cwd: string,
): Promise<RoutedRun | undefined> {
  const leading = readLeading(argv);
  const word = leading === undefined ? undefined : argv[leading.at];
  if (leading === undefined || word === undefined) return undefined;
  const after = argv.slice(leading.at + 1);
  if (word === 'run' || word === 'exec')
    return named(word, leading.lead, after);
  if (COMMANDS.has(word)) {
    if (leading.lead.length > 0) throw refuseBeforeCommand(leading.lead, word);
    return undefined;
  }
  // A word that is no command is a script or an executable of this project:
  // always when pnpm-style options came first, and otherwise only if it is
  // one, so that a mistyped command is still reported as an unknown command.
  if (leading.lead.length > 0 || (await definedHere(word, cwd)))
    return shorthand(leading.lead, word, after);
  return undefined;
}

const FETCH_HINT =
  'opm has no such command. opm exec <bin> starts an installed executable; opmx <package> fetches a package and runs it in the sandbox';

/** Why a foreign command word is not an opm command, for words people carry over from pnpm and npm. */
export function unknownCommandHint(word: string): string | undefined {
  if (['dlx', 'npx', 'pnpx', 'x'].includes(word))
    return `"${word}": ${FETCH_HINT}`;
  if (word === 'create')
    return `"create": ${FETCH_HINT} (opmx create-<name> for a create- package)`;
  return undefined;
}
