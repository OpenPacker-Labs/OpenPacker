/** Helpers shared by the tests of `startChild` and `runChild`. */
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  processHost,
  type ChildHost,
  type ChildSpec,
} from '../src/commands/run-child.js';

export function capture() {
  let out = '';
  let err = '';
  return {
    io: {
      stdout: { write: (s: string) => ((out += s), true) },
      stderr: { write: (s: string) => ((err += s), true) },
    },
    get out() {
      return out;
    },
    get err() {
      return err;
    },
  };
}

export function node(args: string[]): ChildSpec {
  return {
    plan: {
      file: process.execPath,
      args,
      windowsVerbatimArguments: false,
    },
    cwd: tmpdir(),
    env: { PATH: process.env.PATH ?? '' },
    label: 'test child',
  };
}

export async function waitFor(
  condition: () => boolean,
  ms = 5000,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Running, and not a zombie waiting for a parent that will never reap it. */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    // "<pid> (<name>) <state> ..." and the name may hold spaces and brackets.
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return (
      stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z'
    );
  } catch {
    const state = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], {
      encoding: 'utf8',
    }).stdout.trim();
    return state !== '' && !state.startsWith('Z');
  }
}

/** A host whose signals the test sends, and whose terminal state it chooses. */
export function testHost(hasTerminal: boolean) {
  const signals = new EventEmitter();
  const host: ChildHost = {
    ...processHost,
    hasTerminal,
    onSignal(signal, listener) {
      signals.on(signal, listener);
      return () => {
        signals.off(signal, listener);
      };
    },
  };
  return { host, signals };
}
