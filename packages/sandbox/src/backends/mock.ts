import { spawn } from 'node:child_process';
import type { SandboxBackend } from '../types.js';

/**
 * Test backend: runs the process with scrubbed env but no OS isolation.
 */
export function createMockBackend(options?: {
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
  timeoutMs?: number;
}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  if (input.argv.length === 0) {
    throw new SandboxBackendError('EMPTY_ARGV', 'argv must not be empty');
  }
  const [command, ...args] = input.argv;
  if (!command) {
    throw new SandboxBackendError('EMPTY_ARGV', 'argv[0] is required');
  }

  const timeoutMs = input.timeoutMs ?? 0;
  let timeoutSignal: AbortSignal | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ac = new AbortController();
  if (timeoutMs > 0) {
    timer = setTimeout(() => ac.abort(), timeoutMs);
    timeoutSignal = ac.signal;
  }

  const signals = [input.signal, timeoutSignal].filter(
    (s): s is AbortSignal => s !== undefined,
  );
  const signal =
    signals.length === 0
      ? undefined
      : signals.length === 1
        ? signals[0]
        : AbortSignal.any(signals);

  try {
    return await new Promise((resolvePromise, reject) => {
      const child = spawn(command, args, {
        cwd: input.cwd,
        env: { ...input.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(signal === undefined ? {} : { signal }),
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
      child.on('error', (err) => {
        if ((err as NodeJS.ErrnoException).name === 'AbortError') {
          resolvePromise({
            exitCode: 124,
            stdout,
            stderr: stderr + '\nopenpacker sandbox: process timed out\n',
          });
          return;
        }
        reject(err);
      });
      child.on('close', (code) => {
        resolvePromise({ exitCode: code ?? 1, stdout, stderr });
      });
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}
