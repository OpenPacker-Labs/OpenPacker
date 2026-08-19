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
        maximumStdoutBytes: input.maximumStdoutBytes,
        maximumStderrBytes: input.maximumStderrBytes,
        maximumOutputBytes: input.maximumOutputBytes,
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

export type OutputLimitKind = 'stdout' | 'stderr' | 'combined';

export class BoundedOutput {
  readonly #stdout: Buffer[] = [];
  readonly #stderr: Buffer[] = [];
  #stdoutBytes = 0;
  #stderrBytes = 0;
  #totalBytes = 0;
  exceeded: OutputLimitKind | undefined;

  constructor(
    readonly limits: {
      maximumStdoutBytes: number;
      maximumStderrBytes: number;
      maximumOutputBytes: number;
    },
  ) {}

  push(kind: 'stdout' | 'stderr', chunk: unknown): boolean {
    if (this.exceeded) return false;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    const channelBytes =
      kind === 'stdout' ? this.#stdoutBytes : this.#stderrBytes;
    const channelLimit =
      kind === 'stdout'
        ? this.limits.maximumStdoutBytes
        : this.limits.maximumStderrBytes;
    const retained = Math.max(
      0,
      Math.min(
        bytes.byteLength,
        channelLimit - channelBytes,
        this.limits.maximumOutputBytes - this.#totalBytes,
      ),
    );
    if (retained > 0)
      (kind === 'stdout' ? this.#stdout : this.#stderr).push(
        bytes.subarray(0, retained),
      );
    if (kind === 'stdout') this.#stdoutBytes += bytes.byteLength;
    else this.#stderrBytes += bytes.byteLength;
    this.#totalBytes += bytes.byteLength;
    const channelExceeded =
      (kind === 'stdout' ? this.#stdoutBytes : this.#stderrBytes) >
      channelLimit;
    const combinedExceeded = this.#totalBytes > this.limits.maximumOutputBytes;
    this.exceeded = channelExceeded
      ? combinedExceeded &&
        this.limits.maximumOutputBytes - (this.#totalBytes - bytes.byteLength) <
          channelLimit - channelBytes
        ? 'combined'
        : kind
      : combinedExceeded
        ? 'combined'
        : undefined;
    return this.exceeded === undefined;
  }

  result(exitCode: number): {
    exitCode: number;
    stdout: string;
    stderr: string;
    outputLimitExceeded?: OutputLimitKind;
  } {
    return {
      exitCode: this.exceeded ? 125 : exitCode,
      stdout: Buffer.concat(this.#stdout).toString('utf8'),
      stderr:
        Buffer.concat(this.#stderr).toString('utf8') +
        (this.exceeded
          ? `\nopenpacker sandbox: ${this.exceeded} output limit exceeded\n`
          : ''),
      ...(this.exceeded ? { outputLimitExceeded: this.exceeded } : {}),
    };
  }
}

export async function spawnCapture(input: {
  argv: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  signal?: AbortSignal;
  timeoutMs?: number;
  maximumStdoutBytes?: number;
  maximumStderrBytes?: number;
  maximumOutputBytes?: number;
}): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
  outputLimitExceeded?: OutputLimitKind;
}> {
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
        detached: process.platform !== 'win32',
        ...(signal === undefined ? {} : { signal }),
      });
      const output = new BoundedOutput({
        maximumStdoutBytes: input.maximumStdoutBytes ?? 1024 * 1024,
        maximumStderrBytes: input.maximumStderrBytes ?? 1024 * 1024,
        maximumOutputBytes: input.maximumOutputBytes ?? 2 * 1024 * 1024,
      });
      let terminated = false;
      const terminateTree = () => {
        if (terminated) return;
        terminated = true;
        try {
          if (process.platform !== 'win32' && child.pid)
            process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      };
      child.stdout?.on('data', (chunk: unknown) => {
        if (!output.push('stdout', chunk)) terminateTree();
      });
      child.stderr?.on('data', (chunk: unknown) => {
        if (!output.push('stderr', chunk)) terminateTree();
      });
      child.on('error', (err) => {
        if ((err as NodeJS.ErrnoException).name === 'AbortError') {
          const result = output.result(124);
          resolvePromise({
            ...result,
            stderr: `${result.stderr}\nopenpacker sandbox: process timed out\n`,
          });
          return;
        }
        reject(err);
      });
      child.on('close', (code) => {
        resolvePromise(output.result(code ?? 1));
      });
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}
