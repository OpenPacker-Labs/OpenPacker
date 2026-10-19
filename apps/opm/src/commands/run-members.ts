/**
 * Runs the work of each member of a plan (ADR 0053).
 *
 * With one member to run, that member runs exactly as `opm run` runs the
 * project: the terminal's streams, no prefix, the child's own stdin. With
 * several, each gets its own prefixed output, no stdin (a terminal cannot
 * belong to many programs), and the scheduler decides when it starts. The
 * work itself (a script with its hooks, a bin) is the caller's.
 */
import { constants } from 'node:os';
import { report } from '@openpacker/canonical';
import { runChild, startChild, type ChildIo } from './run-child.js';
import type { RunContext } from './run-context.js';
import type { ChildRunner } from './run-package.js';
import { MemberOutput } from './run-output.js';
import { schedule, type Job, type JobResult } from './run-schedule.js';
import type { PlannedMember, WorkspacePlan } from './run-select.js';

/** What a member's work is given to run with. */
export interface MemberEnv {
  io: ChildIo | ((step: string) => ChildIo);
  start: ChildRunner;
  stdin: 'inherit' | 'ignore' | undefined;
  stopped: () => boolean;
}

export interface MemberTask {
  member: PlannedMember;
  /** False: nothing to run here (the member has no such script). */
  runs: boolean;
  work(env: MemberEnv): Promise<JobResult>;
}

/** The exit status of a member's work, after saying why it failed. */
function settle(io: ChildIo, result: JobResult): number {
  // The failure names the member and the step, which its package.json chose.
  if (result.failure !== undefined)
    io.stderr.write(report('opm: ', result.failure));
  return result.status;
}

/** Run `tasks` as `plan` says and return the exit status of the whole run. */
export async function runMembers(
  plan: WorkspacePlan,
  tasks: readonly MemberTask[],
  io: ChildIo,
  context: RunContext,
): Promise<number> {
  for (const warning of plan.warnings) io.stderr.write(report('', warning));
  const runnable = tasks.filter((task) => task.runs);
  if (runnable.length === 1) {
    const only = runnable[0]!;
    return settle(
      io,
      await only.work({
        io,
        start: (spec, streams) => runChild(spec, streams, context.host),
        stdin: undefined,
        stopped: () => false,
      }),
    );
  }
  const jobs: Job[] = tasks.map((task) => ({
    id: task.member.dir,
    after: task.member.after,
    run: async (control) => {
      if (!task.runs) return { status: 0 };
      const output = new MemberOutput(io, task.member.label, plan.mode);
      const start: ChildRunner = async (spec, streams) => {
        const running = startChild(spec, streams, context.host);
        const forget = control.track(running);
        try {
          return await running.outcome;
        } finally {
          forget();
        }
      };
      try {
        return await task.work({
          io: (step) => output.step(step),
          start,
          stdin: 'ignore',
          stopped: () => control.stopping,
        });
      } finally {
        output.finish();
      }
    },
  }));
  const outcome = await schedule(jobs, {
    limit: plan.limit,
    host: context.host,
  });
  if (outcome.error !== undefined) throw outcome.error.error;
  if (outcome.failed !== undefined) return settle(io, outcome.failed.result);
  if (outcome.interrupted !== undefined)
    return 128 + (constants.signals[outcome.interrupted] ?? 0);
  return 0;
}
