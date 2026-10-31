import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, chown, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { findTrustedSandboxHelper } from './backends/native.js';

/**
 * The listen hint, for a user who is not root. Run by root, bwrap makes the
 * run's namespaces itself; run by anyone else it makes them inside a user
 * namespace of its own, and the processes there are no longer plainly the
 * caller's. Whether the caller may still read `/proc/<pid>/net/tcp` of the
 * first of them is what the hint rests on: here a child run as uid 65534 runs
 * a server through `runInSandbox` with no network, and is told its port.
 */

const NOBODY = 65534;
const { R_OK, W_OK, X_OK } = constants;
const source = fileURLToPath(new URL('.', import.meta.url));
// The resolve hook opm-project's tests use to run TypeScript sources in a child.
const hook = new URL(
  '../../opm-project/test/fixtures/ts-resolve.mjs',
  import.meta.url,
).href;

const SCRIPT = `
const [src] = process.argv.slice(1);
const { createNativeBackend } = await import(src + '/backends/native.ts');
const { runInSandbox } = await import(src + '/run.ts');
const work = process.env.WORK;
let printed = '';
const told = [];
let settle;
const done = new Promise((resolve) => (settle = resolve));
const check = () => {
  if (told.length > 0 && printed.endsWith('\\n')) settle();
};
const stop = new AbortController();
const server = "const s = require('node:http').createServer();" +
  "s.listen(0, '127.0.0.1', () => process.stdout.write(s.address().port + '\\\\n'));";
const run = runInSandbox({
  argv: [process.execPath, '-e', server],
  cwd: work,
  policy: { enabled: true, mode: 'fail-closed', required: true },
  readwritePaths: [],
  readonlyPaths: [work],
  backend: createNativeBackend(),
  output: {
    stdout: (chunk) => {
      printed += Buffer.from(chunk).toString('utf8');
      check();
    },
    stderr: () => undefined,
  },
  onIsolatedListen: (port) => {
    told.push(port);
    check();
  },
  signal: stop.signal,
});
// Done once the port has been told and the server has printed its own;
// or once the run has ended without that, which the parent then reports.
await Promise.race([done, run]);
stop.abort();
await run;
process.stdout.write(JSON.stringify({ uid: process.getuid(), printed, told }));
`;

const temps: string[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe.runIf(
  process.platform === 'linux' &&
    process.getuid?.() === 0 &&
    findTrustedSandboxHelper('bwrap') !== undefined,
)('a server run without network by a user who is not root', () => {
  it('is said to listen, on the port it listens on', async (context) => {
    // At its real path: the child is handed these paths, and a TMPDIR that is
    // a link is not its base (ADR 0034: a caller that hands another process an
    // absolute path spells it the real way).
    const base = await realpath(
      await mkdtemp(join(tmpdir(), 'op-listen-user-')),
    );
    temps.push(base);
    await chmod(base, 0o755);
    // The child's own temporary directory (its jail root) and working directory.
    const own = join(base, 'tmp');
    const work = join(base, 'work');
    for (const dir of [own, work]) {
      await mkdir(dir);
      await chown(dir, NOBODY, NOBODY);
    }
    // Whether a child of that uid can reach what the run needs, asked as that
    // uid before the run: only this decides a skip, never the run's output.
    const probe = spawnSync(
      process.execPath,
      [
        '-e',
        'const { accessSync, constants: c } = require("node:fs");' +
          'for (const [path, mode] of JSON.parse(process.argv[1])) accessSync(path, mode);',
        JSON.stringify([
          [source, R_OK | X_OK],
          [fileURLToPath(hook), R_OK],
          [own, R_OK | W_OK | X_OK],
          [work, R_OK | X_OK],
        ]),
      ],
      { uid: NOBODY, gid: NOBODY, encoding: 'utf8' },
    );
    context.skip(
      probe.status !== 0,
      `uid ${NOBODY} cannot reach the sources or its temporary directory here: ${probe.stderr.slice(0, 200)}`,
    );
    const child = spawn(
      process.execPath,
      [
        '--experimental-transform-types',
        '--import',
        hook,
        '--input-type=module',
        '-e',
        SCRIPT,
        source,
      ],
      {
        cwd: work,
        env: { ...process.env, TMPDIR: own, WORK: work, NODE_NO_WARNINGS: '1' },
        uid: NOBODY,
        gid: NOBODY,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    children.push(child);
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    const status = await new Promise((resolve) => child.once('exit', resolve));
    expect(status, stderr).toBe(0);
    const seen = JSON.parse(stdout) as {
      uid: number;
      printed: string;
      told: number[];
    };
    expect(seen.uid).toBe(NOBODY);
    expect(seen.told).toEqual([Number(seen.printed.trim())]);
  });
});
