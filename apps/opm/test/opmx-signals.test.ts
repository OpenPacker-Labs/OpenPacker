import { randomUUID } from 'node:crypto';
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
import { afterEach, describe, expect, it } from 'vitest';
import { stoppedBySignal, type EphemeralTool } from '@openpacker/opm-project';
import { holdingSignals } from '../src/opmx-signals.js';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  canSandbox,
  PLAIN_NODE,
  signalledScript,
  source,
  startScript,
  until,
} from './signal-fixture.js';

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
  it.each(['SIGINT', 'SIGTERM', 'SIGHUP'] as const)(
    'turns %s into an abort, and raises it again once the run is over',
    async (name) => {
      const before = process.listenerCount(name);
      const raised: string[] = [];
      let aborted = false;
      let reason: unknown;
      const result = await holdingSignals(
        async (signal) => {
          process.emit(name, name);
          aborted = signal.aborted;
          reason = signal.reason;
          // Still held: the run is not over until what it made is removed.
          expect(raised).toEqual([]);
          return 'removed';
        },
        (signal) => raised.push(signal),
      );
      expect([aborted, result, raised]).toEqual([true, 'removed', [name]]);
      // The abort names the signal, so the sandbox can say what ended the run.
      expect(reason).toEqual(stoppedBySignal(name));
      expect(process.listenerCount(name)).toBe(before);
    },
  );

  it('ends at once by a second signal, by its own code, without waiting for the run', async () => {
    const before = process.listenerCount('SIGTERM');
    const raised: string[] = [];
    let finish: () => void = () => undefined;
    const removing = new Promise<void>((resolve) => (finish = resolve));
    const held = holdingSignals(
      async () => {
        await removing;
        return 'removed late';
      },
      (signal) => raised.push(signal),
    );
    process.emit('SIGHUP', 'SIGHUP');
    expect(raised).toEqual([]);
    // The run is still being removed: the second signal does not wait for it.
    process.emit('SIGTERM', 'SIGTERM');
    expect(raised).toEqual(['SIGTERM']);
    expect(process.listenerCount('SIGTERM')).toBe(before);
    finish();
    // Not raised a third time when the run does end.
    expect([await held, raised]).toEqual(['removed late', ['SIGTERM']]);
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
  return await signalledScript({
    work,
    marker,
    signal,
    made,
    script: `import { configureDefaultAdapters } from '@openpacker/adapters-default';
     import { holdingSignals } from ${source('../src/opmx-signals.ts')};
     import { runTool } from ${source('../src/opmx-spawn.ts')};
     configureDefaultAdapters();
     ${PLAIN_NODE}
     const tool = ${JSON.stringify(tool)};
     process.exitCode = await holdingSignals((signal) =>
       runTool(tool, tool.bins[0], [${JSON.stringify(marker)}], process, ${JSON.stringify(work)}, { signal }),
     );
    `,
  });
}

describe('a second signal while a run is being removed', () => {
  it('ends opmx at once, by that signal', { timeout: 60_000 }, async () => {
    const work = await mkdtemp(join(tmpdir(), 'opmx-signals-twice-'));
    temps.push(work);
    const run = await startScript(
      `import { holdingSignals } from ${source('../src/opmx-signals.ts')};
       ${PLAIN_NODE}
       // A run whose removal never ends.
       setInterval(() => {}, 1000);
       const run = holdingSignals(() => new Promise(() => {}));
       // Said once the signals are held: a signal sent on 'held' before they
       // were (this process descheduled between the two) took their default
       // action and ended it at the first.
       console.log('held');
       await run;
      `,
      work,
    );
    try {
      await until(() => run.output().includes('held'), 'the run to be held');
      run.child.kill('SIGINT');
      await sleep(700);
      // The first only asks it to end, and it is still being removed.
      expect([run.child.exitCode, run.child.signalCode]).toEqual([null, null]);
      run.child.kill('SIGINT');
      const how = await Promise.race([
        run.exited,
        sleep(10_000).then(() => 'still running after the second'),
      ]);
      expect(how).toBe('SIGINT');
    } finally {
      run.child.kill('SIGKILL');
    }
  });
});

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
