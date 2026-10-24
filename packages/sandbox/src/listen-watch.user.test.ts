import { spawnSync } from 'node:child_process';
import { chmod, chown, mkdir, mkdtemp, rm } from 'node:fs/promises';
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
    stdout: (chunk) => (printed += Buffer.from(chunk).toString('utf8')),
    stderr: () => undefined,
  },
  onIsolatedListen: (port) => told.push(port),
  signal: stop.signal,
});
for (const until = Date.now() + 20000; Date.now() < until; ) {
  if (told.length > 0 && printed.endsWith('\\n')) break;
  await new Promise((resolve) => setTimeout(resolve, 25));
}
stop.abort();
await run;
process.stdout.write(JSON.stringify({ uid: process.getuid(), printed, told }));
`;

const temps: string[] = [];
afterEach(async () => {
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
    const base = await mkdtemp(join(tmpdir(), 'op-listen-user-'));
    temps.push(base);
    await chmod(base, 0o755);
    // The child's own temporary directory (its jail root) and working directory.
    const own = join(base, 'tmp');
    const work = join(base, 'work');
    for (const dir of [own, work]) {
      await mkdir(dir);
      await chown(dir, NOBODY, NOBODY);
    }
    const ran = spawnSync(
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
        encoding: 'utf8',
        timeout: 60_000,
      },
    );
    context.skip(
      ran.status !== 0 && /EACCES|cannot open|Cannot find/u.test(ran.stderr),
      `a child run as uid ${NOBODY} cannot reach the sources or the temporary directory here: ${ran.stderr.slice(0, 200)}`,
    );
    expect(ran.status, ran.stderr).toBe(0);
    const seen = JSON.parse(ran.stdout) as {
      uid: number;
      printed: string;
      told: number[];
    };
    expect(seen.uid).toBe(NOBODY);
    expect(seen.told).toEqual([Number(seen.printed.trim())]);
  }, 90_000);
});
