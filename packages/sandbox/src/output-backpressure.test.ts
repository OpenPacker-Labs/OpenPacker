import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { BoundedOutput, handOn } from './backends/mock.js';
import { collectMxcChild } from './backends/mxc.js';

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
