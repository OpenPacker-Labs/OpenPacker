/**
 * Failures of `opm run` and `opm exec`.
 *
 * A class of its own, not `OpmError`, so the commands that start the person's
 * scripts do not load `@openpacker/opm-project` (and with it every adapter) to
 * report that a script is missing. `handleError` in `opm.ts` maps the code to
 * an exit status.
 */
export type RunErrorCode =
  | 'USAGE'
  | 'NOT_FOUND'
  | 'INVALID_MANIFEST'
  | 'UNAVAILABLE'
  | 'UNSAFE_PATH';

export class RunError extends Error {
  readonly code: RunErrorCode;

  constructor(code: RunErrorCode, message: string) {
    super(message);
    this.name = 'RunError';
    this.code = code;
  }
}

/** A misuse of the command line, with the pointer every usage error ends in. */
export function usageError(message: string): RunError {
  return new RunError('USAGE', `${message} (opm --help shows the usage)`);
}

/**
 * `plainLine`, for text a project's files chose: one line, with no escape or
 * control character, nothing cut. Loaded when a message needs it, because
 * starting a script imports nothing but Node and this directory (ADR 0047,
 * `run-load.test.ts`); listing scripts and explaining a failure are the rare
 * paths.
 */
export async function plain(): Promise<(text: string) => string> {
  return (await import('@openpacker/canonical')).plainLine;
}

/**
 * A path quoted in a message. A directory a cloned repository holds may be named
 * with a line feed or an escape, and a message that is a list keeps its own line
 * feeds, so what it quotes is made one plain line where it is quoted.
 */
export async function quoted(path: string): Promise<string> {
  return (await plain())(path);
}
