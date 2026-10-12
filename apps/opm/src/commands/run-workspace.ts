/**
 * `opm run` and `opm exec` across the members of a workspace (ADR 0053).
 *
 * `run.ts` reaches this file only when a selection option was given; a plain
 * `opm run build` never loads it, nor the workspace library behind it.
 *
 * Member scripts run unsandboxed with the person's authority, as the project's
 * own do (ADR 0047): they are the `scripts` of `package.json` files the person
 * checked out, found without following a link, and a dependency's lifecycle
 * scripts are not among them.
 */
import { resolve } from 'node:path';
import type { ExecRequest, RunRequest } from './run-args.js';
import { exitStatus, type ChildIo, type ChildSpec } from './run-child.js';
import type { RunContext } from './run-context.js';
import { RunError } from './run-error.js';
import { runMembers, type MemberTask } from './run-members.js';
import { readMemberPackage } from './run-member-files.js';
import { planBin } from './run-command-line.js';
import {
  assertStringSteps,
  describeEnd,
  runScriptSteps,
  type PackageFile,
} from './run-package.js';
import {
  binDirectories,
  binNameProblem,
  scriptEnvironment,
} from './run-paths.js';
import { resolveExecutable } from './run-resolve.js';
import {
  planWorkspace,
  type PlannedMember,
  type WorkspacePlan,
} from './run-select.js';
import type { SelectOptions } from './run-select-args.js';

/** Members' packages are read this many at a time. */
const READ_BATCH = 32;

async function readPackages(
  plan: WorkspacePlan,
): Promise<Map<string, PackageFile | undefined>> {
  const packages = new Map<string, PackageFile | undefined>();
  for (let at = 0; at < plan.members.length; at += READ_BATCH) {
    const batch = plan.members.slice(at, at + READ_BATCH);
    const read = await Promise.all(
      batch.map((member) => readMemberPackage(plan.root, member.dir)),
    );
    batch.forEach((member, index) => packages.set(member.dir, read[index]));
  }
  return packages;
}

function nameList(members: readonly PlannedMember[], limit = 5): string {
  const shown = members.slice(0, limit).map((member) => member.label);
  return members.length > limit
    ? `${shown.join(', ')} and ${members.length - limit} more`
    : shown.join(', ');
}

export async function runScriptInWorkspace(
  request: RunRequest,
  select: SelectOptions,
  root: string,
  io: ChildIo,
  cwd: string,
  context: RunContext,
): Promise<number> {
  const script = request.script;
  if (script === undefined)
    throw new RunError(
      'USAGE',
      'Name the script to run in the selected members: opm run <script> --filter <selector> (opm --help shows the usage)',
    );
  const plan = await planWorkspace(
    select,
    root,
    request.path !== undefined,
    cwd,
    context,
  );
  const packages = await readPackages(plan);
  const having = plan.members.filter((member) =>
    packages.get(member.dir)?.scripts.has(script),
  );
  if (having.length === 0) {
    if (request.ifPresent) return 0;
    throw new RunError(
      'NOT_FOUND',
      `None of the ${plan.members.length} selected members has a "${script}" script (${nameList(plan.members)})`,
    );
  }
  for (const member of having)
    assertStringSteps(member.abs, packages.get(member.dir)!, script);
  const initCwd = resolve(cwd);
  const tasks: MemberTask[] = plan.members.map((member) => {
    const pkg = packages.get(member.dir);
    const runs = having.includes(member);
    return {
      member,
      runs,
      work: async (env) =>
        await runScriptSteps(
          {
            dir: member.abs,
            pkg: pkg!,
            script,
            args: request.args,
            io: env.io,
            start: env.start,
            initCwd,
            context,
            stdin: env.stdin,
            stopped: env.stopped,
          },
          member.label,
        ),
    };
  });
  return await runMembers(plan, tasks, io, context);
}

export async function runExecInWorkspace(
  request: ExecRequest,
  select: SelectOptions,
  root: string,
  io: ChildIo,
  cwd: string,
  context: RunContext,
): Promise<number> {
  const problem = binNameProblem(request.bin, context.platform);
  if (problem !== undefined)
    throw new RunError('USAGE', `Cannot exec "${request.bin}": ${problem}`);
  const plan = await planWorkspace(
    select,
    root,
    request.path !== undefined,
    cwd,
    context,
  );
  const found = new Map<string, string>();
  const missing: PlannedMember[] = [];
  for (const member of plan.members) {
    const resolution = await resolveExecutable(
      request.bin,
      binDirectories(member.abs),
      context,
    );
    if (resolution.found === undefined) missing.push(member);
    else found.set(member.dir, resolution.found);
  }
  if (missing.length > 0)
    throw new RunError(
      'NOT_FOUND',
      `"${request.bin}" is not in node_modules/.bin of ${missing.length} of the ${plan.members.length} selected members or of any parent directory (${nameList(missing)}); exec never fetches or searches PATH. Add the package that provides it and run: opm sync`,
    );
  const initCwd = resolve(cwd);
  const tasks: MemberTask[] = [];
  for (const member of plan.members) {
    // package.json only names the run in the environment; a broken one must
    // not stop an executable that needs nothing from it.
    const pkg = await readMemberPackage(plan.root, member.dir).catch(
      () => undefined,
    );
    const file = found.get(member.dir)!;
    tasks.push({
      member,
      runs: true,
      work: async (env) => {
        const label = `"${request.bin}" in ${member.label}`;
        const binDirs = binDirectories(member.abs);
        const spec: ChildSpec = {
          plan: planBin(file, request.args, {
            platform: context.platform,
            comspec: context.env.ComSpec ?? context.env.COMSPEC,
          }),
          cwd: member.abs,
          env: scriptEnvironment({
            base: context.env,
            binDirs,
            event: 'exec',
            packageName: pkg?.name,
            packageVersion: pkg?.version,
            initCwd,
            platform: context.platform,
          }),
          label,
        };
        if (env.stdin !== undefined) spec.stdin = env.stdin;
        const outcome = await env.start(
          spec,
          typeof env.io === 'function' ? env.io(request.bin) : env.io,
        );
        const status = exitStatus(outcome);
        return status === 0
          ? { status: 0 }
          : { status, failure: describeEnd(label, outcome) };
      },
    });
  }
  return await runMembers(plan, tasks, io, context);
}
