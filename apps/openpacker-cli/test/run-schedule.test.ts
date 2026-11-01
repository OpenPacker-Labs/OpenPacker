import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import {
  processHost,
  type ChildHost,
  type RunningChild,
} from '../src/commands/run-child.js';
import {
  schedule,
  type Job,
  type JobResult,
} from '../src/commands/run-schedule.js';

function testHost() {
  const signals = new EventEmitter();
  const host: ChildHost = {
    ...processHost,
    onSignal(signal, listener) {
      signals.on(signal, listener);
      return () => {
        signals.off(signal, listener);
      };
    },
  };
  return { host, signals };
}

/** A job that ends when the test says so, and counts how many run at once. */
function gate() {
  let live = 0;
  let peak = 0;
  const open = new Map<string, (result: JobResult) => void>();
  const job = (id: string, after: string[] = []): Job => ({
    id,
    after,
    run: () =>
      new Promise<JobResult>((resolve) => {
        live += 1;
        peak = Math.max(peak, live);
        open.set(id, (result) => {
          live -= 1;
          resolve(result);
        });
      }),
  });
  return {
    job,
    open,
    get peak() {
      return peak;
    },
    finish: (id: string, status = 0) =>
      open.get(id)?.({ status, failure: `${id} failed` }),
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('schedule', () => {
  it('never runs more than the limit at once and runs every job', async () => {
    const g = gate();
    const jobs = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => g.job(id));
    const done = schedule(jobs, { limit: 2, host: testHost().host });
    for (let n = 0; n < 6; n += 1) {
      await tick();
      for (const id of Array.from(g.open.keys())) {
        g.finish(id);
        g.open.delete(id);
      }
    }
    const outcome = await done;
    expect(outcome.started).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(g.peak).toBe(2);
    expect(outcome.failed).toBeUndefined();
  });

  it('starts a job only after the jobs it waits for have ended', async () => {
    const g = gate();
    const jobs = [g.job('c', ['b']), g.job('b', ['a']), g.job('a'), g.job('d')];
    const done = schedule(jobs, { limit: 4, host: testHost().host });
    await tick();
    expect([...g.open.keys()].sort()).toEqual(['a', 'd']);
    g.finish('a');
    await tick();
    expect([...g.open.keys()].sort()).toContain('b');
    expect([...g.open.keys()]).not.toContain('c');
    g.finish('b');
    await tick();
    g.finish('c');
    g.finish('d');
    const outcome = await done;
    expect(outcome.started.indexOf('b')).toBeGreaterThan(
      outcome.started.indexOf('a'),
    );
    expect(outcome.started.indexOf('c')).toBeGreaterThan(
      outcome.started.indexOf('b'),
    );
  });

  it('starts independent jobs in list order', async () => {
    const g = gate();
    const done = schedule(
      ['x', 'y', 'z'].map((id) => g.job(id)),
      {
        limit: 1,
        host: testHost().host,
      },
    );
    for (let n = 0; n < 3; n += 1) {
      await tick();
      const [id] = [...g.open.keys()];
      g.finish(id!);
      g.open.delete(id!);
    }
    expect((await done).started).toEqual(['x', 'y', 'z']);
  });

  it('with no limit starts everything at once', async () => {
    const g = gate();
    const jobs = Array.from({ length: 20 }, (_, n) => g.job(`j${n}`));
    const done = schedule(jobs, { limit: Infinity, host: testHost().host });
    await tick();
    expect(g.open.size).toBe(20);
    for (const id of g.open.keys()) g.finish(id);
    await done;
    expect(g.peak).toBe(20);
  });

  it('stops launching at the first failure, tells the running children to end, and reports it', async () => {
    const g = gate();
    const sent: string[] = [];
    const jobs: Job[] = [
      g.job('a'),
      {
        id: 'b',
        after: [],
        run: (control) =>
          new Promise<JobResult>((resolve) => {
            const child: RunningChild = {
              outcome: new Promise(() => undefined),
              signal: (s) => {
                sent.push(`b:${s}`);
                resolve({ status: 143 });
              },
            };
            control.track(child);
          }),
      },
      g.job('c', ['a']),
      g.job('d'),
    ];
    const done = schedule(jobs, { limit: 2, host: testHost().host });
    await tick();
    g.finish('a', 9);
    const outcome = await done;
    expect(outcome.failed).toEqual({
      id: 'a',
      result: { status: 9, failure: 'a failed' },
    });
    expect(sent).toEqual(['b:SIGTERM']);
    expect(outcome.started).toEqual(['a', 'b']);
  });

  it('keeps the first failure when a job it stopped ends with a failure of its own', async () => {
    const g = gate();
    const jobs = [g.job('a'), g.job('b')];
    const done = schedule(jobs, { limit: 2, host: testHost().host });
    await tick();
    g.finish('a', 3);
    g.finish('b', 143);
    expect((await done).failed?.id).toBe('a');
  });

  it('reports a job that throws, and stops', async () => {
    const jobs: Job[] = [
      {
        id: 'a',
        after: [],
        run: () => Promise.reject(new Error('cannot start')),
      },
      { id: 'b', after: ['a'], run: () => Promise.resolve({ status: 0 }) },
    ];
    const outcome = await schedule(jobs, { limit: 2, host: testHost().host });
    expect(outcome.error?.id).toBe('a');
    expect(String(outcome.error?.error)).toContain('cannot start');
    expect(outcome.started).toEqual(['a']);
  });

  it('forwards a signal to every running child, launches nothing more, and says which signal', async () => {
    const { host, signals } = testHost();
    const sent: string[] = [];
    const jobs: Job[] = ['a', 'b', 'c'].map((id) => ({
      id,
      after: [],
      run: (control) =>
        new Promise<JobResult>((resolve) => {
          control.track({
            outcome: new Promise(() => undefined),
            signal: (s) => {
              sent.push(`${id}:${s}`);
              resolve({ status: 143 });
            },
          });
        }),
    }));
    const done = schedule(
      [
        ...jobs,
        { id: 'd', after: ['a'], run: () => Promise.resolve({ status: 0 }) },
      ],
      {
        limit: 3,
        host,
      },
    );
    await tick();
    signals.emit('SIGHUP');
    const outcome = await done;
    expect(sent.sort()).toEqual(['a:SIGHUP', 'b:SIGHUP', 'c:SIGHUP']);
    expect(outcome.interrupted).toBe('SIGHUP');
    expect(outcome.started).not.toContain('d');
    // A member ended by the signal sent to opm is not a member that failed.
    expect(outcome.failed).toBeUndefined();
  });

  it('does not take the first job a signal ended, or any that ends after it, for the failure', async () => {
    const g = gate();
    const { host, signals } = testHost();
    const done = schedule([g.job('a'), g.job('b'), g.job('c')], {
      limit: 3,
      host,
    });
    await tick();
    signals.emit('SIGTERM');
    g.finish('b', 143);
    g.finish('a', 1);
    g.finish('c', 0);
    const outcome = await done;
    expect(outcome.failed).toBeUndefined();
    expect(outcome.interrupted).toBe('SIGTERM');
  });

  it('keeps a failure that came before the signal', async () => {
    const g = gate();
    const { host, signals } = testHost();
    const done = schedule([g.job('a'), g.job('b')], { limit: 2, host });
    await tick();
    g.finish('a', 3);
    await tick();
    signals.emit('SIGTERM');
    g.finish('b', 143);
    const outcome = await done;
    expect(outcome.failed?.id).toBe('a');
    expect(outcome.failed?.result.status).toBe(3);
  });

  it('tells a child registered after the run ended to end at once', async () => {
    const g = gate();
    let late: ((child: RunningChild) => void) | undefined;
    const sent: string[] = [];
    const jobs: Job[] = [
      g.job('a'),
      {
        id: 'b',
        after: [],
        run: (control) =>
          new Promise<JobResult>((resolve) => {
            late = (child) => {
              control.track(child);
              resolve({ status: 0 });
            };
          }),
      },
    ];
    const done = schedule(jobs, { limit: 2, host: testHost().host });
    await tick();
    g.finish('a', 1);
    await tick();
    late?.({
      outcome: new Promise(() => undefined),
      signal: (s) => void sent.push(s),
    });
    await done;
    expect(sent).toEqual(['SIGTERM']);
  });

  it('removes its signal listeners when it ends', async () => {
    const { host, signals } = testHost();
    await schedule(
      [{ id: 'a', after: [], run: () => Promise.resolve({ status: 0 }) }],
      {
        limit: 1,
        host,
      },
    );
    expect(signals.emit('SIGTERM')).toBe(false);
  });

  it('refuses jobs that wait on each other instead of finishing quietly', async () => {
    const run = () => Promise.resolve({ status: 0 });
    await expect(
      schedule(
        [
          { id: 'a', after: ['b'], run },
          { id: 'b', after: ['a'], run },
        ],
        { limit: 2, host: testHost().host },
      ),
    ).rejects.toThrow(/waits on itself/u);
  });

  it('ignores an id it was told to wait for that is not a job', async () => {
    const outcome = await schedule(
      [
        {
          id: 'a',
          after: ['ghost', 'a'],
          run: () => Promise.resolve({ status: 0 }),
        },
      ],
      { limit: 1, host: testHost().host },
    );
    expect(outcome.started).toEqual(['a']);
  });
});
