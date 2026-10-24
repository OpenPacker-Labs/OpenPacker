import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it, onTestFinished } from 'vitest';
import {
  createNativeBackend,
  findTrustedSandboxHelper,
} from './backends/native.js';
import { isolatedListenPort } from './listen-watch.js';
import { runInSandbox } from './run.js';
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

async function until(test: () => boolean): Promise<void> {
  for (const deadline = Date.now() + 20_000; Date.now() < deadline; ) {
    if (test()) return;
    await sleep(25);
  }
  throw new Error('the condition never held');
}

describe.runIf(bwrapReady)('a process run without network', () => {
  it('is said to listen, on the port it listens on', async () => {
    const root = scratch('op-sandbox-listen-');
    let printed = '';
    const told: number[] = [];
    const stop = new AbortController();
    const run = runInSandbox({
      argv: [process.execPath, '-e', SERVER],
      cwd: root,
      policy: { enabled: true, mode: 'fail-closed', required: true },
      readwritePaths: [],
      readonlyPaths: [root],
      backend: nativeBackend!,
      output: {
        stdout: (chunk) => {
          printed += Buffer.from(chunk).toString('utf8');
        },
        stderr: () => undefined,
      },
      onIsolatedListen: (port) => told.push(port),
      signal: stop.signal,
    });
    await until(() => printed.endsWith('\n') && told.length > 0);
    stop.abort();
    await run;
    expect(told).toEqual([Number(printed.trim())]);
  }, 30_000);
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
      child.stdout.on('data', (chunk: Buffer) => (printed += chunk));
      await until(() => printed.endsWith('\n'));
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
