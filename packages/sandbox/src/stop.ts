/**
 * What ended a run before its process ended by itself, carried as the reason
 * of the AbortSignal that ended it: a signal that reached the caller (opmx
 * holds SIGINT, SIGTERM and SIGHUP while a tool runs), or the policy's
 * timeout, which the sandbox gives its own signal. Anything else that aborts
 * a run is an abort, and is told as one.
 */
export type RunStop =
  | { readonly stop: 'signal'; readonly signal: NodeJS.Signals }
  | { readonly stop: 'timeout'; readonly timeoutMs: number };

/** The reason to abort a run with when `signal` reached its caller. */
export function stoppedBySignal(signal: NodeJS.Signals): RunStop {
  return { stop: 'signal', signal };
}

/** The reason the sandbox aborts a run with once `timeoutMs` has passed. */
export function stoppedByTimeout(timeoutMs: number): RunStop {
  return { stop: 'timeout', timeoutMs };
}

function isRunStop(reason: unknown): reason is RunStop {
  if (typeof reason !== 'object' || reason === null) return false;
  // SAFETY: Only the two fields read below are trusted, each by its own check.
  const candidate = reason as { stop?: unknown; signal?: unknown };
  return (
    (candidate.stop === 'signal' &&
      typeof candidate.signal === 'string' &&
      /^SIG[A-Z0-9]+$/u.test(candidate.signal)) ||
    (candidate.stop === 'timeout' &&
      Number.isSafeInteger((reason as { timeoutMs?: unknown }).timeoutMs))
  );
}

/** The signal `reason` says reached the caller, if it says one did. */
export function stopSignal(reason: unknown): NodeJS.Signals | undefined {
  return isRunStop(reason) && reason.stop === 'signal'
    ? reason.signal
    : undefined;
}

/** What the sandbox says, on a line of its own, about a run `reason` ended. */
export function stopMessage(reason: unknown): string {
  const what = !isRunStop(reason)
    ? 'process aborted'
    : reason.stop === 'signal'
      ? `process stopped by ${reason.signal}`
      : `process timed out after ${reason.timeoutMs} ms`;
  return `openpacker sandbox: ${what}\n`;
}
