import { spawn, type ChildProcess } from 'node:child_process';
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
        treeContainment: 'test-only',
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
  treeContainment?: 'pid-namespace' | 'test-only';
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
  if (input.treeContainment === undefined)
    throw new SandboxBackendError(
      'TREE_CONTAINMENT_UNAVAILABLE',
      'Execution requires an OS-owned PID namespace or job object',
    );
  if (input.treeContainment === 'pid-namespace' && process.platform !== 'linux')
    throw new SandboxBackendError(
      'TREE_CONTAINMENT_UNAVAILABLE',
      'PID namespace containment is unavailable on this platform',
    );

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
      });
      const output = new BoundedOutput({
        maximumStdoutBytes: input.maximumStdoutBytes ?? 1024 * 1024,
        maximumStderrBytes: input.maximumStderrBytes ?? 1024 * 1024,
        maximumOutputBytes: input.maximumOutputBytes ?? 2 * 1024 * 1024,
      });
      let termination: Promise<void> | undefined;
      let aborted = false;
      let settled = false;
      const terminateTree = (reason: 'limit' | 'abort') => {
        aborted ||= reason === 'abort';
        return (termination ??= terminateProcessTree(
          child,
          input.treeContainment!,
        ));
      };
      child.stdout?.on('data', (chunk: unknown) => {
        if (!output.push('stdout', chunk)) void terminateTree('limit');
      });
      child.stderr?.on('data', (chunk: unknown) => {
        if (!output.push('stderr', chunk)) void terminateTree('limit');
      });
      const onAbort = () => void terminateTree('abort');
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
      child.on('error', (err) => {
        signal?.removeEventListener('abort', onAbort);
        settled = true;
        reject(err);
      });
      child.on('close', async (code) => {
        await termination;
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        const result = output.result(aborted ? 124 : (code ?? 1));
        resolvePromise(
          aborted
            ? {
                ...result,
                stderr: `${result.stderr}\nopenpacker sandbox: process aborted or timed out\n`,
              }
            : result,
        );
      });
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function terminateProcessTree(
  child: ChildProcess,
  containment: 'pid-namespace' | 'test-only',
): Promise<void> {
  if (!child.pid) return;
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
    else if (containment === 'test-only') child.kill('SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}
