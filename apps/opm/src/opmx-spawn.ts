import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { outRaw } from '@openpacker/canonical';
import type { PolicyInput } from '@openpacker/contracts';
import {
  OpmError,
  ephemeralNodeRun,
  runSandboxedPackageProcess,
  type BinDeclaration,
  type EphemeralTool,
  type NodeRun,
} from '@openpacker/opm-project';
import { report } from './error-report.js';

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

/** Where and how a run is sandboxed, beyond its command. */
export interface SandboxContext {
  projectRoot?: string;
  storePaths?: readonly string[];
  packageId?: string;
  policy?: PolicyInput;
  /** Aborted by a signal opmx holds: ends the process tree (opmx-signals.ts). */
  signal?: AbortSignal;
  /** Directories put first on the tool's PATH (its layout's `.bin`). */
  pathPrefix?: readonly string[];
  /** `--timeout`: wall-clock milliseconds, 0 for none; else the project's. */
  timeoutMs?: number;
  /** `--allow-network`: the run shares the host's network. */
  network?: boolean;
}

/**
 * Run a fetched tool's bin. An npm script runs from a node_modules of its
 * closure, written for this run and bound whole, and removed when it ends;
 * anything else runs from the tool cache as it is.
 */
export async function runTool(
  tool: EphemeralTool,
  bin: BinDeclaration,
  args: readonly string[],
  io: CliIo,
  cwd: string,
  context: Pick<SandboxContext, 'signal' | 'timeoutMs' | 'network'> = {},
): Promise<number> {
  return runLaidOut(
    await ephemeralNodeRun(tool, bin),
    { bin, storePath: tool.storePath, runtimePaths: tool.runtimePaths },
    args,
    io,
    cwd,
    { ...context, packageId: tool.exactPurl },
  );
}

/**
 * Run a bin from `layout`, the node_modules its npm script needs, with that
 * layout as the one tree bound and its `.bin` first on PATH, and remove the
 * layout when the run ends; with no layout, run `bin` as it is, from its store
 * tree with `runtimePaths` bound.
 */
export async function runLaidOut(
  layout: NodeRun | undefined,
  as: {
    bin: BinDeclaration;
    storePath: string;
    runtimePaths: readonly string[];
  },
  args: readonly string[],
  io: CliIo,
  cwd: string,
  context: Omit<SandboxContext, 'storePaths' | 'pathPrefix'> = {},
): Promise<number> {
  try {
    return await spawnDeclared(
      layout?.bin ?? as.bin,
      layout?.root ?? as.storePath,
      args,
      io,
      cwd,
      {
        ...context,
        runtimePaths: layout === undefined ? as.runtimePaths : [layout.root],
        ...(!(layout === undefined) && { pathPrefix: [layout.binDirectory] }),
      },
    );
  } finally {
    await layout?.dispose();
  }
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
  context: Omit<SandboxContext, 'storePaths'> & {
    /** Every store root of the closure; the tool's own alone by default. */
    runtimePaths?: readonly string[];
  } = {},
): Promise<number> {
  const { runtimePaths: given, ...rest } = context;
  const runtimePaths = given ?? [storePath];
  const sandboxCtx: SandboxContext = {
    ...rest,
    storePaths: runtimePaths.length > 0 ? runtimePaths : [storePath],
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
  sandbox?: SandboxContext,
): Promise<number> {
  return spawnProcess(process.execPath, [target, ...args], io, cwd, sandbox);
}

/**
 * The tool's own output, handed to opmx's streams as the tool writes it, as
 * text: a character a chunk splits is written whole with the next chunk, and
 * `end` writes what a last chunk left. `out` and `err` write text there too:
 * what the sandbox itself says, after the tool.
 */
function passedOn(io: CliIo): {
  sink: { stdout(chunk: Uint8Array): void; stderr(chunk: Uint8Array): void };
  end(): void;
  out(text: string): void;
  err(text: string): void;
} {
  const out = new StringDecoder('utf8');
  const err = new StringDecoder('utf8');
  const toOut = (written: string) => {
    if (written !== '') outRaw(io, written);
  };
  const toErr = (written: string) => {
    if (written !== '') io.stderr.write(written);
  };
  return {
    sink: {
      stdout: (chunk) => toOut(out.write(chunk)),
      stderr: (chunk) => toErr(err.write(chunk)),
    },
    end: () => {
      toOut(out.end());
      toErr(err.end());
    },
    out: toOut,
    err: toErr,
  };
}

async function spawnProcess(
  command: string,
  argv: readonly string[],
  io: CliIo,
  cwd: string,
  sandbox?: SandboxContext,
  missingHint?: string,
): Promise<number> {
  const passing = passedOn(io);
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
      ...(!(sandbox?.signal === undefined) && { signal: sandbox.signal }),
      ...(!(sandbox?.pathPrefix === undefined) && {
        pathPrefix: sandbox.pathPrefix,
      }),
      ...(!(sandbox?.timeoutMs === undefined) && {
        timeoutMs: sandbox.timeoutMs,
      }),
      ...(sandbox?.network === true && { network: true }),
      // Without network the tool has a namespace of its own: a server it
      // starts is reached by nothing outside, and says nothing of it.
      onIsolatedListen: (port) =>
        io.stderr.write(
          report(
            'opmx: ',
            `the tool listens on port ${port}, but has no network: nothing outside its sandbox can reach it. Run it with --allow-network to share this host's network.`,
          ),
        ),
      // The tool's output reaches the terminal as the tool writes it: a
      // server prints that it listens and then serves until it is stopped.
      output: passing.sink,
    }).finally(passing.end);
    // What the sandbox itself says: a limit reached, a run stopped.
    passing.out(outcome.stdout);
    passing.err(outcome.stderr);
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
      report(
        'opmx: ',
        missing && missingHint
          ? `${missingHint} (${command} not found)`
          : message,
      ),
    );
    return missing && missingHint
      ? EXIT_CODES.unavailable
      : EXIT_CODES.internal;
  }
}
