import { AsyncLocalStorage } from 'node:async_hooks';
import { realpath } from 'node:fs/promises';
import { projectPaths } from './paths.js';
import { recoverHeldProject, type RecoveredStep } from './rollback-recovery.js';
import { acquireStepLock, type StepLockHolder } from './step-lock.js';
import { OpmError } from './types.js';

/**
 * Every library function that changes a project runs its work through
 * {@link projectStep}: `initProject`, `importNativeProject`, `addPackage`,
 * `removePackage`, `syncProject`, `updateProject`, `installProject`,
 * `uninstallProject`, `switchGeneration`, `collectGarbage` and `installFrozen`.
 * The CLI keeps no list of its own; it passes {@link StepOptions} to say what
 * was recovered.
 *
 * A step, on the root the function was given and no other:
 *  1. takes the project's step lock (`step-lock.ts`), waiting a bounded time
 *     for another step to finish;
 *  2. finishes what a killed step left (`rollback-recovery.ts`), once;
 *  3. runs the work, and releases the lock however it ends.
 *
 * A step that calls another on the same project (`installProject` syncing a
 * project with no lock) is one step: the inner call neither locks nor
 * recovers again.
 */
export interface StepOptions {
  /** Told of each copy a killed step left, as it is put back or removed. */
  onRecovered?: (step: RecoveredStep) => void;
  /** Told once when the step waits for another step on the project. */
  onWait?: (holder: StepLockHolder) => void;
  /**
   * How long to wait for another step before refusing with `PROJECT_BUSY`:
   * whole milliseconds from 0 to {@link MAX_STEP_WAIT_MS}, 10 s by default.
   */
  waitMs?: number;
}

/** Ten seconds: a step on a large project takes a few. */
export const DEFAULT_STEP_WAIT_MS = 10_000;
/** An hour: a wait is for another opm, which does not take longer. */
export const MAX_STEP_WAIT_MS = 3_600_000;

/**
 * A wait in milliseconds as a person gives it (`--wait`, `OPM_STEP_WAIT_MS`):
 * whole milliseconds from 0 to {@link MAX_STEP_WAIT_MS}.
 */
export function parseStepWait(text: string, source: string): number {
  const wait = /^\d{1,9}$/u.test(text) ? Number(text) : Number.NaN;
  if (!(wait >= 0 && wait <= MAX_STEP_WAIT_MS))
    throw new OpmError(
      'INVALID_SPEC',
      `${source} takes whole milliseconds from 0 to ${MAX_STEP_WAIT_MS}, not ${JSON.stringify(text)}`,
    );
  return wait;
}

/** The project roots the current asynchronous call chain holds a step on. */
const holding = new AsyncLocalStorage<ReadonlySet<string>>();

export async function projectStep<T>(
  root: string,
  options: StepOptions | undefined,
  work: () => Promise<T>,
): Promise<T> {
  const waitMs =
    options?.waitMs === undefined
      ? DEFAULT_STEP_WAIT_MS
      : parseStepWait(String(options.waitMs), 'The step wait');
  // The lock and the recovery are of the directory the project is in, whatever
  // name it was reached by (a symbolic link to it, a bind mount of it).
  const key = await realpath(projectPaths(root).root).catch(
    () => projectPaths(root).root,
  );
  const paths = projectPaths(key);
  const held = holding.getStore();
  if (held?.has(key) === true) return work();
  const lock = await acquireStepLock(paths, {
    waitMs,
    ...(!(options?.onWait === undefined) && { onWait: options.onWait }),
  });
  try {
    return await holding.run(new Set([...(held ?? []), key]), async () => {
      if (lock !== undefined)
        for (const step of await recoverHeldProject(paths.root))
          options?.onRecovered?.(step);
      return work();
    });
  } finally {
    await lock?.release();
  }
}

/**
 * Finish what a killed step left, and change nothing else: a step with no
 * work. What is recovered is returned, and told to `onRecovered` as well.
 */
export async function recoverInterruptedSteps(
  root: string,
  options: StepOptions = {},
): Promise<RecoveredStep[]> {
  const recovered: RecoveredStep[] = [];
  await projectStep(
    root,
    {
      ...options,
      onRecovered: (step) => {
        recovered.push(step);
        options.onRecovered?.(step);
      },
    },
    async () => undefined,
  );
  return recovered;
}
