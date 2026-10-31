import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { BoundedOutput, createMockBackend, handOn } from './backends/mock.js';
import { collectMxcChild } from './backends/mxc.js';
import { runInSandbox } from './run.js';
import { scratch } from './test-scratch.js';

/**
 * A sink that cannot take more (a terminal or a pipe that is behind) returns
 * a promise, and the process's stream is not read again until it settles: the
 * process then waits on its own writes, as it would writing to the terminal
 * itself. The sink's return was ignored, so a slow terminal had everything a
 * tool wrote handed to it at once, and kept in its queue.
 */

const LIMITS = {
  maximumStdoutBytes: 1024 * 1024,
  maximumStderrBytes: 1024 * 1024,
  maximumOutputBytes: 2 * 1024 * 1024,
};

/** A sink that takes nothing more until the test lets each chunk go. */
function slowSink() {
  const taken: string[] = [];
  const waiting: (() => void)[] = [];
  return {
    taken,
    next: () => waiting.shift()?.(),
    sink: {
      stdout: (chunk: Uint8Array) => {
        taken.push(Buffer.from(chunk).toString('utf8'));
        return new Promise<void>((resolve) => waiting.push(resolve));
      },
      stderr: () => undefined,
    },
  };
}

/** Every callback queued so far has run, the stream's included. */
const settled = () => new Promise((resolve) => setImmediate(resolve));

describe('a stream handed to a sink that is behind', () => {
  it('is not read again until the sink has taken what it was handed', async () => {
    const stream = new PassThrough();
    const { taken, next, sink } = slowSink();
    handOn(stream, 'stdout', new BoundedOutput(LIMITS, sink), () => undefined);
    stream.write('first');
    stream.write('second');
    stream.write('third');
    await settled();
    expect(taken).toEqual(['first']);
    next();
    await settled();
    expect(taken).toEqual(['first', 'second']);
    next();
    await settled();
    expect(taken).toEqual(['first', 'second', 'third']);
  });

  it('is read on at once when the sink takes it', async () => {
    const stream = new PassThrough();
    const seen: string[] = [];
    handOn(
      stream,
      'stdout',
      new BoundedOutput(LIMITS, {
        stdout: (chunk) => {
          seen.push(Buffer.from(chunk).toString('utf8'));
        },
        stderr: () => undefined,
      }),
      () => undefined,
    );
    stream.write('a');
    stream.write('b');
    await settled();
    expect(seen.join('')).toBe('ab');
  });
});

describe('an MXC run whose sink is behind', () => {
  it('is not read again until the sink has taken what it was handed', async () => {
    // SAFETY: The test double carries exactly the members the collector reads.
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn();
    const { taken, next, sink } = slowSink();
    const running = collectMxcChild(child, { ...LIMITS, output: sink });
    child.stdout.write('first');
    child.stdout.write('second');
    await settled();
    expect(taken).toEqual(['first']);
    next();
    await settled();
    expect(taken.join('')).toBe('firstsecond');
    next();
    child.emit('close', 0);
    expect((await running).exitCode).toBe(0);
  });
});

describe('a run whose sink never takes what it was handed', () => {
  it('ends when it is stopped, its held output let go', async () => {
    const root = scratch('op-sandbox-held-');
    let told: () => void = () => undefined;
    const behind = new Promise<void>((settle) => (told = settle));
    const stop = new AbortController();
    const run = runInSandbox({
      argv: ['/bin/sh', '-c', 'while :; do echo held held held held; done'],
      cwd: root,
      policy: { enabled: true, mode: 'fail-closed', required: true },
      readwritePaths: [],
      readonlyPaths: [root],
      backend: createMockBackend(),
      output: {
        // A reader that never drains: the first chunk is never taken.
        stdout: () => {
          told();
          return new Promise<void>(() => undefined);
        },
        stderr: () => undefined,
      },
      signal: stop.signal,
    });
    await behind;
    stop.abort();
    expect((await run).exitCode).toBe(124);
  });

  it('lets an MXC run end too', async () => {
    // SAFETY: The test double carries exactly the members the collector reads.
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    // The process ends when killed; its streams end only once drained or destroyed.
    child.kill = vi.fn(() => {
      const closed = () =>
        child.stdout.destroyed && child.stderr.destroyed
          ? child.emit('close', null)
          : undefined;
      child.stdout.once('close', closed);
      child.stderr.once('close', closed);
      setImmediate(() => child.stderr.end());
    });
    const stop = new AbortController();
    const running = collectMxcChild(
      child,
      {
        ...LIMITS,
        output: {
          stdout: () => new Promise<void>(() => undefined),
          stderr: () => undefined,
        },
      },
      stop.signal,
    );
    child.stdout.write('held\n');
    child.stdout.write('more\n');
    await new Promise((resolve) => setImmediate(resolve));
    stop.abort();
    expect((await running).exitCode).toBe(124);
  });
});
