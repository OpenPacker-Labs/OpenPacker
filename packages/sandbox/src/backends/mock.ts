import { spawn } from 'node:child_process';
import type { SandboxBackend } from '../types.js';

/**
 * Test backend: runs the process with scrubbed env but no OS isolation.
 *
 * Production code never selects this unless injected. Offline unit tests use
 * it to exercise fail-closed / policy wiring without MXC or bwrap.
 */
export function createMockBackend(options?: {
  /** When true, refuse to run (simulates unavailable host jail). */
  unavailable?: boolean;
  id?: 'mock';
}): SandboxBackend {
  const id = options?.id ?? 'mock';
  if (options?.unavailable) {
    return {
      id: 'none',
      async run() {
        throw new SandboxBackendError(
          'UNAVAILABLE',
          'Mock backend configured as unavailable',
        );
      },
    };
  }
  return {
    id,
    async run(input) {
      return await spawnCapture({
        argv: input.argv,
        cwd: input.cwd,
        env: input.env,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
    },
  };
}

export class SandboxBackendError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'SandboxBackendError';
    this.code = code;
  }
}

export async function spawnCapture(input: {
  argv: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  signal?: AbortSignal;
}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  if (input.argv.length === 0) {
    throw new SandboxBackendError('EMPTY_ARGV', 'argv must not be empty');
  }
  const [command, ...args] = input.argv;
  if (!command) {
    throw new SandboxBackendError('EMPTY_ARGV', 'argv[0] is required');
  }
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: input.cwd,
      env: { ...input.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      signal: input.signal,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}
