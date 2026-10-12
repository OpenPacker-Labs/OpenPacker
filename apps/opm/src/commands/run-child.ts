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
}

export interface ChildOutcome {
  /** The exit status, or `undefined` when a signal ended the child. */
  code: number | undefined;
  signal: NodeJS.Signals | undefined;
}

/** Signals a person or a supervisor sends to stop `opm`. */
const FORWARDED: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/** The shell's number for how a child ended: its status, or 128 + signal. */
export function exitStatus(outcome: ChildOutcome): number {
  if (outcome.code !== undefined) return outcome.code;
  const number = outcome.signal ? constants.signals[outcome.signal] : undefined;
  return 128 + (number ?? 0);
}

export async function runChild(
  spec: ChildSpec,
  io: ChildIo,
  host: ChildHost = processHost,
): Promise<ChildOutcome> {
  const direct = (stream: unknown, own: unknown) => stream === own;
  const stdout = direct(io.stdout, host.stdout) ? 'inherit' : 'pipe';
  const stderr = direct(io.stderr, host.stderr) ? 'inherit' : 'pipe';
  const grouped = host.platform !== 'win32' && !host.hasTerminal;

  return await new Promise<ChildOutcome>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = host.spawn(spec.plan.file, spec.plan.args, {
        cwd: spec.cwd,
        env: spec.env,
        stdio: ['inherit', stdout, stderr],
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

    const deliver = (signal: NodeJS.Signals) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      // The terminal has already sent SIGINT to the child's group, and sending
      // it again would turn "stop gracefully" into "stop now" for tools that
      // read a second one that way. A grouped child has no terminal to do so.
      if (signal === 'SIGINT' && !grouped) return;
      try {
        if (grouped && child.pid !== undefined) host.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        // The child ended between the check and the signal.
      }
    };
    const release = FORWARDED.map((signal) =>
      host.onSignal(signal, () => deliver(signal)),
    );

    child.once('error', (error) => {
      for (const stop of release) stop();
      reject(spawnFailure(spec, error));
    });
    child.once('close', (code, signal) => {
      for (const stop of release) stop();
      resolve({ code: code ?? undefined, signal: signal ?? undefined });
    });
  });
}

function spawnFailure(spec: ChildSpec, error: unknown): RunError {
  const detail = error instanceof Error ? error.message : String(error);
  return new RunError('UNAVAILABLE', `Cannot start ${spec.label}: ${detail}`);
}
