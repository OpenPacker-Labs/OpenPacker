import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { stoppedBySignal } from '@openpacker/opm-project';
import { spawnTool } from '../src/opmx-spawn.js';
import { canSandbox } from './signal-fixture.js';

/**
 * A tool's output reaches opmx's stdout and stderr as the tool writes it. It
 * used to be kept until the tool ended, so a server (`opmx http-server`)
 * printed nothing while it served, and only what it had said once stopped.
 */

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe.runIf(canSandbox)('opmx runs a tool that keeps running', () => {
  it('hands on what it writes while it runs', async () => {
    const tool = await mkdtemp(join(tmpdir(), 'opmx-stream-'));
    temps.push(tool);
    const server = join(tool, 'server.js');
    await writeFile(
      server,
      "process.stdout.write('listening\\n');\n" +
        "process.stderr.write('ready\\n');\n" +
        'setInterval(() => {}, 1000);\n',
    );
    const seen = { out: '', err: '' };
    const io = {
      stdout: {
        write: (chunk: string | Uint8Array) => (
          (seen.out += Buffer.from(chunk).toString('utf8')),
          true
        ),
      },
      stderr: {
        write: (chunk: string | Uint8Array) => (
          (seen.err += Buffer.from(chunk).toString('utf8')),
          true
        ),
      },
    };
    const stop = new AbortController();
    const run = spawnTool(server, [], io, tool, {
      storePaths: [tool],
      signal: stop.signal,
    });
    for (const until = Date.now() + 15_000; Date.now() < until; ) {
      if (seen.out !== '' && seen.err !== '') break;
      await sleep(25);
    }
    const whileRunning = { ...seen };
    // As opmx aborts the run when it is sent SIGINT (opmx-signals.ts).
    stop.abort(stoppedBySignal('SIGINT'));
    const exit = await run;
    expect(whileRunning).toEqual({ out: 'listening\n', err: 'ready\n' });
    // Stopped by the signal opmx holds; the sandbox says so, once, after it.
    expect(exit).toBe(124);
    expect(seen).toEqual({
      out: 'listening\n',
      err: 'ready\n\nopenpacker sandbox: process stopped by SIGINT\n',
    });
  }, 60_000);

  it('writes a character a chunk splits whole, with the next chunk', async () => {
    const tool = await mkdtemp(join(tmpdir(), 'opmx-stream-'));
    temps.push(tool);
    const split = join(tool, 'split.js');
    // The euro sign is three bytes; the first two go out on their own.
    await writeFile(
      split,
      'process.stdout.write(Buffer.from([0xe2, 0x82]));\n' +
        'setTimeout(() => process.stdout.write(Buffer.from([0xac, 0x0a])), 300);\n',
    );
    const writes: string[] = [];
    const io = {
      stdout: { write: (chunk: string) => (writes.push(chunk), true) },
      stderr: { write: () => true },
    };
    expect(await spawnTool(split, [], io, tool, { storePaths: [tool] })).toBe(
      0,
    );
    expect(writes).toEqual(['\u20ac\n']);
  }, 60_000);
});

describe.skipIf(canSandbox)('opmx runs a tool that keeps running', () => {
  it.skip('needs bwrap (/usr/bin/bwrap); not checked on this host', () => {});
});
