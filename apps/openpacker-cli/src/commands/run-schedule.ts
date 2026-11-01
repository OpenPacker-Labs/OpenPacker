/**
 * Runs the jobs of a multi-member run (ADR 0053): at most `limit` at once, a
 * job only after the jobs it waits for, the first failure stops everything.
 *
 * A job is one member's script (its hooks included) or one member's `exec`.
 * The scheduler knows nothing about either; it starts jobs, tracks the
 * children they start so a signal reaches all of them, and decides when to
 * stop. Order is a promise about dependencies, never about which of two
 * independent jobs starts first beyond "the earlier one in the list".
 */
import { FORWARDED, type ChildHost, type RunningChild } from './run-child.js';

export interface JobResult {
  status: number;
  /** For `opm:` on stderr when `status` is not 0. */
  failure?: string;
}

/** What a job may ask of the scheduler while it runs. */
export interface JobControl {
  /** True once the run is ending (a failure or a signal): start nothing new. */
  readonly stopping: boolean;
  /** Register a child so a signal and a stop reach it; returns how to forget it. */
  track(child: RunningChild): () => void;
}

export interface Job {
  id: string;
  /** Ids this job waits for. Ids not in the list are ignored. */
  after: readonly string[];
  run(control: JobControl): Promise<JobResult>;
}

export interface ScheduleOptions {
  /** How many jobs run at once; `Infinity` for no bound. */
  limit: number;
  host: ChildHost;
}

export interface ScheduleOutcome {
  /** Job ids in the order they started. */
  started: string[];
  /**
   * The first job that ended with a non-zero status, if any. Not set for a job
   * that ends after a signal reached the run: the signal is the reason.
   */
  failed?: { id: string; result: JobResult };
  /** The first job that threw (it could not start a child, say), if it came first. */
  error?: { id: string; error: unknown };
  /** The signal that stopped the run, when one did and nothing failed first. */
  interrupted?: NodeJS.Signals;
}

export async function schedule(
  jobs: readonly Job[],
  options: ScheduleOptions,
): Promise<ScheduleOutcome> {
  const known = new Set(jobs.map((job) => job.id));
  const waiting = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  const byId = new Map(jobs.map((job) => [job.id, job]));
  for (const job of jobs) {
    const after = new Set(
      job.after.filter((id) => known.has(id) && id !== job.id),
    );
    waiting.set(job.id, after.size);
    for (const id of after)
      dependents.set(id, [...(dependents.get(id) ?? []), job.id]);
  }
  const ready = jobs
    .filter((job) => waiting.get(job.id) === 0)
    .map((job) => job.id);
  const outcome: ScheduleOutcome = { started: [] };
  const children = new Set<RunningChild>();
  let stopping = false;
  let running = 0;

  const stop = (signal: NodeJS.Signals) => {
    stopping = true;
    for (const child of children) child.signal(signal);
  };

  const control: JobControl = {
    get stopping() {
      return stopping;
    },
    track(child) {
      children.add(child);
      // A child started in the instant the run ended is told at once.
      if (stopping) child.signal(outcome.interrupted ?? 'SIGTERM');
      return () => {
        children.delete(child);
      };
    },
  };

  const release = FORWARDED.map((name) =>
    options.host.onSignal(name, () => {
      outcome.interrupted ??= name;
      stop(name);
    }),
  );

  return await new Promise<ScheduleOutcome>((resolve, reject) => {
    const settle = () => {
      if (running > 0) return;
      if (!stopping && ready.length > 0) return;
      for (const undo of release) undo();
      if (!stopping && outcome.started.length < jobs.length)
        reject(
          new Error(
            `The run waits on itself: ${jobs.length - outcome.started.length} jobs depend on each other`,
          ),
        );
      else resolve(outcome);
    };
    const finished = (id: string) => {
      running -= 1;
      for (const next of dependents.get(id) ?? []) {
        const left = (waiting.get(next) ?? 1) - 1;
        waiting.set(next, left);
        if (left === 0) ready.push(next);
      }
      pump();
    };
    const pump = () => {
      while (!stopping && running < options.limit && ready.length > 0) {
        const id = ready.shift()!;
        const job = byId.get(id)!;
        running += 1;
        outcome.started.push(id);
        void (async () => await job.run(control))().then(
          (result) => {
            // Once a signal sent to `opm` has arrived, a job that ends badly
            // was ended by it (or by the run stopping): the run's status is
            // the signal's, and no member is named as having failed.
            if (
              result.status !== 0 &&
              outcome.failed === undefined &&
              outcome.error === undefined &&
              outcome.interrupted === undefined
            ) {
              outcome.failed = { id, result };
              if (!stopping) stop('SIGTERM');
            }
            finished(id);
          },
          (error: unknown) => {
            if (outcome.failed === undefined && outcome.error === undefined) {
              outcome.error = { id, error };
              if (!stopping) stop('SIGTERM');
            }
            finished(id);
          },
        );
      }
      settle();
    };
    pump();
  });
}
