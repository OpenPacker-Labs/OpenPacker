import { resolve } from 'node:path';
import {
  OpmError,
  installFrozen,
  type FrozenInstallResult,
  type FrozenWorkspaceRequest,
} from '@openpacker/opm-project';
import type { FrozenOmit } from '@openpacker/adapter-core';
import type { CommandArgs, CommandIo } from './yank.js';

/** What `opm ci` accepts beyond the shared argument shape. */
export interface CiArgs extends CommandArgs {
  optionValues: ReadonlyMap<string, string[]>;
}

export interface CiOptions {
  /** Network seam for tests; production resolves and pins real addresses. */
  fetch?: typeof fetch;
}

const OMITTABLE = new Set<FrozenOmit>(['dev', 'optional', 'peer']);

function omitted(args: CiArgs): FrozenOmit[] {
  const kinds = new Set<FrozenOmit>();
  if (args.options.has('production')) kinds.add('dev');
  const named = args.optionValues.get('omit') ?? [];
  if (args.options.has('omit') && named.length === 0)
    throw new OpmError(
      'INVALID_SPEC',
      'opm ci --omit needs a kind: dev, optional or peer',
    );
  for (const value of named.flatMap((item) => item.split(','))) {
    const kind = value.trim() as FrozenOmit;
    if (!OMITTABLE.has(kind))
      throw new OpmError(
        'INVALID_SPEC',
        `opm ci cannot omit "${value}"; the kinds are dev, optional and peer`,
      );
    kinds.add(kind);
  }
  return [...kinds];
}

/** A flag npm reads as a boolean: bare, or `=true` or `=false`. */
function booleanOption(args: CiArgs, name: string): boolean | undefined {
  const value = args.options.get(name);
  if (value === undefined) return undefined;
  if (value === true || value === 'true') return true;
  if (value === 'false') return false;
  throw new OpmError(
    'INVALID_SPEC',
    `opm ci --${name} takes true or false, not ${JSON.stringify(value)}`,
  );
}

/**
 * `--workspace <name|dir>` (`-w`, repeatable), `--include-workspace-root`,
 * `--workspaces` and `--workspaces=false` (or `--no-workspaces`), as `npm ci`
 * reads them. Anything else about workspaces is refused rather than guessed.
 */
function workspaceRequest(args: CiArgs): FrozenWorkspaceRequest {
  if (args.options.get('workspace') === true)
    throw new OpmError(
      'INVALID_SPEC',
      'opm ci --workspace needs a member name or directory',
    );
  const select = args.optionValues.get('workspace') ?? [];
  const workspaces = booleanOption(args, 'workspaces');
  const noWorkspaces = args.options.has('no-workspaces');
  if (noWorkspaces && workspaces === true)
    throw new OpmError(
      'INVALID_SPEC',
      'Pass only one of --workspaces or --no-workspaces',
    );
  const ignore = workspaces === false || noWorkspaces;
  return {
    ...(select.length > 0 && { select }),
    ...(booleanOption(args, 'include-workspace-root') === true && {
      includeRoot: true,
    }),
    ...(workspaces === true && { all: true }),
    ...(ignore && { ignore: true }),
  };
}

function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const WHY = {
  omitted: 'left out by --omit',
  platform: 'optional, for another platform',
  orphaned: 'needed only by those',
  bundled: "shipped inside a parent's archive",
  workspace: 'outside the workspaces selected',
} as const;

/** How many packages were left out, and for what, in a clause. */
function leftOut(result: FrozenInstallResult): string | undefined {
  const counts = new Map<keyof typeof WHY, number>();
  for (const item of result.skipped)
    counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
  if (counts.size === 0) return undefined;
  return [...counts]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([kind, count]) => `${count} ${WHY[kind]}`)
    .join(', ');
}

/**
 * `opm ci`, and `opm install --frozen`: install exactly what a committed lock
 * says, resolving nothing and running nothing.
 */
export async function runCiCommand(
  args: CiArgs,
  io: CommandIo,
  cwd: string,
  options: CiOptions = {},
): Promise<number> {
  const path = args.options.get('path');
  const root = resolve(cwd, typeof path === 'string' ? path : '.');
  if (args.positionals.length > 0)
    throw new OpmError(
      'INVALID_SPEC',
      `opm ci installs a lock and takes no package names or other arguments (got ${args.positionals.map((item) => JSON.stringify(item)).join(', ')})`,
    );
  const offline = args.options.has('offline');
  if (offline && args.options.has('online'))
    throw new OpmError(
      'INVALID_SPEC',
      'Pass only one of --offline or --online',
    );
  const result = await installFrozen({
    root,
    omit: omitted(args),
    workspace: workspaceRequest(args),
    ...(offline && { offline: true }),
    ...(args.options.has('online') && { offline: false }),
    ...(options.fetch !== undefined && { fetch: options.fetch }),
  });

  const noScripts = result.installScripts.length;
  io.stdout.write(
    `Installed ${result.installed} package${result.installed === 1 ? '' : 's'} into ${resolve(root, 'node_modules')} ` +
      `(${result.fromStore} from the store, ${result.fetched} fetched, ${megabytes(result.fetchedBytes)}) ` +
      `in ${(result.milliseconds.total / 1000).toFixed(1)} s; ` +
      `${noScripts} ${noScripts === 1 ? 'declares an install script' : 'declare install scripts'}, which opm does not run\n`,
  );
  const clause = leftOut(result);
  if (clause !== undefined) io.stdout.write(`  left out: ${clause}\n`);
  if (result.workspace !== undefined)
    io.stdout.write(
      `  workspace: ${result.workspace.linked} of ${result.workspace.members} member${result.workspace.members === 1 ? '' : 's'} linked, not fetched; their scripts are not run\n`,
    );
  const shown = result.installScripts.slice(0, 50);
  for (const item of shown)
    io.stdout.write(`  install script not run: ${item.name}@${item.version}\n`);
  if (noScripts > shown.length)
    io.stdout.write(`  ... and ${noScripts - shown.length} more\n`);
  for (const entry of result.layout.skipped ?? [])
    io.stderr.write(`opm: skipped ${entry.path}: ${entry.reason}\n`);
  for (const loss of result.layout.semanticLoss)
    if (loss.severity !== 'info')
      io.stderr.write(
        `opm: ${loss.code}${loss.representedMeaning ? `: ${loss.representedMeaning}` : ''}\n`,
      );
  return 0;
}
