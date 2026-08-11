import type { BackendProbe, SandboxBackend } from '../types.js';
import { SandboxBackendError, spawnCapture } from './mock.js';

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
      // Prefer config-based spawn when present; fall back to a constrained
      // host spawn only if the SDK surface differs — but never silently drop
      // the jail: if we cannot configure MXC, fail.
      if (typeof mod.createConfigFromPolicy !== 'function') {
        throw new SandboxBackendError(
          'UNAVAILABLE',
          'MXC SDK missing createConfigFromPolicy',
        );
      }
      const tools =
        typeof mod.getAvailableToolsPolicy === 'function'
          ? mod.getAvailableToolsPolicy(process.env)
          : { readonlyPaths: [] as string[] };
      const temp =
        typeof mod.getTemporaryFilesPolicy === 'function'
          ? mod.getTemporaryFilesPolicy()
          : { readwritePaths: [] as string[] };

      const readonlyPaths = [
        ...(tools.readonlyPaths ?? []),
        ...input.readonlyPaths,
      ];
      const readwritePaths = [
        ...(temp.readwritePaths ?? []),
        ...input.readwritePaths,
        input.cwd,
      ];

      const config = mod.createConfigFromPolicy({
        version: '0.7.0-alpha',
        filesystem: {
          readonlyPaths,
          readwritePaths,
        },
        network: {
          allowOutbound: input.network,
        },
        timeoutMs: 600_000,
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
        const child = mod.spawnSandboxFromConfig(config, { usePty: false }) as {
          stdout?: NodeJS.ReadableStream | null;
          stderr?: NodeJS.ReadableStream | null;
          on: (event: string, cb: (...args: unknown[]) => void) => void;
          kill?: (signal?: NodeJS.Signals) => void;
        };
        return await collectChild(child, input.signal);
      }

      // Last resort: do not pretend — surface unavailability.
      throw new SandboxBackendError(
        'UNAVAILABLE',
        'MXC SDK missing spawnSandboxFromConfig',
      );
    },
  };
}

function quoteCommandLine(argv: readonly string[]): string {
  return argv
    .map((part) => {
      if (part.length === 0) return '""';
      if (/^[A-Za-z0-9_./:@%+=,-]+$/u.test(part)) return part;
      return `"${part.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
    })
    .join(' ');
}

async function collectChild(
  child: {
    stdout?: NodeJS.ReadableStream | null;
    stderr?: NodeJS.ReadableStream | null;
    on: (event: string, cb: (...args: unknown[]) => void) => void;
    kill?: (signal?: NodeJS.Signals) => void;
  },
  signal?: AbortSignal,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const onAbort = () => {
      try {
        child.kill?.('SIGTERM');
      } catch {
        // ignore
      }
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (d: unknown) => {
      stdout += String(d);
    });
    child.stderr?.on('data', (d: unknown) => {
      stderr += String(d);
    });
    child.on('error', (err: unknown) => {
      signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
    child.on('close', (code: unknown) => {
      signal?.removeEventListener('abort', onAbort);
      resolve({
        exitCode: typeof code === 'number' ? code : 1,
        stdout,
        stderr,
      });
    });
  });
}

/** Used only when tests force ambient degraded execution. */
export { spawnCapture };
