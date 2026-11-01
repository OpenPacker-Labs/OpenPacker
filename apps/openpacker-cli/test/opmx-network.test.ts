import { spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import { open, writeFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { runOpmx } from '../src/opmx.js';
import {
  INSTALLED_TIMEOUT_MS,
  binPackage,
  capture,
  installedProject,
} from './installed-fixture.js';
import { canSandbox } from './signal-fixture.js';

/**
 * bwrap gives a tool a network of its own unless it is granted the host's, so
 * a server opmx ran (`opmx http-server`) printed its address and nothing could
 * reach it: curl got no answer, and nothing said why. `--allow-network`, or a
 * project's grant to the package, shares the host's network for the run; and a
 * tool that listens without it is told so, with the port, on stderr.
 */

/**
 * `serve <port> <fifo>` answers "served" on 127.0.0.1:<port>, prints
 * "listening" once it does, and exits once the FIFO is written and closed.
 */
const serve = binPackage(
  'serve',
  `const [port, stop] = process.argv.slice(2);
require('node:http')
  .createServer((_, response) => response.end('served\\n'))
  .listen(Number(port), '127.0.0.1', () => process.stdout.write('listening\\n'));
require('node:fs').readFile(stop, () => process.exit(0));
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

/** A FIFO at `path`, written and closed when the test ends should the tool still read it. */
function stopper(path: string): string {
  expect(spawnSync('mkfifo', [path]).status).toBe(0);
  onTestFinished(async () => {
    // Opened without blocking, it fails when nothing reads it any more.
    const reader = await open(
      path,
      constants.O_WRONLY | constants.O_NONBLOCK,
    ).catch(() => undefined);
    await reader?.close();
  });
  return path;
}

/**
 * Run `serve` through `opmx` with `flags`, in a project with `opmToml`; once
 * it listens (and, without network, once opmx has said so), ask it, then stop
 * it.
 */
async function served(flags: string[], opmToml = '', said = false) {
  const root = await installedProject([serve], opmToml);
  const port = await freePort();
  const stop = stopper(join(root, 'stop'));
  const cap = capture();
  const run = runOpmx(
    [...flags, 'serve', '--', String(port), stop],
    cap.io,
    root,
  );
  await cap.until(() => cap.seen.out === 'listening\n', run);
  if (said)
    await cap.until(() => cap.seen.err.includes('listens on port'), run);
  const answer = await get(port).catch((error: NodeJS.ErrnoException) => ({
    refused: error.code,
  }));
  await writeFile(stop, 'stop\n');
  return { answer, exit: await run, said: cap.seen.err, port };
}

describe.runIf(canSandbox)(
  'a server opmx runs',
  { timeout: INSTALLED_TIMEOUT_MS },
  () => {
    it('is reached by nothing without network, and opmx says how to grant it', async () => {
      const { answer, exit, said, port } = await served([], '', true);
      expect(answer).toEqual({ refused: 'ECONNREFUSED' });
      expect(exit).toBe(0);
      expect(said).toBe(
        `opmx: the tool listens on port ${port}; nothing outside its sandbox can reach it. If you meant to reach it from this host, --allow-network shares this host's network, which also gives the tool outbound network and this host's loopback services.\n`,
      );
    });

    it('is reached with --allow-network, and nothing is said', async () => {
      const { answer, exit, said } = await served(['--allow-network']);
      expect([answer, exit, said]).toEqual(['served\n', 0, '']);
    });

    it('is reached when the project grants its package network', async () => {
      const { answer, exit, said } = await served(
        [],
        '[sandbox.packages."pkg:npm/serve"]\nnetwork = true',
      );
      expect([answer, exit, said]).toEqual(['served\n', 0, '']);
    });
  },
);

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
