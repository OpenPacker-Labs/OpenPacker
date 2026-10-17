/**
 * The options of `opm run` and `opm exec` that choose workspace members
 * (ADR 0053): pnpm's `--filter`, `-r`, `--parallel`, `--stream`, `--no-sort`,
 * `--reverse` and `--workspace-concurrency`, npm's `-w`/`--workspace` and
 * `--workspaces`, and `--include-workspace-root` and `--workspace-root`.
 *
 * Both tools' spellings are read, because the scripts to be moved were written
 * for them. `-w` is the one clash: npm's takes a name, pnpm's means the root,
 * and opm reads npm's (pnpm's is `--workspace-root`).
 */
import { usageError } from './run-error.js';

export interface SelectOptions {
  /** `--filter` selectors, pnpm's grammar, in the order written. */
  filters: string[];
  /** `-w` / `--workspace` values: a name or a directory, npm's. */
  workspaces: string[];
  /** `--workspaces`: every member, in declaration order. */
  allWorkspaces: boolean;
  /** `-r`: every member, dependencies first. */
  recursive: boolean;
  /** `--workspace-root`: the workspace root alone. */
  workspaceRoot: boolean;
  includeRoot: boolean;
  parallel: boolean;
  stream: boolean;
  noSort: boolean;
  reverse: boolean;
  /** As written; `workspaceConcurrency` turns it into a number of members. */
  concurrency: number | undefined;
}

export function emptySelectOptions(): SelectOptions {
  return {
    filters: [],
    workspaces: [],
    allWorkspaces: false,
    recursive: false,
    workspaceRoot: false,
    includeRoot: false,
    parallel: false,
    stream: false,
    noSort: false,
    reverse: false,
    concurrency: undefined,
  };
}

/** Options that take a value, in either `--name value` or `--name=value` form. */
const VALUE_OPTIONS = new Set([
  '--filter',
  '-F',
  '--workspace',
  '-w',
  '--workspace-concurrency',
]);

/** Options that stand alone. `--silent` is accepted and changes nothing: opm prints no banner. */
const FLAG_OPTIONS = new Set([
  '-r',
  '--recursive',
  '--workspaces',
  '-ws',
  '--workspace-root',
  '--include-workspace-root',
  '--parallel',
  '--stream',
  '--aggregate-output',
  '--no-sort',
  '--reverse',
  '--silent',
  '-s',
]);

/** pnpm options a script author may carry over; each is refused by name rather than dropped. */
const REFUSED: Readonly<Record<string, string>> = {
  '--no-bail':
    'opm stops launching members at the first failure and has no --no-bail',
  '--filter-prod':
    '--filter-prod is not supported; --filter follows all four dependency lists (ADR 0049)',
  '--resume-from': '--resume-from is not supported',
  '--report-summary': '--report-summary is not supported',
  '--reporter': 'opm has one output format (--stream or grouped)',
  '--loglevel': 'opm has no log levels; it prints no banner',
  '--fail-if-no-match':
    'a filter that matches no member already fails (exit 4)',
  '--test-pattern':
    '--test-pattern selects by git history, which is not supported',
  '--changed-files-ignore-pattern':
    '--changed-files-ignore-pattern selects by git history, which is not supported',
  '--use-stderr': '--use-stderr is not supported',
  '--shell-emulator': '--shell-emulator is not supported',
  '--sequential': 'use --workspace-concurrency=1 to run one member at a time',
  '--link-workspace-packages':
    'link-workspace-packages is read from pnpm-workspace.yaml only',
};

/** Refused only by `exec`: pnpm's shell mode runs a command line, which `exec` never does. */
const REFUSED_EXEC: Readonly<Record<string, string>> = {
  '--shell-mode':
    'exec starts a program, never a shell line; put the command in a script and use opm run',
  '-c': 'exec starts a program, never a shell line; put the command in a script and use opm run',
};

const AMBIGUOUS_W =
  "-w selects a workspace by name or directory (npm) and means the workspace root to pnpm; opm reads npm's, so write -w <name>, or --workspace-root for the root";

function nameOf(token: string): { key: string; inline: string | undefined } {
  if (!token.startsWith('--')) return { key: token, inline: undefined };
  const eq = token.indexOf('=');
  return eq === -1
    ? { key: token, inline: undefined }
    : { key: token.slice(0, eq), inline: token.slice(eq + 1) };
}

/** How many tokens a recognised selection option takes, or 0 when it is not one. */
export function selectionArity(token: string): number {
  const { key, inline } = nameOf(token);
  if (VALUE_OPTIONS.has(key)) return inline === undefined ? 2 : 1;
  return FLAG_OPTIONS.has(key) && inline === undefined ? 1 : 0;
}

function integer(text: string, flag: string): number {
  if (!/^-?\d+$/u.test(text))
    throw usageError(
      `${flag} takes a whole number, not ${JSON.stringify(text)}`,
    );
  return Number(text);
}

/** Reads selection options out of a token list, one at a time. */
export class SelectionParser {
  private readonly options = emptySelectOptions();

  constructor(private readonly command: 'run' | 'exec') {}

  /** Consume the option at `tokens[index]` if it is one; returns the tokens taken (0: not one). */
  accept(tokens: readonly string[], index: number): number {
    const token = tokens[index] ?? '';
    const { key, inline } = nameOf(token);
    const refused =
      REFUSED[key] ?? (this.command === 'exec' ? REFUSED_EXEC[key] : undefined);
    if (refused !== undefined && token.startsWith('-'))
      throw usageError(`${key} is not supported: ${refused}`);
    if (key === '-w' && inline === undefined && !this.hasValue(tokens, index))
      throw usageError(AMBIGUOUS_W);
    if (VALUE_OPTIONS.has(key))
      return this.takeValue(tokens, index, key, inline);
    if (!FLAG_OPTIONS.has(key) || inline !== undefined) return 0;
    this.setFlag(key);
    return 1;
  }

  private hasValue(tokens: readonly string[], index: number): boolean {
    const value = tokens[index + 1];
    return value !== undefined && value !== '' && !value.startsWith('-');
  }

  private takeValue(
    tokens: readonly string[],
    index: number,
    key: string,
    inline: string | undefined,
  ): number {
    let value = inline;
    let taken = 1;
    if (value === undefined) {
      value = tokens[index + 1];
      taken = 2;
      const negativeNumber =
        key === '--workspace-concurrency' && /^-\d+$/u.test(value ?? '');
      if (
        value === undefined ||
        value === '' ||
        (value.startsWith('-') && !negativeNumber)
      )
        throw usageError(`${key} requires a value`);
    }
    if (value === '') throw usageError(`${key} requires a value`);
    if (key === '--filter' || key === '-F') this.options.filters.push(value);
    else if (key === '--workspace' || key === '-w')
      this.options.workspaces.push(value);
    else this.options.concurrency = integer(value, key);
    return taken;
  }

  private setFlag(key: string): void {
    const o = this.options;
    if (key === '-r' || key === '--recursive') o.recursive = true;
    else if (key === '--workspaces' || key === '-ws') o.allWorkspaces = true;
    else if (key === '--workspace-root') o.workspaceRoot = true;
    else if (key === '--include-workspace-root') o.includeRoot = true;
    else if (key === '--parallel') o.parallel = true;
    else if (key === '--stream') o.stream = true;
    else if (key === '--no-sort') o.noSort = true;
    else if (key === '--reverse') o.reverse = true;
    // --aggregate-output is the default; --silent changes nothing.
  }

  /** The options read, or `undefined` when none chose members. Refuses contradictions. */
  result(): SelectOptions | undefined {
    const o = this.options;
    const chooses =
      o.filters.length > 0 ||
      o.workspaces.length > 0 ||
      o.allWorkspaces ||
      o.recursive ||
      o.workspaceRoot;
    const modifiers = [
      o.includeRoot && '--include-workspace-root',
      o.parallel && '--parallel',
      o.stream && '--stream',
      o.noSort && '--no-sort',
      o.reverse && '--reverse',
      o.concurrency !== undefined && '--workspace-concurrency',
    ].filter((name): name is string => name !== false);
    if (!chooses) {
      if (modifiers.length > 0)
        throw usageError(
          `${modifiers[0]} needs members to act on: add -r, --filter <selector>, --workspace <name> or --workspaces`,
        );
      return undefined;
    }
    const npmStyle = o.workspaces.length > 0 || o.allWorkspaces;
    if (npmStyle && o.filters.length > 0)
      throw usageError(
        '--filter (pnpm) and --workspace/--workspaces (npm) are two ways to choose members; use one',
      );
    if (npmStyle && o.recursive)
      throw usageError(
        '-r runs members in dependency order and --workspace/--workspaces in declaration order; use one',
      );
    if (o.workspaceRoot && (npmStyle || o.recursive || o.filters.length > 0))
      throw usageError('--workspace-root runs in the workspace root alone');
    if (o.parallel && (o.noSort || o.reverse || o.concurrency !== undefined))
      throw usageError(
        '--parallel starts every member at once and ignores order and concurrency; drop --no-sort, --reverse and --workspace-concurrency',
      );
    if (o.noSort && o.reverse)
      throw usageError(
        '--reverse reverses the dependency order that --no-sort turns off',
      );
    return { ...o, filters: [...o.filters], workspaces: [...o.workspaces] };
  }
}
