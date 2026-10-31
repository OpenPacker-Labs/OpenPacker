import { spawn } from 'node:child_process';
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
    // parent is bwrap, not this process. Both are a process group of their
    // own, ended together: killing bwrap alone leaves the server running,
    // its parent gone, past the test and the run.
    const child = spawn(
      '/usr/bin/bwrap',
      ['--dev-bind', '/', '/', '--unshare-net', process.execPath, '-e', SERVER],
      { stdio: ['ignore', 'pipe', 'ignore'], detached: true },
    );
    onTestFinished(() => {
      process.kill(-child.pid!, 'SIGKILL');
    });
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
      const child = spawn(process.execPath, ['-e', SERVER], {
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      onTestFinished(() => {
        child.kill('SIGKILL');
      });
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
