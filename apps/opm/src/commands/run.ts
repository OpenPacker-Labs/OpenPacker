/**
 * `opm run` and `opm exec`: the project's own scripts and `.bin` executables,
 * started with the person's authority (ADR 0047).
 *
 * Neither command loads an adapter or a plugin, reads a registry, installs
 * anything, runs a dependency's lifecycle script, or goes through the
 * sandbox. What they start is the person's code in the person's package.json,
 * or an executable `opm sync` laid out in `node_modules/.bin`.
 */
import { join, resolve } from 'node:path';
import { RunError } from './run-error.js';
import {
  parseExecRequest,
  parseRunRequest,
  type ExecRequest,
  type RunRequest,
} from './run-args.js';
import { planBin } from './run-command-line.js';
import {
  exitStatus,
  runChild,
  type ChildIo,
  type ChildOutcome,
} from './run-child.js';
import { processContext, type RunContext } from './run-context.js';
import {
  describeEnd,
  readPackageFile,
  runScriptSteps,
  type PackageFile,
} from './run-package.js';
import {
  binDirectories,
  binNameProblem,
  findProjectRoot,
  scriptEnvironment,
} from './run-paths.js';
import { missingBinError, resolveExecutable } from './run-resolve.js';

export { processContext, type RunContext } from './run-context.js';

/** `--path` is the project exactly; otherwise the opm project, else here. */
async function projectDirectory(
  path: string | undefined,
  cwd: string,
): Promise<string> {
  if (path !== undefined) return resolve(cwd, path);
  return (await findProjectRoot(cwd)) ?? resolve(cwd);
}

function oneLine(command: string): string {
  return command.replace(/\r?\n/gu, '\\n');
}

function listScripts(pkg: PackageFile, io: ChildIo): number {
  let listed = 0;
  for (const [name, command] of pkg.scripts)
    if (typeof command === 'string') {
      io.stdout.write(`${name}\t${oneLine(command)}\n`);
      listed += 1;
    }
  if (listed === 0) io.stdout.write('(no scripts)\n');
  return 0;
}

export async function runScriptCommand(
  request: RunRequest,
  io: ChildIo,
  cwd: string,
  context: RunContext = processContext(),
): Promise<number> {
  const root = await projectDirectory(request.path, cwd);
  const pkg = await readPackageFile(root);
  if (pkg === undefined)
    throw new RunError(
      'NOT_FOUND',
      `No package.json in ${root}; opm run reads the scripts of the project's package.json (--path <dir> names another)`,
    );
  if (request.script === undefined) return listScripts(pkg, io);

  const script = request.script;
  if (!pkg.scripts.has(script)) {
    if (request.ifPresent) return 0;
    const names = [...pkg.scripts.keys()];
    throw new RunError(
      'NOT_FOUND',
      `No script "${script}" in ${join(root, 'package.json')}` +
        (names.length === 0
          ? ' (it has no scripts)'
          : `; it has: ${names.slice(0, 12).join(', ')}${names.length > 12 ? ', ...' : ''}`),
    );
  }
  const result = await runScriptSteps({
    dir: root,
    pkg,
    script,
    args: request.args,
    io,
    start: (spec, streams) => runChild(spec, streams, context.host),
    initCwd: resolve(cwd),
    context,
  });
  if (result.failure !== undefined) io.stderr.write(`opm: ${result.failure}\n`);
  return result.status;
}

export async function runExecCommand(
  request: ExecRequest,
  io: ChildIo,
  cwd: string,
  context: RunContext = processContext(),
): Promise<number> {
  const problem = binNameProblem(request.bin, context.platform);
  if (problem !== undefined)
    throw new RunError('USAGE', `Cannot exec "${request.bin}": ${problem}`);
  const root = await projectDirectory(request.path, cwd);
  const binDirs = binDirectories(root);
  const resolution = await resolveExecutable(request.bin, binDirs, context);
  if (resolution.found === undefined)
    throw await missingBinError(root, request.bin, resolution);

  // package.json only names the run in the environment; a broken one must not
  // stop an executable that needs nothing from it.
  const pkg = await readPackageFile(root).catch(() => undefined);
  const env = scriptEnvironment({
    base: context.env,
    binDirs,
    event: 'exec',
    packageName: pkg?.name,
    packageVersion: pkg?.version,
    initCwd: resolve(cwd),
    platform: context.platform,
  });
  const plan = planBin(resolution.found, request.args, {
    platform: context.platform,
    comspec: context.env.ComSpec ?? context.env.COMSPEC,
  });
  const outcome: ChildOutcome = await runChild(
    {
      plan,
      cwd: request.path === undefined ? resolve(cwd) : root,
      env,
      label: `"${request.bin}"`,
    },
    io,
    context.host,
  );
  if (outcome.code === undefined)
    io.stderr.write(`opm: ${describeEnd(`"${request.bin}"`, outcome)}\n`);
  return exitStatus(outcome);
}

/** The entry `opm` uses: parse the tokens around the command name, then run. */
export async function runProjectCommand(
  command: 'run' | 'exec',
  head: readonly string[],
  rest: readonly string[],
  io: ChildIo,
  cwd: string,
  context: RunContext = processContext(),
): Promise<number> {
  return command === 'run'
    ? await runScriptCommand(parseRunRequest(head, rest), io, cwd, context)
    : await runExecCommand(parseExecRequest(head, rest), io, cwd, context);
}
