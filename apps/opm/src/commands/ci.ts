import { resolve } from 'node:path';
import {
  OpmError,
  installFrozen,
  planFrozen,
  type FrozenInstallInput,
  type FrozenPlan,
  type FrozenWorkspaceRequest,
} from '@openpacker/opm-project';
import {
  detectNativeTarget,
  type FrozenOmit,
  type NativeTarget,
} from '@openpacker/adapter-core';
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
  if (args.options.get('filter') === true)
    throw new OpmError(
      'INVALID_SPEC',
      'opm ci --filter needs a selector (a name, a glob, ./dir, name..., !name)',
    );
  const filter = args.optionValues.get('filter') ?? [];
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
    ...(filter.length > 0 && { filter }),
    ...(booleanOption(args, 'include-workspace-root') === true && {
      includeRoot: true,
    }),
    ...(workspaces === true && { all: true }),
    ...(ignore && { ignore: true }),
  };
}

const PLATFORM_WORD = /^[A-Za-z0-9_-]+$/u;

/** The values of a repeatable platform option, `current` being this machine's. */
function platformValues(args: CiArgs, name: string): string[] {
  if (args.options.get(name) === true)
    throw new OpmError(
      'INVALID_SPEC',
      `opm ci --${name} needs a value (or "current" for this machine)`,
    );
  const values = (args.optionValues.get(name) ?? []).flatMap((item) =>
    item.split(',').map((part) => part.trim()),
  );
  for (const value of values)
    if (!PLATFORM_WORD.test(value))
      throw new OpmError(
        'INVALID_SPEC',
        `opm ci --${name} ${JSON.stringify(value)} is not a platform name`,
      );
  return values;
}

/**
 * `--os`, `--cpu` and `--libc` (repeatable, `current` for this machine) replace
 * a dimension of the machines to install optional packages for, as pnpm's
 * `supportedArchitectures` does; `--supported-architectures project` takes the
 * project's own. A package is installed when it runs on any one machine.
 */
function platformRequest(
  args: CiArgs,
): Pick<FrozenInstallInput, 'targets' | 'architectures'> {
  const os = platformValues(args, 'os');
  const cpu = platformValues(args, 'cpu');
  const libc = platformValues(args, 'libc');
  const given = os.length + cpu.length + libc.length > 0;
  const source = args.options.get('supported-architectures');
  if (source !== undefined) {
    if (source !== 'project')
      throw new OpmError(
        'INVALID_SPEC',
        `opm ci --supported-architectures takes "project", not ${JSON.stringify(source)}`,
      );
    if (given)
      throw new OpmError(
        'INVALID_SPEC',
        'Pass either --supported-architectures project or --os, --cpu and --libc, not both',
      );
    return { architectures: 'project' };
  }
  if (!given) return {};
  const host = detectNativeTarget();
  const now = (value: string, current: string | undefined) =>
    value === 'current' ? current : value;
  const targets: NativeTarget[] = [];
  for (const o of os.length > 0 ? os : ['current'])
    for (const c of cpu.length > 0 ? cpu : ['current'])
      for (const l of libc.length > 0 ? libc : ['current']) {
        const machine: NativeTarget = {
          os: now(o, host.os)!,
          architecture: now(c, host.architecture)!,
        };
        const lib = machine.os === 'linux' ? now(l, host.libc) : undefined;
        if (lib !== undefined) machine.libc = lib;
        if (
          !targets.some(
            (t) =>
              t.os === machine.os &&
              t.architecture === machine.architecture &&
              t.libc === machine.libc,
          )
        )
          targets.push(machine);
      }
  return { targets };
}

function describeTargets(targets: readonly NativeTarget[]): string {
  return targets
    .map(
      (t) =>
        `${t.os}/${t.architecture}${t.libc === undefined ? '' : `/${t.libc}`}`,
    )
    .join(', ');
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
function leftOut(result: Pick<FrozenPlan, 'skipped'>): string | undefined {
  const counts = new Map<keyof typeof WHY, number>();
  for (const item of result.skipped)
    counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
  if (counts.size === 0) return undefined;
  return [...counts]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([kind, count]) => `${count} ${WHY[kind]}`)
    .join(', ');
}

/** What `opm ci --plan` says: the install up to the first byte fetched, and nothing done. */
function printPlan(plan: FrozenPlan, io: CommandIo, root: string): void {
  io.stdout.write(
    `Plan for ${resolve(root)} (${plan.lockPath}): nothing was fetched or written\n` +
      `  ${plan.instances} package${plan.instances === 1 ? '' : 's'} in ${plan.places} place${plan.places === 1 ? '' : 's'} under node_modules, from ${plan.archives} archive${plan.archives === 1 ? '' : 's'}, in ${(plan.milliseconds / 1000).toFixed(1)} s\n`,
  );
  const clause = leftOut(plan);
  if (clause !== undefined) io.stdout.write(`  left out: ${clause}\n`);
  if (plan.targets !== undefined)
    io.stdout.write(`  platforms: ${describeTargets(plan.targets)}\n`);
  if (plan.workspace !== undefined)
    io.stdout.write(
      `  workspace: ${plan.workspace.installed} of ${plan.workspace.members} member${plan.workspace.members === 1 ? '' : 's'} installed, ${plan.workspace.linked} linked at the project\n`,
    );
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
  const request: FrozenInstallInput = {
    root,
    omit: omitted(args),
    workspace: workspaceRequest(args),
    ...platformRequest(args),
    ...(offline && { offline: true }),
    ...(args.options.has('online') && { offline: false }),
    ...(options.fetch !== undefined && { fetch: options.fetch }),
  };
  if (args.options.has('plan')) {
    printPlan(await planFrozen(request), io, root);
    return 0;
  }
  const result = await installFrozen(request);

  const noScripts = result.installScripts.length;
  io.stdout.write(
    `Installed ${result.installed} package${result.installed === 1 ? '' : 's'} into ${resolve(root, 'node_modules')} ` +
      `(${result.fromStore} from the store, ${result.fetched} fetched, ${megabytes(result.fetchedBytes)}) ` +
      `in ${(result.milliseconds.total / 1000).toFixed(1)} s; ` +
      `${noScripts} ${noScripts === 1 ? 'declares an install script' : 'declare install scripts'}, which opm does not run\n`,
  );
  const clause = leftOut(result);
  if (clause !== undefined) io.stdout.write(`  left out: ${clause}\n`);
  if (result.targets !== undefined)
    io.stdout.write(`  platforms: ${describeTargets(result.targets)}\n`);
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
