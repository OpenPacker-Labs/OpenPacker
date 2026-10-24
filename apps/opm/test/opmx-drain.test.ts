import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { passedOn } from '../src/opmx-spawn.js';

/**
 * opmx hands a tool's output to its own stdout and stderr; when one of them
 * is behind (its `write` returns false), the sink returns a promise that
 * settles once it drains, and the sandbox reads no more of the tool until
 * then. The return of `write` was ignored, so a slow terminal or pipe had
 * all of a tool's output queued in opmx.
 */

/** A stream that takes one write at a time, each when the test lets it. */
function slowStream() {
  const pending: (() => void)[] = [];
  const stream = new Writable({
    highWaterMark: 1,
    write(_chunk, _encoding, done) {
      pending.push(() => done());
    },
  });
  return { stream, release: () => pending.shift()?.() };
}

describe('the sink opmx hands a tool’s output to', () => {
  it('asks the sandbox to wait while stdout is behind, and not after it drains', async () => {
    const out = slowStream();
    const err = slowStream();
    const { sink } = passedOn({ stdout: out.stream, stderr: err.stream });
    const waiting = sink.stdout(Buffer.from('x'.repeat(16)));
    expect(waiting).toBeInstanceOf(Promise);
    let drained = false;
    void waiting!.then(() => (drained = true));
    await new Promise((resolve) => setImmediate(resolve));
    expect(drained).toBe(false);
    out.release();
    await waiting;
    expect(drained).toBe(true);
  });

  it('asks it to wait while stderr is behind', async () => {
    const out = slowStream();
    const err = slowStream();
    const { sink } = passedOn({ stdout: out.stream, stderr: err.stream });
    const waiting = sink.stderr(Buffer.from('y'.repeat(16)));
    expect(waiting).toBeInstanceOf(Promise);
    err.release();
    await waiting;
  });

  it('does not ask it to wait on a stream that took the write', () => {
    let written = '';
    const { sink } = passedOn({
      stdout: { write: (chunk: string) => ((written += chunk), true) },
      stderr: { write: () => true },
    });
    expect(sink.stdout(Buffer.from('ok'))).toBeUndefined();
    expect(written).toBe('ok');
  });

  it('stops waiting on a stream that closes instead of draining', async () => {
    const out = slowStream();
    const err = slowStream();
    const { sink } = passedOn({ stdout: out.stream, stderr: err.stream });
    const waiting = sink.stdout(Buffer.from('z'.repeat(16)));
    out.stream.destroy();
    await waiting;
  });
});
