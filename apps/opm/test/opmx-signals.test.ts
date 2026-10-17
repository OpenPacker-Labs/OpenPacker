import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import type { EphemeralTool } from '@openpacker/opm-project';
import { holdingSignals } from '../src/opmx-signals.js';

/**
 * A run stopped by Ctrl-C or SIGTERM left its store view or its layout behind:
 * a signal's default action ended opmx before it removed them. opmx now holds
 * the signal while a tool runs, ends the sandboxed process tree, removes what
 * the run made, and then ends by the same signal.
 */

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe('holdingSignals', () => {
  it('turns a signal into an abort, and raises it again once the run is over', async () => {
    const before = process.listenerCount('SIGTERM');
    const raised: string[] = [];
    let aborted = false;
    const result = await holdingSignals(
      async (signal) => {
        process.emit('SIGTERM', 'SIGTERM');
        aborted = signal.aborted;
        // Still held: the run is not over until what it made is removed.
        expect(raised).toEqual([]);
        return 'removed';
      },
      (signal) => raised.push(signal),
    );
    expect([aborted, result, raised]).toEqual([true, 'removed', ['SIGTERM']]);
    expect(process.listenerCount('SIGTERM')).toBe(before);
  });

  it('raises nothing when no signal came', async () => {
    const raised: string[] = [];
    await holdingSignals(
      async () => undefined,
      (signal) => raised.push(signal),
    );
    expect(raised).toEqual([]);
  });
});

const here = dirname(fileURLToPath(import.meta.url));
const viteNode = join(here, '../../../node_modules/.bin/vite-node');

/** Every running process with `marker` among its arguments. */
function withMarker(marker: string): string[][] {
  const found: string[][] = [];
  for (const pid of readdirSync('/proc')) {
    if (!/^\d+$/u.test(pid)) continue;
    try {
      const argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
      if (argv.includes(marker)) found.push(argv);
    } catch {
      // Ended meanwhile.
    }
  }
  return found;
}

async function until(test: () => Promise<boolean> | boolean, what: string) {
  for (let tries = 0; tries < 600; tries += 1) {
    if (await test()) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** A tool cache holding one entry per `files`, the first being the tool's. */
async function cache(files: Record<string, string>[]) {
  const cacheRoot = await mkdtemp(join(tmpdir(), 'opmx-signals-'));
  temps.push(cacheRoot);
  const store = join(cacheRoot, '.opm', 'store');
  const entries: string[] = [];
  for (const [index, tree] of files.entries()) {
    const entry = join(store, `sha256-${index.toString(16).padStart(64, '0')}`);
    for (const [path, body] of Object.entries(tree)) {
      await mkdir(dirname(join(entry, path)), { recursive: true });
      await writeFile(join(entry, path), body);
      if (body.startsWith('#!')) await chmod(join(entry, path), 0o755);
    }
    entries.push(entry);
  }
  const work = join(cacheRoot, '..', `${cacheRoot.split('/').at(-1)}-work`);
  await mkdir(work);
  temps.push(work);
  return { cacheRoot, store, entries, work };
}

/**
 * opmx's run of `tool` in a child process, as `runOpmx` runs it, killed by
 * `signal` once the tool is running; what it leaves behind is then read.
 */
async function signalledRun(
  tool: EphemeralTool,
  work: string,
  signal: NodeJS.Signals,
  made: () => Promise<boolean>,
) {
  const marker = `--opmx-signals-${randomUUID()}`;
  const script = join(work, 'run.ts');
  const source = (path: string) => JSON.stringify(join(here, path));
  await writeFile(
    script,
    `import { configureDefaultAdapters } from '@openpacker/adapters-default';
     import { holdingSignals } from ${source('../src/opmx-signals.ts')};
     import { runTool } from ${source('../src/opmx-spawn.ts')};
     configureDefaultAdapters();
     // opmx runs under plain node, with no signal handler of its own; the
     // runner here (vite-node's Vite server) closes and exits on SIGTERM.
     for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP'])
       process.removeAllListeners(name);
     const tool = ${JSON.stringify(tool)};
     process.exitCode = await holdingSignals((signal) =>
       runTool(tool, tool.bins[0], [${JSON.stringify(marker)}], process, ${JSON.stringify(work)}, signal),
     );
    `,
  );
  const child = spawn(viteNode, [script], {
    cwd: join(here, '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  const exited = new Promise<NodeJS.Signals | number | null>((resolve) =>
    child.on('exit', (code, how) => resolve(how ?? code)),
  );
  // The tool itself, not only bwrap, which carries the same arguments.
  await until(
    () =>
      withMarker(marker).some((argv) => !argv[0]!.endsWith('bwrap')) ||
      child.exitCode !== null,
    'the tool to start',
  );
  expect([child.exitCode, await made()]).toEqual([null, true]);
  child.kill(signal);
  const how = await exited;
  await until(() => withMarker(marker).length === 0, 'the tool to end');
  return { how, output: output.trim() };
}

const canSandbox =
  process.platform === 'linux' &&
  ['/usr/bin/bwrap', '/bin/bwrap'].some((path) => existsSync(path));

describe.runIf(canSandbox)('opmx stopped while a tool runs', () => {
  it(
    'removes the layout of an npm tool, and ends by SIGINT',
    { timeout: 120_000 },
    async () => {
      const { cacheRoot, entries, work } = await cache([
        {
          'package/package.json': JSON.stringify({ name: 'idle' }),
          'package/cli.js': 'setInterval(() => {}, 1000);\n',
        },
      ]);
      const runs = join(cacheRoot, '.opm', 'runs');
      const tool: EphemeralTool = {
        exactPurl: 'pkg:npm/idle@1.0.0',
        digest: `sha256:${'0'.repeat(64)}`,
        storePath: entries[0]!,
        bins: [{ name: 'idle', path: 'package/cli.js' }],
        cached: true,
        runtimePaths: entries,
        cacheRoot,
        closure: [
          {
            exactPurl: 'pkg:npm/idle@1.0.0',
            digest: `sha256:${'0'.repeat(64)}`,
            size: 1,
            source: 'https://registry.npmjs.org/idle/-/idle-1.0.0.tgz',
            storePath: entries[0]!,
          },
        ],
      };
      const made = async () =>
        (await readdir(runs).catch(() => [])).length === 1;
      const { how } = await signalledRun(tool, work, 'SIGINT', made);
      expect(how).toBe('SIGINT');
      expect(await readdir(runs)).toEqual([]);
    },
  );

  it(
    'removes the store view of a tool with more entries than handles, and ends by SIGTERM',
    { timeout: 120_000 },
    async () => {
      // Fifteen entries of one store: one more than the handles left for them.
      const { cacheRoot, store, entries, work } = await cache([
        { 'bin/idle': '#!/bin/sh\nwhile :; do sleep 1; done\n' },
        ...Array.from({ length: 14 }, (_, i) => ({ 'index.js': `${i}\n` })),
      ]);
      const tool: EphemeralTool = {
        exactPurl: 'pkg:generic/idle@1.0.0',
        digest: `sha256:${'0'.repeat(64)}`,
        storePath: entries[0]!,
        bins: [{ name: 'idle', path: 'bin/idle', interpreter: 'native' }],
        cached: true,
        runtimePaths: entries,
        cacheRoot,
        closure: [],
      };
      const views = async () =>
        (await readdir(store)).filter((name) => name.startsWith('.view-'));
      const { how } = await signalledRun(
        tool,
        work,
        'SIGTERM',
        async () => (await views()).length === 1,
      );
      expect(how).toBe('SIGTERM');
      expect(await views()).toEqual([]);
    },
  );
});

describe.skipIf(canSandbox)('opmx stopped while a tool runs', () => {
  it.skip('needs bwrap (/usr/bin/bwrap); not checked on this host', () => {});
});
