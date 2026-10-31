import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { outRaw } from '@openpacker/canonical';
import type { PolicyInput } from '@openpacker/contracts';
import {
  OpmError,
  ephemeralNodeRun,
  runSandboxedPackageProcess,
  stoppedBySignal,
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

/** How opmx ends when the reader of its output went away: as SIGPIPE ends a writer, 128 + 13. */
export const BROKEN_PIPE_EXIT = 141;

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
  /**
   * Wall-clock milliseconds, 0 or absent for none: what `opmxRunTimeout` says
   * for a project's tool, `--timeout` for one straight from a registry.
   */
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
 *
 * When the reader of either stream goes away (it fails, EPIPE once `head -1`
 * has its line, or is destroyed), nothing more is written to either, and
 * `gone` is called once: the caller ends the tool as a shell pipeline would.
 * `release` removes what is listened for on the streams.
 */
export function passedOn(
  io: CliIo,
  gone: () => void = () => undefined,
): {
  sink: {
    stdout(chunk: Uint8Array): Promise<void> | undefined;
    stderr(chunk: Uint8Array): Promise<void> | undefined;
  };
  end(): void;
  out(text: string): void;
  err(text: string): void;
  /** Whether a reader went away. */
  lost(): boolean;
  release(): void;
} {
  const out = new StringDecoder('utf8');
  const err = new StringDecoder('utf8');
  let lost = false;
  const lose = () => {
    if (lost) return;
    lost = true;
    gone();
  };
  const watching = [watchReader(io.stdout, lose), watchReader(io.stderr, lose)];
  /** Whether nothing more is to be written: a reader went away, or `stream` is destroyed. */
  const closed = (stream: unknown) => {
    // SAFETY: only `destroyed` is read, a boolean on every Node stream.
    if ((stream as { destroyed?: unknown }).destroyed === true) lose();
    return lost;
  };
  const toOut = (written: string) =>
    written === '' || closed(io.stdout)
      ? undefined
      : whenTaken(io.stdout, outRaw(io, written));
  const toErr = (written: string) =>
    written === '' || closed(io.stderr)
      ? undefined
      : whenTaken(io.stderr, io.stderr.write(written));
  return {
    sink: {
      stdout: (chunk) => toOut(out.write(chunk)),
      stderr: (chunk) => toErr(err.write(chunk)),
    },
    end: () => {
      void toOut(out.end());
      void toErr(err.end());
    },
    out: (text) => void toOut(text),
    err: (text) => void toErr(text),
    lost: () => lost,
    release: () => {
      for (const stop of watching) stop();
    },
  };
}

/**
 * Calls `lose` once `stream` fails or closes, which is how a pipe says its
 * reader went away; returns what stops listening. A stream that is not an
 * event emitter (a test's) is not listened to.
 */
function watchReader(stream: unknown, lose: () => void): () => void {
  // SAFETY: only `on` and `off` are used, and only where the stream has both.
  const { on, off } = stream as { on?: unknown; off?: unknown };
  if (typeof on !== 'function' || typeof off !== 'function')
    return () => undefined;
  on.call(stream, 'error', lose);
  on.call(stream, 'close', lose);
  return () => {
    off.call(stream, 'error', lose);
    off.call(stream, 'close', lose);
  };
}

/** What ends a wait on a stream that asked to be waited for. */
const TAKEN = ['drain', 'close', 'error', 'finish'] as const;

/**
 * Nothing when `stream` took what was written (`wrote`); when it asked to wait,
 * a promise that settles once it drains, or once it closes or fails, after
 * which nothing more will wait on it. The first of those removes the
 * listeners for the others: a pipe that is behind asks again and again, and a
 * wait must leave nothing on it. A stream that is not an event emitter (a
 * test's) is never waited on.
 */
function whenTaken(stream: unknown, wrote: boolean): Promise<void> | undefined {
  if (wrote !== false) return undefined;
  // SAFETY: only `once` and `off` are used, and only where the stream has both.
  const { once, off } = stream as { once?: unknown; off?: unknown };
  if (typeof once !== 'function' || typeof off !== 'function') return undefined;
  return new Promise<void>((resolve) => {
    const settle = () => {
      for (const event of TAKEN) off.call(stream, event, settle);
      resolve();
    };
    for (const event of TAKEN) once.call(stream, event, settle);
  });
}

async function spawnProcess(
  command: string,
  argv: readonly string[],
  io: CliIo,
  cwd: string,
  sandbox?: SandboxContext,
  missingHint?: string,
): Promise<number> {
  // The reader of opmx's output going away ends the tool as a shell pipeline
  // ends a writer: by SIGPIPE, and then as any run is ended.
  const broken = new AbortController();
  const passing = passedOn(io, () => broken.abort(stoppedBySignal('SIGPIPE')));
  const signal =
    sandbox?.signal === undefined
      ? broken.signal
      : AbortSignal.any([sandbox.signal, broken.signal]);
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
      signal,
      ...(!(sandbox?.pathPrefix === undefined) && {
        pathPrefix: sandbox.pathPrefix,
      }),
      timeoutMs: sandbox?.timeoutMs ?? 0,
      ...(sandbox?.network === true && { network: true }),
      // Without network the tool has a namespace of its own: a server it
      // starts is reached by nothing outside, and says nothing of it.
      onIsolatedListen: (port) =>
        io.stderr.write(
          report(
            'opmx: ',
            `the tool listens on port ${port}; nothing outside its sandbox can reach it. If you meant to reach it from this host, --allow-network shares this host's network, which also gives the tool outbound network and this host's loopback services.`,
          ),
        ),
      // The tool's output reaches the terminal as the tool writes it: a
      // server prints that it listens and then serves until it is stopped.
      output: passing.sink,
    }).finally(passing.end);
    // Silent, as a pipeline is: whoever reads opmx has gone.
    if (passing.lost()) return BROKEN_PIPE_EXIT;
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
  } finally {
    passing.release();
  }
}
