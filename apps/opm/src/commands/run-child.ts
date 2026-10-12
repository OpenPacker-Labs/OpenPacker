/**
 * Start a child on the person's own authority and report how it ended
 * (ADR 0047).
 *
 * The child's stdin, stdout and stderr are the process's own whenever `opm`
 * writes to them, so a terminal stays a terminal. When a caller supplies other
 * streams (a test, an embedding host) the child's output is piped and written
 * to them instead.
 *
 * Termination signals are forwarded. With no terminal on any of the three
 * streams the child is started with `detached`, which is `setsid`: a session
 * and process group of its own (and no controlling terminal, which a process
 * with every stream redirected has no use for). The signal goes to the whole
 * group, so `a && b` and anything either started goes with it. With a
 * terminal the child stays in the foreground group the terminal already signals
 * (a child in a group of its own would be stopped the moment it read the
 * terminal), so SIGINT is left to the terminal, and SIGTERM and SIGHUP go to
 * the child.
 *
 * One exception, whatever `opm` itself has: a child that is handed none of the
 * terminal's streams (stdin ignored, both outputs piped, which is every child
 * of a run over several members) gets a group of its own. It cannot read the
 * terminal, so nothing stops it there, and the alternative is worse than a
 * group: a signal to the child alone leaves what it started running with the
 * output pipes open, `close` never comes, and `opm` waits for them. `SIGINT`
 * is forwarded to such a child, because the terminal signals `opm`'s group and
 * the child is no longer in it.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { constants } from 'node:os';
import { RunError } from './run-error.js';
import type { SpawnPlan } from './run-command-line.js';

export interface ChildIo {
  stdout: Pick<NodeJS.WriteStream, 'write'>;
  stderr: Pick<NodeJS.WriteStream, 'write'>;
}

/** The parts of the process a child run touches; tests replace them. */
export interface ChildHost {
  platform: NodeJS.Platform;
  /** Whether stdin, stdout or stderr is a terminal. */
  hasTerminal: boolean;
  spawn: typeof spawn;
  /** Listen for a signal sent to `opm`; returns how to stop listening. */
  onSignal: (signal: NodeJS.Signals, listener: () => void) => () => void;
  /** Send a signal to a process, or to a group when `pid` is negative. */
  kill: (pid: number, signal: NodeJS.Signals) => void;
  /** The streams `opm` itself writes to. */
  stdout: unknown;
  stderr: unknown;
}

export const processHost: ChildHost = {
  platform: process.platform,
  get hasTerminal() {
    return Boolean(
      process.stdin.isTTY || process.stdout.isTTY || process.stderr.isTTY,
    );
  },
  spawn,
  onSignal(signal, listener) {
    process.on(signal, listener);
    return () => {
      process.off(signal, listener);
    };
  },
  kill: (pid, signal) => {
    process.kill(pid, signal);
  },
  stdout: process.stdout,
  stderr: process.stderr,
};

export interface ChildSpec {
  plan: SpawnPlan;
  cwd: string;
  env: Record<string, string>;
  /** Names the command in errors; never the environment. */
  label: string;
  /**
   * What the child reads. `inherit` (the default) is `opm`'s own stdin;
   * `ignore` is for a run that starts several children at once, where none of
   * them can own the terminal.
   */
  stdin?: 'inherit' | 'ignore';
}

export interface ChildOutcome {
  /** The exit status, or `undefined` when a signal ended the child. */
  code: number | undefined;
  signal: NodeJS.Signals | undefined;
}

/** A started child: how it ends, and how to send it a signal. */
export interface RunningChild {
  /** Settles when the child has ended; rejects with `UNAVAILABLE` if it never started. */
  readonly outcome: Promise<ChildOutcome>;
  /**
   * Send a signal by the rules a signal sent to `opm` follows: to the child's
   * whole group when it has one, to the child alone when a terminal owns the
   * group (and then never `SIGINT`, which the terminal already delivered). A
   * child that has ended is left alone.
   */
  signal(signal: NodeJS.Signals): void;
}

/** Signals a person or a supervisor sends to stop `opm`. */
export const FORWARDED: readonly NodeJS.Signals[] = [
  'SIGINT',
  'SIGTERM',
  'SIGHUP',
];

/** The shell's number for how a child ended: its status, or 128 + signal. */
export function exitStatus(outcome: ChildOutcome): number {
  if (outcome.code !== undefined) return outcome.code;
  const number = outcome.signal ? constants.signals[outcome.signal] : undefined;
  return 128 + (number ?? 0);
}

/**
 * Start a child and return at once. The caller owns the signals: a single run
 * subscribes the process to them ({@link runChild}), a run of many children
 * subscribes once and fans each signal out.
 */
export function startChild(
  spec: ChildSpec,
  io: ChildIo,
  host: ChildHost = processHost,
): RunningChild {
  const direct = (stream: unknown, own: unknown) => stream === own;
  const stdout = direct(io.stdout, host.stdout) ? 'inherit' : 'pipe';
  const stderr = direct(io.stderr, host.stderr) ? 'inherit' : 'pipe';
  // Handed no stream of the terminal, a child has nothing to lose by a group
  // of its own, whether or not `opm` has a terminal.
  const handedNoTerminal =
    spec.stdin === 'ignore' && stdout === 'pipe' && stderr === 'pipe';
  const grouped =
    host.platform !== 'win32' && (handedNoTerminal || !host.hasTerminal);
  let child: ChildProcess | undefined;

  const outcome = new Promise<ChildOutcome>((resolve, reject) => {
    try {
      child = host.spawn(spec.plan.file, spec.plan.args, {
        cwd: spec.cwd,
        env: spec.env,
        stdio: [spec.stdin ?? 'inherit', stdout, stderr],
        detached: grouped,
        windowsHide: true,
        windowsVerbatimArguments: spec.plan.windowsVerbatimArguments,
      });
    } catch (error) {
      reject(spawnFailure(spec, error));
      return;
    }
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => io.stdout.write(chunk));
    child.stderr?.on('data', (chunk: string) => io.stderr.write(chunk));
    child.once('error', (error) => {
      reject(spawnFailure(spec, error));
    });
    child.once('close', (code, signal) => {
      resolve({ code: code ?? undefined, signal: signal ?? undefined });
    });
  });

  const signal = (name: NodeJS.Signals) => {
    if (child === undefined) return;
    if (child.exitCode !== null || child.signalCode !== null) return;
    // The terminal has already sent SIGINT to the child's group, and sending
    // it again would turn "stop gracefully" into "stop now" for tools that
    // read a second one that way. A grouped child has no terminal to do so.
    if (name === 'SIGINT' && !grouped) return;
    try {
      if (grouped && child.pid !== undefined) host.kill(-child.pid, name);
      else child.kill(name);
    } catch {
      // The child ended between the check and the signal.
    }
  };
  return { outcome, signal };
}

/** Run a child to its end, forwarding the signals sent to `opm` meanwhile. */
export async function runChild(
  spec: ChildSpec,
  io: ChildIo,
  host: ChildHost = processHost,
): Promise<ChildOutcome> {
  const running = startChild(spec, io, host);
  const release = FORWARDED.map((name) =>
    host.onSignal(name, () => {
      running.signal(name);
    }),
  );
  try {
    return await running.outcome;
  } finally {
    for (const stop of release) stop();
  }
}

function spawnFailure(spec: ChildSpec, error: unknown): RunError {
  const detail = error instanceof Error ? error.message : String(error);
  return new RunError('UNAVAILABLE', `Cannot start ${spec.label}: ${detail}`);
}
