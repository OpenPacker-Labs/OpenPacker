import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createMockBackend } from './backends/mock.js';
import { collectMxcChild } from './backends/mxc.js';
import {
  createNativeBackend,
  findTrustedSandboxHelper,
} from './backends/native.js';
import { runInSandbox } from './run.js';
import { stoppedBySignal } from './stop.js';
import { heard } from './test-output.js';
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
  const { seen, output, until } = heard();
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
    output,
    ...(!(options.signal === undefined) && { signal: options.signal }),
  });
  const up = () => until(() => seen.stdout === 'up\n', run);
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
  );

  it('by the policy’s timeout, says so and how long it was', async () => {
    // Ended by the clock, whether or not it had said it was up by then.
    const { run } = waiting(backend(), { timeoutMs: 400 });
    const outcome = await run;
    expect([outcome.exitCode, outcome.stderr]).toEqual([
      124,
      '\nopenpacker sandbox: process timed out after 400 ms\n',
    ]);
  });

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
  });
});

describe('an MXC run that is ended', () => {
  it('names the signal too', async () => {
    // SAFETY: The test double carries exactly the members the collector reads.
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      kill: (signal?: NodeJS.Signals) => boolean;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn(() => {
      setImmediate(() => child.emit('close', 1));
      return true;
    }) as (signal?: NodeJS.Signals) => boolean;
    const stop = new AbortController();
    const running = collectMxcChild(
      child as Parameters<typeof collectMxcChild>[0],
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
