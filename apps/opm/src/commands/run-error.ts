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
