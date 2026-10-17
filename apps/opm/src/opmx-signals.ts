/** The signals that stop a run from a terminal or a service manager. */
const HELD = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

/**
 * Run `body` with SIGINT, SIGTERM and SIGHUP held for as long as it runs.
 *
 * A run makes directories it must remove (a store view, a tool's layout), and
 * a signal's default action ends opmx before it can. Held, the first of them
 * aborts the signal `body` is given, which ends the sandboxed process tree;
 * `body` then removes what it made, and the same signal is raised again with
 * opmx's own handlers gone, so opmx ends as that signal says (by it, as the
 * shell sees it), exactly as it would have.
 */
export async function holdingSignals<T>(
  body: (signal: AbortSignal) => Promise<T>,
  raise: (signal: NodeJS.Signals) => void = (signal) =>
    process.kill(process.pid, signal),
): Promise<T> {
  const controller = new AbortController();
  let received: NodeJS.Signals | undefined;
  const handlers = HELD.map((name) => {
    const handler = () => {
      received ??= name;
      controller.abort();
    };
    process.on(name, handler);
    return [name, handler] as const;
  });
  try {
    return await body(controller.signal);
  } finally {
    for (const [name, handler] of handlers) process.off(name, handler);
    if (received !== undefined) raise(received);
  }
}
