import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Told of a write before `writeFileAtomic` makes it, for the code that runs
 * inside {@link observeWrites} and the work it starts, and nobody else.
 *
 * It is how a step that keeps a copy of its project (`opm-project`
 * `project-rollback.ts`) learns what a file is about to hold, so that the copy
 * is put back over the step's own writes and over nothing a person wrote
 * later. The observer is awaited: when it returns, the write may happen; when
 * it throws, the write does not.
 */
export type WriteObserver = (
  path: string,
  contents: string | Uint8Array,
) => Promise<void>;

const observers = new AsyncLocalStorage<WriteObserver>();

/** Run `work` with `observer` told of each `writeFileAtomic` in it (after any observer already in force). */
export function observeWrites<T>(
  observer: WriteObserver,
  work: () => Promise<T>,
): Promise<T> {
  const outer = observers.getStore();
  return observers.run(
    outer === undefined
      ? observer
      : async (path, contents) => {
          await outer(path, contents);
          await observer(path, contents);
        },
    work,
  );
}

/** Tell the observer in force, if any, that `path` is about to hold `contents`. */
export async function announceWrite(
  path: string,
  contents: string | Uint8Array,
): Promise<void> {
  await observers.getStore()?.(path, contents);
}
