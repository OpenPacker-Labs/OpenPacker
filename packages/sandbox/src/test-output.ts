import type { OutputSink, SandboxOutcome } from './types.js';

/**
 * What a run hands on, decoded, and a wait for it that ends on what it waits
 * for: a test never polls the clock for a line a run writes. A wait whose run
 * ends first fails at once, with what was written, rather than at the test's
 * timeout.
 */
export function heard() {
  const seen = { stdout: '', stderr: '' };
  const waiting = new Set<{ test: () => boolean; settle: () => void }>();
  const check = () => {
    for (const wait of waiting)
      if (wait.test()) {
        waiting.delete(wait);
        wait.settle();
      }
  };
  const output: OutputSink = {
    stdout: (chunk) => {
      seen.stdout += Buffer.from(chunk).toString('utf8');
      check();
    },
    stderr: (chunk) => {
      seen.stderr += Buffer.from(chunk).toString('utf8');
      check();
    },
  };
  /** Settles once `test` holds of what was written, or fails once `run` ends without it. */
  const until = (
    test: () => boolean,
    run: Promise<SandboxOutcome>,
  ): Promise<void> =>
    test()
      ? Promise.resolve()
      : Promise.race([
          new Promise<void>((settle) => waiting.add({ test, settle })),
          run.then((outcome) => {
            throw new Error(
              `the run ended first (${outcome.exitCode}), having written ${JSON.stringify(seen)}`,
            );
          }),
        ]);
  return { seen, output, until };
}
