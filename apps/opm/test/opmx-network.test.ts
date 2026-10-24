import { writeFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { runOpmx } from '../src/opmx.js';
import { binPackage, capture, installedProject } from './installed-fixture.js';
import { canSandbox } from './signal-fixture.js';

/**
 * bwrap gives a tool a network of its own unless it is granted the host's, so
 * a server opmx ran (`opmx http-server`) printed its address and nothing could
 * reach it: curl got no answer, and nothing said why. `--allow-network`, or a
 * project's grant to the package, shares the host's network for the run; and a
 * tool that listens without it is told so, with the port, on stderr.
 */

/**
 * `serve <port> <stop file>` answers "served" on 127.0.0.1:<port>, prints
 * "listening" once it does, and exits when the stop file appears.
 */
const serve = binPackage(
  'serve',
  `const { existsSync } = require('node:fs');
const [port, stop] = process.argv.slice(2);
require('node:http')
  .createServer((_, response) => response.end('served\\n'))
  .listen(Number(port), '127.0.0.1', () => process.stdout.write('listening\\n'));
setInterval(() => existsSync(stop) && process.exit(0), 20);
`,
);

/** A port nothing on this host listens on now. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  if (address === null || typeof address === 'string')
    throw new Error('no port');
  return address.port;
}

/** What 127.0.0.1:<port> answers, or the error that says nothing did. */
function get(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const asked = request(
      { host: '127.0.0.1', port, path: '/', agent: false },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => (body += chunk));
        response.on('end', () => resolve(body));
      },
    );
    asked.on('error', reject);
    asked.end();
  });
}

async function until(test: () => boolean, what: string): Promise<void> {
  for (const deadline = Date.now() + 30_000; Date.now() < deadline; ) {
    if (test()) return;
    await sleep(25);
  }
  throw new Error(`never: ${what}`);
}

/**
 * Run `serve` through `opmx` with `flags`, in a project with `opmToml`; once
 * it listens (and, without network, once opmx has said so), ask it, then stop
 * it.
 */
async function served(flags: string[], opmToml = '', said = false) {
  const root = await installedProject([serve], opmToml);
  const port = await freePort();
  const stop = join(root, 'stop');
  const cap = capture();
  const run = runOpmx(
    [...flags, 'serve', '--', String(port), stop],
    cap.io,
    root,
  );
  await until(() => cap.seen.out === 'listening\n', 'the tool listened');
  if (said)
    await until(() => cap.seen.err.includes('listens on port'), 'it was said');
  const answer = await get(port).catch((error: NodeJS.ErrnoException) => ({
    refused: error.code,
  }));
  await writeFile(stop, '');
  return { answer, exit: await run, said: cap.seen.err, port };
}

describe.runIf(canSandbox)('a server opmx runs', () => {
  it('is reached by nothing without network, and opmx says how to grant it', async () => {
    const { answer, exit, said, port } = await served([], '', true);
    expect(answer).toEqual({ refused: 'ECONNREFUSED' });
    expect(exit).toBe(0);
    expect(said).toBe(
      `opmx: the tool listens on port ${port}, but has no network: nothing outside its sandbox can reach it. Run it with --allow-network to share this host's network.\n`,
    );
  }, 120_000);

  it('is reached with --allow-network, and nothing is said', async () => {
    const { answer, exit, said } = await served(['--allow-network']);
    expect([answer, exit, said]).toEqual(['served\n', 0, '']);
  }, 120_000);

  it('is reached when the project grants its package network', async () => {
    const { answer, exit, said } = await served(
      [],
      '[sandbox.packages."pkg:npm/serve"]\nnetwork = true',
    );
    expect([answer, exit, said]).toEqual(['served\n', 0, '']);
  }, 120_000);
});

describe('opmx --allow-network', () => {
  it('is read before the tool’s name, and is the tool’s own after it', async () => {
    const { parseForTest } = await import('../src/opmx.js');
    expect(
      parseForTest(['--allow-network', 'pkg:npm/serve', '--allow-network']),
    ).toEqual(
      expect.objectContaining({
        allowNetwork: true,
        positionals: ['pkg:npm/serve'],
        passthrough: ['--allow-network'],
      }),
    );
    expect(parseForTest(['serve'])).toEqual(
      expect.objectContaining({ allowNetwork: false }),
    );
  });
});

describe.skipIf(canSandbox)('a server opmx runs', () => {
  it.skip('needs bwrap (/usr/bin/bwrap); not checked on this host', () => {});
});
