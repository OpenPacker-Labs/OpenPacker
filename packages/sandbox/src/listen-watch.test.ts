import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it, onTestFinished } from 'vitest';
import {
  createNativeBackend,
  findTrustedSandboxHelper,
} from './backends/native.js';
import { isolatedListenPort } from './listen-watch.js';
import { runInSandbox } from './run.js';
import { heard } from './test-output.js';
import { scratch } from './test-scratch.js';

/**
 * A server run without network listens in a network namespace of its own and
 * is reached by nothing outside it, and nothing said so: `opmx http-server`
 * printed its address and curl got no answer. The bwrap backend tells the
 * caller the port the process listens on there, so the caller can say how to
 * grant network.
 */

const nativeBackend = createNativeBackend();
const bwrapReady =
  process.platform === 'linux' &&
  findTrustedSandboxHelper('bwrap') !== undefined &&
  nativeBackend?.id === 'native-bwrap';

/** A server on a port the system picks, which prints that port. */
const SERVER =
  "const s = require('node:http').createServer();" +
  "s.listen(0, '127.0.0.1', () => process.stdout.write(s.address().port + '\\n'));";

/**
 * The same server, which also ends when its standard input closes: a server
 * this test starts itself ends with the test's process, however that ends,
 * and is never left listening with init as its parent.
 */
const OWN_SERVER = `${SERVER}process.stdin.on('end', () => process.exit(0));process.stdin.resume();`;

/** Whether `pid` names a process that has not ended; one ended and not yet reaped by its parent has. */
function running(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const state = stat.slice(
      stat.lastIndexOf(')') + 2,
      stat.lastIndexOf(')') + 3,
    );
    return state !== 'Z' && state !== 'X';
  } catch {
    return false;
  }
}

/**
 * End `child`, and `server` (a process it started) when there is one, and
 * wait until both are gone: run when the test finishes, passed, failed or
 * timed out.
 */
async function reap(child: ChildProcess, server?: () => number | undefined) {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise<void>((settle) =>
      child.once('exit', () => settle()),
    );
    child.kill('SIGKILL');
    await exited;
  }
  const pid = server?.();
  if (pid === undefined) return;
  // bwrap's own child dies with bwrap (`--die-with-parent`); one that has
  // not yet is ended here, and waited for.
  if (running(pid)) process.kill(pid, 'SIGKILL');
  while (running(pid)) await new Promise((settle) => setTimeout(settle, 10));
}

describe.runIf(bwrapReady)('a process run without network', () => {
  it('is said to listen, on the port it listens on', async () => {
    const root = scratch('op-sandbox-listen-');
    const { seen, output, until } = heard();
    const told: number[] = [];
    let tell: () => void = () => undefined;
    const listened = new Promise<void>((settle) => (tell = settle));
    const stop = new AbortController();
    const run = runInSandbox({
      argv: [process.execPath, '-e', SERVER],
      cwd: root,
      policy: { enabled: true, mode: 'fail-closed', required: true },
      readwritePaths: [],
      readonlyPaths: [root],
      backend: nativeBackend!,
      output,
      onIsolatedListen: (port) => {
        told.push(port);
        tell();
      },
      signal: stop.signal,
    });
    await until(() => seen.stdout.endsWith('\n'), run);
    await Promise.race([
      listened,
      run.then(() => {
        throw new Error('the run ended before it was said to listen');
      }),
    ]);
    stop.abort();
    await run;
    expect(told).toEqual([Number(seen.stdout.trim())]);
  });
});

describe.runIf(bwrapReady)('a process listed as the root’s child', () => {
  it('is read only while it is the root’s child, not as another process its pid names', async () => {
    // A server in a network namespace of its own, started by bwrap: its
    // parent is bwrap, not this process.
    // `--die-with-parent`: the server dies with bwrap, and bwrap with this
    // process, so neither outlives the test however it ends.
    const child = spawn(
      '/usr/bin/bwrap',
      [
        '--dev-bind',
        '/',
        '/',
        '--unshare-net',
        '--die-with-parent',
        process.execPath,
        '-e',
        OWN_SERVER,
      ],
      { stdio: ['pipe', 'pipe', 'ignore'] },
    );
    let serverPid: number | undefined;
    onTestFinished(() => reap(child, () => serverPid));
    let printed = '';
    await new Promise<void>((settle, fail) => {
      child.stdout.on('data', (chunk: Buffer) => {
        printed += chunk.toString('utf8');
        if (printed.endsWith('\n')) settle();
      });
      child.once('exit', (code) =>
        fail(new Error(`the server ended (${code}) having printed ${printed}`)),
      );
    });
    const port = Number(printed.trim());
    const [server] = readFileSync(
      `/proc/${child.pid}/task/${child.pid}/children`,
      'utf8',
    )
      .trim()
      .split(/\s+/u)
      .map(Number);
    serverPid = server;
    // The control: read as bwrap's child, it is said to listen.
    expect(isolatedListenPort(child.pid!)).toBe(port);
    // Listed as this process's child, as a pid given to another process
    // would be, it is not this process's, and is not read.
    expect(isolatedListenPort(process.pid, () => [server!])).toBeUndefined();
  });
});

describe.skipIf(bwrapReady)('a process run without network', () => {
  it.skip('needs bwrap (/usr/bin/bwrap); not checked on this host', () => {});
});

describe.runIf(process.platform === 'linux')(
  'a process that listens in the caller’s own network namespace',
  () => {
    it('is not said to, as a run that shares the host’s network is not', async () => {
      const child = spawn(process.execPath, ['-e', OWN_SERVER], {
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      onTestFinished(() => reap(child));
      let printed = '';
      await new Promise<void>((settle, fail) => {
        child.stdout.on('data', (chunk: Buffer) => {
          printed += chunk.toString('utf8');
          if (printed.endsWith('\n')) settle();
        });
        child.once('exit', (code) =>
          fail(
            new Error(`the server ended (${code}) having printed ${printed}`),
          ),
        );
      });
      const port = Number(printed.trim());
      // The control: the port is listened on, in the table the watch reads.
      const hex = port.toString(16).toUpperCase().padStart(4, '0');
      expect(
        readFileSync(`/proc/${child.pid}/net/tcp`, 'utf8')
          .split('\n')
          .some((row) => {
            const [, local, , state] = row.trim().split(/\s+/u);
            return local?.endsWith(`:${hex}`) && state === '0A';
          }),
      ).toBe(true);
      expect(isolatedListenPort(process.pid)).toBeUndefined();
    });
  },
);
