import { AsyncLocalStorage } from 'node:async_hooks';
import { realpath } from 'node:fs/promises';
import { projectPaths } from './paths.js';
import { recoverHeldProject, type RecoveredStep } from './rollback-recovery.js';
import { acquireStepLock, type StepLockHolder } from './step-lock.js';

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
  /** How long to wait for another step before refusing with `PROJECT_BUSY`. */
  waitMs?: number;
}

/** Ten seconds: a step on a large project takes a few. */
export const DEFAULT_STEP_WAIT_MS = 10_000;

/** The project roots the current asynchronous call chain holds a step on. */
const holding = new AsyncLocalStorage<ReadonlySet<string>>();

export async function projectStep<T>(
  root: string,
  options: StepOptions | undefined,
  work: () => Promise<T>,
): Promise<T> {
  const paths = projectPaths(root);
  const key = await realpath(paths.root).catch(() => paths.root);
  const held = holding.getStore();
  if (held?.has(key) === true) return work();
  const lock = await acquireStepLock(paths, {
    waitMs: options?.waitMs ?? DEFAULT_STEP_WAIT_MS,
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
