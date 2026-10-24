import type { BackendProbe, OutputSink, SandboxBackend } from '../types.js';
import {
  BoundedOutput,
  SandboxBackendError,
  type OutputLimitKind,
} from './mock.js';

/**
 * Probe whether @microsoft/mxc-sdk can load and reports platform support.
 *
 * MXC is optional. Offline verify must not require the native binary.
 */
export async function probeMxc(): Promise<BackendProbe> {
  try {
    const mod = await import('@microsoft/mxc-sdk').catch(() => null);
    if (!mod) {
      return {
        id: 'mxc',
        available: false,
        reason: '@microsoft/mxc-sdk not installed or failed to load',
      };
    }
    const support =
      typeof mod.getPlatformSupport === 'function'
        ? mod.getPlatformSupport()
        : { isSupported: false };
    if (!support?.isSupported) {
      return {
        id: 'mxc',
        available: false,
        reason: 'MXC reports this host as unsupported',
      };
    }
    return { id: 'mxc', available: true };
  } catch (error) {
    return {
      id: 'mxc',
      available: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * MXC backend. Uses the SDK when available; throws UNAVAILABLE otherwise.
 *
 * Note: MXC is early preview. Callers must treat enforcement as
 * defense-in-depth and record SANDBOX_BACKEND_MXC honesty losses.
 *
 * Currently unreachable from runInSandbox: every run synthesizes stable
 * directory-handle authorities for its binds, and the MXC SDK configures
 * containment by path strings only, so run() always fails closed with
 * UNAVAILABLE (see mxcFilesystemPaths). The backend remains for probe
 * diagnostics and for the day the SDK exposes handle-relative binds; macOS and
 * Windows package-exec containment is withdrawn until then.
 */
export async function createMxcBackend(): Promise<SandboxBackend> {
  const probe = await probeMxc();
  if (!probe.available) {
    throw new SandboxBackendError(
      'UNAVAILABLE',
      probe.reason ?? 'MXC unavailable',
    );
  }
  const mod = await import('@microsoft/mxc-sdk');
  return {
    id: 'mxc',
    async run(input) {
      if (input.executableAuthority !== undefined)
        throw new SandboxBackendError(
          'UNAVAILABLE',
          'MXC cannot consume stable executable handle authorities',
        );
      if (input.stdin !== undefined)
        throw new SandboxBackendError(
          'UNAVAILABLE',
          'MXC cannot deliver bounded stdin to the sandboxed process',
        );
      // Prefer config-based spawn when present; fall back to a constrained
      // host spawn only if the SDK surface differs — but never silently drop
      // the jail: if we cannot configure MXC, fail.
      if (typeof mod.createConfigFromPolicy !== 'function') {
        throw new SandboxBackendError(
          'UNAVAILABLE',
          'MXC SDK missing createConfigFromPolicy',
        );
      }
      // Do not pull getAvailableToolsPolicy for package-exec — it widens the
      // readable world to the whole host toolchain discovery set.
      const temp =
        input.profile === 'host-install' &&
        typeof mod.getTemporaryFilesPolicy === 'function'
          ? mod.getTemporaryFilesPolicy()
          : // SAFETY: The surrounding boundary establishes the asserted domain contract.
            { readwritePaths: [] as string[] };

      const { readonlyPaths, readwritePaths } = mxcFilesystemPaths({
        readonlyPaths: input.readonlyPaths,
        readwritePaths: [
          ...(temp.readwritePaths ?? []),
          ...input.readwritePaths,
        ],
        cwd: input.cwd,
        ...(!(input.directoryAuthorities === undefined) && {
          directoryAuthorities: input.directoryAuthorities,
        }),
      });

      const config = mod.createConfigFromPolicy({
        version: '0.7.0-alpha',
        filesystem: {
          readonlyPaths,
          readwritePaths,
        },
        network: {
          allowOutbound: input.network,
        },
        timeoutMs: input.timeoutMs ?? 600_000,
      });

      // commandLine as joined argv — MXC expects a command line string on
      // several backends; we still built argv without a shell.
      if (config.process) {
        config.process.commandLine = quoteCommandLine(input.argv);
        config.process.cwd = input.cwd;
        config.process.env = Object.entries(input.env).map(
          ([k, v]) => `${k}=${v}`,
        );
      }

      if (typeof mod.spawnSandboxFromConfig === 'function') {
        // SAFETY: The surrounding boundary establishes the asserted domain contract.
        const child = mod.spawnSandboxFromConfig(config, { usePty: false }) as {
          stdout?: NodeJS.ReadableStream | null;
          stderr?: NodeJS.ReadableStream | null;
          on: (event: string, cb: (...args: unknown[]) => void) => void;
          kill?: (signal?: NodeJS.Signals) => void;
        };
        return await collectMxcChild(child, input, input.signal);
      }

      // Last resort: do not pretend — surface unavailability.
      throw new SandboxBackendError(
        'UNAVAILABLE',
        'MXC SDK missing spawnSandboxFromConfig',
      );
    },
  };
}

export function quoteCommandLine(argv: readonly string[]): string {
  return argv
    .map((part) => {
      if (part.length === 0) return '""';
      if (/[$%`!^&|<>;\r\n"']/u.test(part) || part.endsWith('\\'))
        throw new SandboxBackendError(
          'POLICY_DENIED',
          'MXC command arguments contain characters its string ABI cannot encode safely',
        );
      if (/^[A-Za-z0-9_./:@+=,-]+$/u.test(part)) return part;
      return `"${part.replaceAll('\\', '\\\\')}"`;
    })
    .join(' ');
}

export async function collectMxcChild(
  child: {
    stdout?: NodeJS.ReadableStream | null;
    stderr?: NodeJS.ReadableStream | null;
    on: (event: string, cb: (...args: unknown[]) => void) => void;
    kill?: (signal?: NodeJS.Signals) => void;
  },
  limits: {
    maximumStdoutBytes: number;
    maximumStderrBytes: number;
    maximumOutputBytes: number;
    /** Hand output on as it is written instead of keeping it. */
    output?: OutputSink;
  },
  signal?: AbortSignal,
): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
  outputLimitExceeded?: OutputLimitKind;
}> {
  return await new Promise((resolve, reject) => {
    const output = new BoundedOutput(limits, limits.output);
    let aborted = false;
    let terminationTimer: ReturnType<typeof setTimeout> | undefined;
    const terminate = () => {
      if (terminationTimer) return;
      try {
        child.kill?.('SIGKILL');
      } catch {
        // The close/error event remains authoritative.
      }
      terminationTimer = setTimeout(
        () =>
          reject(
            new SandboxBackendError(
              'TERMINATION_FAILED',
              'MXC process did not terminate after kill',
            ),
          ),
        5_000,
      );
    };
    const onAbort = () => {
      aborted = true;
      terminate();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (d: unknown) => {
      if (!output.push('stdout', d)) terminate();
    });
    child.stderr?.on('data', (d: unknown) => {
      if (!output.push('stderr', d)) terminate();
    });
    child.on('error', (err: unknown) => {
      signal?.removeEventListener('abort', onAbort);
      if (terminationTimer) clearTimeout(terminationTimer);
      reject(err);
    });
    child.on('close', (code: unknown) => {
      signal?.removeEventListener('abort', onAbort);
      if (terminationTimer) clearTimeout(terminationTimer);
      resolve(
        output.result(aborted ? 124 : typeof code === 'number' ? code : 1),
      );
    });
    if (signal?.aborted) onAbort();
  });
}

/**
 * MXC filesystem grants. cwd is visible RO unless the caller already granted
 * write — auto-RW cwd would reopen project-write (audit C2).
 */
export function mxcFilesystemPaths(input: {
  readonlyPaths: readonly string[];
  readwritePaths: readonly string[];
  cwd: string;
  directoryAuthorities?: readonly { fd: number; path: string }[];
}) {
  if ((input.directoryAuthorities?.length ?? 0) > 0)
    throw new SandboxBackendError(
      'UNAVAILABLE',
      'MXC SDK does not expose inherited directory-handle binds; package-exec containment is withdrawn on platforms without a native backend',
    );
  const readwritePaths = [...input.readwritePaths];
  const readonlyPaths = [...input.readonlyPaths];
  const rw = new Set(readwritePaths);
  if (!rw.has(input.cwd) && !readonlyPaths.includes(input.cwd)) {
    readonlyPaths.push(input.cwd);
  }
  return { readonlyPaths, readwritePaths };
}
