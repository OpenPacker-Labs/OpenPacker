import { join } from 'node:path';
import type { PolicyInput } from '@openpacker/contracts';
import { OpmError, runSandboxedPackageProcess } from '@openpacker/opm-project';

export const EXIT_CODES = {
  success: 0,
  usage: 2,
  invalidInput: 3,
  notFound: 4,
  unsatisfiable: 5,
  policyDenied: 6,
  verificationFailed: 7,
  unavailable: 8,
  internal: 9,
} as const;

export interface CliIo {
  stdout: Pick<NodeJS.WriteStream, 'write'>;
  stderr: Pick<NodeJS.WriteStream, 'write'>;
}

/**
 * Run an entry point with whatever interpreter its ecosystem needs.
 *
 * npm ships a script Node executes; a Python console script is a module and a
 * callable, with no file to point at. Dispatching here is what lets one runner
 * serve both rather than only finding npm packages runnable.
 */
export async function spawnDeclared(
  bin: { path: string; interpreter?: string; entry?: string; name: string },
  storePath: string,
  args: readonly string[],
  io: CliIo,
  cwd: string,
  runtimePaths: readonly string[] = [storePath],
  packageId?: string,
  policy?: PolicyInput,
  projectRoot?: string,
): Promise<number> {
  const sandboxCtx = {
    storePaths: runtimePaths.length > 0 ? runtimePaths : [storePath],
    ...(!(projectRoot === undefined) && { projectRoot }),
    ...(!(packageId === undefined) && { packageId }),
    ...(!(policy === undefined) && { policy }),
  };
  if (bin.interpreter === 'python') {
    const [moduleName, callable] = (bin.entry ?? '').split(':');
    if (!moduleName || !callable)
      throw new OpmError(
        'NOT_FOUND',
        `${bin.name} declares an unusable entry point: ${bin.entry ?? '(none)'}`,
      );
    // Every store root in the runtime closure goes on sys.path so transitive
    // dependencies resolved into the tool cache are importable.
    const roots = runtimePaths.length > 0 ? runtimePaths : [storePath];
    const inserts = roots
      .map((root) => `sys.path.insert(0, ${JSON.stringify(root)})`)
      .join('\n');
    const program =
      'import sys\n' +
      `${inserts}\n` +
      `from ${moduleName} import ${callable} as _entry\n` +
      'sys.exit(_entry())\n';
    return spawnProcess(
      pythonExecutable(),
      ['-c', program, ...args],
      io,
      cwd,
      sandboxCtx,
      `${bin.name} needs a Python interpreter on PATH`,
    );
  }
  if (bin.interpreter === 'dotnet') {
    // A .NET tool is a managed assembly; `dotnet` is the runner its own
    // manifest names.
    const assembly = join(storePath, ...bin.path.split('/').filter(Boolean));
    return spawnProcess(
      process.env.OPM_DOTNET?.trim() || 'dotnet',
      [assembly, ...args],
      io,
      cwd,
      sandboxCtx,
      `${bin.name} needs the .NET runtime on PATH`,
    );
  }
  if (bin.interpreter === 'native') {
    // A native tool needs no interpreter: the verified store file is itself
    // the program, run through the same sandbox funnel as everything else.
    const target = join(storePath, ...bin.path.split('/').filter(Boolean));
    return spawnProcess(
      target,
      args,
      io,
      cwd,
      sandboxCtx,
      `${bin.name} is missing from the tool cache`,
    );
  }
  const target = join(storePath, ...bin.path.split('/').filter(Boolean));
  return spawnTool(target, args, io, cwd, sandboxCtx);
}

/** The Python to run console scripts with. */
function pythonExecutable(): string {
  return process.env.OPM_PYTHON?.trim() || 'python3';
}

/**
 * Run a resolved executable and forward its exit status.
 *
 * Shared by both paths so an ephemeral tool behaves exactly like an installed
 * one: same stdio, same signal handling, same exit code. Execution goes
 * through the project sandbox funnel (ADR 0036).
 */
export async function spawnTool(
  target: string,
  args: readonly string[],
  io: CliIo,
  cwd: string,
  sandbox?: {
    projectRoot?: string;
    storePaths?: readonly string[];
    packageId?: string;
    policy?: PolicyInput;
  },
): Promise<number> {
  return spawnProcess(process.execPath, [target, ...args], io, cwd, sandbox);
}

async function spawnProcess(
  command: string,
  argv: readonly string[],
  io: CliIo,
  cwd: string,
  sandbox?: {
    projectRoot?: string;
    storePaths?: readonly string[];
    packageId?: string;
    policy?: PolicyInput;
  },
  missingHint?: string,
): Promise<number> {
  try {
    const outcome = await runSandboxedPackageProcess({
      argv: [command, ...argv],
      cwd,
      ...(!(sandbox?.projectRoot === undefined) && {
        projectRoot: sandbox.projectRoot,
      }),
      ...(!(sandbox?.storePaths === undefined) && {
        storePaths: sandbox.storePaths,
      }),
      ...(!(sandbox?.packageId === undefined) && {
        packageId: sandbox.packageId,
      }),
      ...(!(sandbox?.policy === undefined) && { policy: sandbox.policy }),
    });
    if (outcome.stdout) io.stdout.write(outcome.stdout);
    if (outcome.stderr) io.stderr.write(outcome.stderr);
    if (
      outcome.exitCode !== 0 &&
      outcome.backend === 'none' &&
      !outcome.enforced
    ) {
      // fail-closed already threw SANDBOX_UNAVAILABLE for required mode;
      // degraded path still returns exit codes.
    }
    return outcome.exitCode;
  } catch (error) {
    if (error instanceof OpmError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    const missing =
      error instanceof Error &&
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      (error as NodeJS.ErrnoException).code === 'ENOENT';
    io.stderr.write(
      `opmx: ${missing && missingHint ? `${missingHint} (${command} not found)` : message}\n`,
    );
    return missing && missingHint
      ? EXIT_CODES.unavailable
      : EXIT_CODES.internal;
  }
}
