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
 *
 * A second signal while `body` is still removing what it made means the
 * sender will not wait: it is raised at once, with the handlers gone, and opmx
 * ends by it without finishing. The tree was already ended by the first
 * (`--die-with-parent` ends it again with opmx); what was left is removed by
 * the next run in the same place, as for a run killed outright.
 */
export async function holdingSignals<T>(
  body: (signal: AbortSignal) => Promise<T>,
  raise: (signal: NodeJS.Signals) => void = (signal) =>
    process.kill(process.pid, signal),
): Promise<T> {
  const controller = new AbortController();
  let received: NodeJS.Signals | undefined;
  let escalated = false;
  const handlers = HELD.map((name) => {
    const handler = () => {
      if (received === undefined) {
        received = name;
        controller.abort();
        return;
      }
      escalated = true;
      release();
      raise(name);
    };
    process.on(name, handler);
    return [name, handler] as const;
  });
  const release = () => {
    for (const [name, handler] of handlers) process.off(name, handler);
  };
  try {
    return await body(controller.signal);
  } finally {
    release();
    if (received !== undefined && !escalated) raise(received);
  }
}
