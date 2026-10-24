import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import { createMockBackend } from './backends/mock.js';
import { collectMxcChild } from './backends/mxc.js';
import {
  createNativeBackend,
  findTrustedSandboxHelper,
} from './backends/native.js';
import { runInSandbox } from './run.js';
import { stoppedBySignal } from './stop.js';
import { scratch } from './test-scratch.js';
import type { SandboxBackend } from './types.js';

/**
 * A run ended before its process ended by itself says what ended it. Every
 * stop used to read "process aborted or timed out", so a Ctrl-C at a server
 * run by opmx was reported as a timeout as likely as not.
 */

const nativeBackend = createNativeBackend();
const backends: [string, () => SandboxBackend][] = [
  ['the mock backend', () => createMockBackend()],
  ...(process.platform === 'linux' &&
  findTrustedSandboxHelper('bwrap') !== undefined &&
  nativeBackend?.id === 'native-bwrap'
    ? [['native bwrap', () => nativeBackend] as [string, () => SandboxBackend]]
    : []),
];

/** Start a process that says it is up and then waits to be ended. */
function waiting(
  backend: SandboxBackend,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
) {
  const root = scratch('op-sandbox-stop-');
  let seen = '';
  const run = runInSandbox({
    argv: ['/bin/sh', '-c', 'echo up; exec sleep 600'],
    cwd: root,
    policy: {
      enabled: true,
      mode: 'fail-closed',
      required: true,
      ...(!(options.timeoutMs === undefined) && {
        timeoutMs: options.timeoutMs,
      }),
    },
    readwritePaths: [],
    readonlyPaths: [root],
    backend,
    output: {
      stdout: (chunk) => (seen += Buffer.from(chunk).toString('utf8')),
      stderr: () => undefined,
    },
    ...(!(options.signal === undefined) && { signal: options.signal }),
  });
  const up = async () => {
    for (const deadline = Date.now() + 20_000; Date.now() < deadline; ) {
      if (seen === 'up\n') return;
      await sleep(25);
    }
    throw new Error('the process never said it was up');
  };
  return { run, up };
}

describe.each(backends)('a run that is ended, by %s', (_, backend) => {
  it.each(['SIGINT', 'SIGTERM', 'SIGHUP'] as const)(
    'by %s, names the signal',
    async (name) => {
      const stop = new AbortController();
      const { run, up } = waiting(backend(), { signal: stop.signal });
      await up();
      stop.abort(stoppedBySignal(name));
      const outcome = await run;
      expect([outcome.exitCode, outcome.stderr]).toEqual([
        124,
        `\nopenpacker sandbox: process stopped by ${name}\n`,
      ]);
    },
    30_000,
  );

  it('by the policy’s timeout, says so and how long it was', async () => {
    const { run, up } = waiting(backend(), { timeoutMs: 400 });
    await up();
    const outcome = await run;
    expect([outcome.exitCode, outcome.stderr]).toEqual([
      124,
      '\nopenpacker sandbox: process timed out after 400 ms\n',
    ]);
  }, 30_000);

  it('by any other abort, says it was aborted, and nothing more', async () => {
    const stop = new AbortController();
    const { run, up } = waiting(backend(), { signal: stop.signal });
    await up();
    stop.abort();
    const outcome = await run;
    expect([outcome.exitCode, outcome.stderr]).toEqual([
      124,
      '\nopenpacker sandbox: process aborted\n',
    ]);
  }, 30_000);
});

describe('an MXC run that is ended', () => {
  it('names the signal too', async () => {
    // SAFETY: The test double carries exactly the members the collector reads.
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn(() => setImmediate(() => child.emit('close', 1)));
    const stop = new AbortController();
    const running = collectMxcChild(
      child,
      {
        maximumStdoutBytes: 8,
        maximumStderrBytes: 8,
        maximumOutputBytes: 12,
      },
      stop.signal,
    );
    stop.abort(stoppedBySignal('SIGTERM'));
    const result = await running;
    expect([result.exitCode, result.stderr]).toEqual([
      124,
      '\nopenpacker sandbox: process stopped by SIGTERM\n',
    ]);
  });
});
