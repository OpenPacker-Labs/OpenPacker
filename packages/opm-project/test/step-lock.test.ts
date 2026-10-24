import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { configureDefaultAdapters } from '@openpacker/adapters-default';
import {
  addPackage,
  currentOwner,
  projectStep,
  recoverInterruptedSteps,
  syncProject,
  type ProcessOwner,
  type RecoveredStep,
} from '../src/index.js';
import { snapshotProject } from '../src/project-rollback.js';
import {
  child,
  copies,
  editRecord,
  exitedPid,
  kill,
  killedHalfWay,
  project,
  snapshot,
  sources,
  stepLocks,
  temporary,
  transport,
  until,
} from './rollback-support.js';

configureDefaultAdapters();

/**
 * One step at a time changes a project: a step holds `.opm/step-<uuid>.lock`
 * from its recovery to its end, and a second waits a bounded time, then
 * refuses with PROJECT_BUSY naming the holder. A copy is put back only over
 * the state it was taken from or the one its step was about to write.
 */

/** This process, where it can say which machine and boot it runs on. */
const self = await currentOwner();
const knowsBoot = self.machineId !== undefined && self.bootId !== undefined;

const hook = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures/stop-at-rm.mjs',
);

/** A step on `root` in this process that runs until `finish` is called. */
function heldStep(root: string) {
  let finish!: () => void;
  let entered!: () => void;
  const inside = new Promise<void>((resolve) => (entered = resolve));
  const done = projectStep(root, {}, async () => {
    entered();
    await new Promise<void>((resolve) => (finish = resolve));
  });
  return { inside, done, finish: () => finish() };
}

describe('two steps on one project', () => {
  it('never overlap: the second refuses, naming the holder, once it has waited', async () => {
    const root = await project([]);
    const first = heldStep(root);
    await first.inside;
    expect(await stepLocks(root)).toHaveLength(1);
    const waited: string[] = [];
    await expect(
      projectStep(
        root,
        { waitMs: 1_500, onWait: (holder) => waited.push(holder.file) },
        async () => 'second',
      ),
    ).rejects.toMatchObject({
      code: 'PROJECT_BUSY',
      message: expect.stringContaining(`process ${process.pid} on`),
    });
    expect(waited).toEqual([expect.stringMatching(/^\.opm\/step-.+\.lock$/u)]);
    first.finish();
    await first.done;
    expect(await projectStep(root, { waitMs: 300 }, async () => 'second')).toBe(
      'second',
    );
    expect(await stepLocks(root)).toEqual([]);
  });

  it('run one after the other when the first finishes in time', async () => {
    const root = await project([]);
    const first = heldStep(root);
    await first.inside;
    const order: string[] = [];
    const second = projectStep(root, { waitMs: 5_000 }, async () => {
      order.push('second');
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    order.push('first done');
    first.finish();
    await first.done;
    await second;
    expect(order).toEqual(['first done', 'second']);
  });

  it('in another process: refused while it runs, taken over once it is killed', async () => {
    const root = await project([]);
    const ready = temporary(`${root}.ready`);
    const holder = await child(
      root,
      `const { projectStep } = await import(${JSON.stringify(sources.index)});
       await projectStep(root, {}, async () => {
         await writeFile(${JSON.stringify(ready)}, '');
         setInterval(() => {}, 1000);
         await new Promise(() => {});
       });`,
    );
    try {
      await until(ready);
      await expect(
        syncProject({
          root,
          registryOptions: transport(),
          step: { waitMs: 300 },
        }),
      ).rejects.toMatchObject({
        code: 'PROJECT_BUSY',
        message: expect.stringContaining(`process ${holder.pid} on`),
      });
    } finally {
      await kill(holder);
    }
    // Its lock is left behind, and names a process that is gone.
    expect(await stepLocks(root)).toHaveLength(1);
    await syncProject({
      root,
      registryOptions: transport(),
      step: { waitMs: 300 },
    });
    expect(await stepLocks(root)).toEqual([]);
  }, 60_000);

  it('take over a lock left empty by a writer killed before it wrote', async () => {
    const root = await project([]);
    const left = join(
      root,
      '.opm',
      'step-00000000-0000-4000-8000-000000000000.lock',
    );
    await writeFile(left, '');
    await expect(
      projectStep(root, { waitMs: 300 }, async () => 'x'),
    ).rejects.toMatchObject({
      code: 'PROJECT_BUSY',
      message: expect.stringContaining('a lock opm cannot read'),
    });
    const old = new Date(Date.now() - 60_000);
    await utimes(left, old, old);
    expect(await projectStep(root, { waitMs: 300 }, async () => 'x')).toBe('x');
    expect(existsSync(left)).toBe(false);
  });

  it.runIf(knowsBoot)(
    'take over a lock left before this machine last started',
    async () => {
      const root = await project([]);
      const left = join(
        root,
        '.opm',
        'step-11111111-1111-4111-8111-111111111111.lock',
      );
      const writeLock = (owner: ProcessOwner) =>
        writeFile(left, `${JSON.stringify({ lockVersion: 1, owner })}\n`);
      // This process's pid and place, on an earlier boot: nothing of that
      // boot is running.
      await writeLock({
        ...self,
        bootId: '00000000-0000-4000-8000-000000000000',
      });
      expect(await projectStep(root, { waitMs: 300 }, async () => 'x')).toBe(
        'x',
      );
      expect(existsSync(left)).toBe(false);
      // The same on another machine cannot be judged, and holds the project.
      await writeLock({
        ...self,
        machineId: 'f'.repeat(32),
        bootId: '00000000-0000-4000-8000-000000000000',
      });
      await expect(
        projectStep(root, { waitMs: 300 }, async () => 'x'),
      ).rejects.toMatchObject({ code: 'PROJECT_BUSY' });
      expect(existsSync(left)).toBe(true);
    },
    60_000,
  );

  it('leave no .opm behind in a directory that had none', async () => {
    const dir = temporary(await mkdtemp(join(tmpdir(), 'opm-step-')));
    expect(
      await projectStep(dir, {}, async () => existsSync(join(dir, '.opm'))),
    ).toBe(true);
    expect(existsSync(join(dir, '.opm'))).toBe(false);
  });
});

describe('a step another step left a copy behind', () => {
  it('cannot finish under a live copy, so the copy never undoes it later', async () => {
    const root = await project(['base']);
    const ready = temporary(`${root}.ready`);
    // A: an opm whose step has kept its copy and is still linking.
    const a = await child(
      root,
      `const { projectStep } = await import(${JSON.stringify(sources.index)});
       const { snapshotProject } = await import(${JSON.stringify(sources.rollback)});
       await projectStep(root, {}, async () => {
         await snapshotProject(root);
         await writeFile(${JSON.stringify(ready)}, '');
         setInterval(() => {}, 1000);
         await new Promise(() => {});
       });`,
    );
    await until(ready);
    // B: a second opm in another terminal adds a package. It does not run
    // beside A's step, so nothing it does can be undone by A's copy.
    await expect(
      addPackage({
        root,
        spec: 'pkg:npm/third@1.0.0',
        registryOptions: transport(),
        step: { waitMs: 300 },
      }),
    ).rejects.toMatchObject({ code: 'PROJECT_BUSY' });
    expect(await readFile(join(root, 'opm.toml'), 'utf8')).not.toContain(
      'third',
    );
    // A is killed (Ctrl-C, a closed terminal, the OOM killer).
    await kill(a);
    // C: the next step puts A's copy back, and B, run again, stays.
    const told: RecoveredStep[] = [];
    await syncProject({
      root,
      registryOptions: transport(),
      step: { onRecovered: (step) => told.push(step) },
    });
    expect(told).toEqual([expect.objectContaining({ restored: true })]);
    await addPackage({
      root,
      spec: 'pkg:npm/third@1.0.0',
      registryOptions: transport(),
    });
    await syncProject({ root, registryOptions: transport() });
    expect(await readFile(join(root, 'opm.toml'), 'utf8')).toContain('third');
    expect(existsSync(join(root, 'node_modules', 'third'))).toBe(true);
    expect(await copies(root)).toEqual([]);
  }, 60_000);

  it('refuses beside a live copy made without the lock', async () => {
    // Review 182 r2's order: A keeps its copy outside any lock and lives.
    const root = await project(['base']);
    const ready = temporary(`${root}.ready`);
    const a = await child(
      root,
      `const { snapshotProject } = await import(${JSON.stringify(sources.rollback)});
       await snapshotProject(root);
       await writeFile(${JSON.stringify(ready)}, '');
       setInterval(() => {}, 1000);`,
    );
    try {
      await until(ready);
      await expect(
        addPackage({
          root,
          spec: 'pkg:npm/third@1.0.0',
          registryOptions: transport(),
        }),
      ).rejects.toMatchObject({ code: 'PROJECT_BUSY' });
      expect(await readFile(join(root, 'opm.toml'), 'utf8')).not.toContain(
        'third',
      );
    } finally {
      await kill(a);
    }
  }, 60_000);
});

describe.runIf(process.platform === 'linux')('two recoveries at once', () => {
  it('cannot both put the project back: the second waits for the first', async () => {
    const root = await project();
    const before = await snapshot(root);
    await killedHalfWay(root);
    // B is held just before it removes the live node_modules, after it has
    // seen the kept one: an interleaving the scheduler can produce itself.
    const b = await child(
      root,
      `const { recoverInterruptedSteps } = await import(${JSON.stringify(sources.index)});
       await recoverInterruptedSteps(root);`,
      [],
      {
        ...process.env,
        NODE_OPTIONS: `--import=${hook}`,
        STOP_AT_RM: '/node_modules',
      },
    );
    const exited = new Promise<number | null>((resolve) =>
      b.on('exit', resolve),
    );
    while (
      readFileSync(`/proc/${b.pid}/stat`, 'utf8').split(') ')[1]?.[0] !== 'T'
    )
      await new Promise((resolve) => setTimeout(resolve, 20));
    // A, meanwhile: B holds the step lock, so A does not start.
    await expect(
      recoverInterruptedSteps(root, { waitMs: 300 }),
    ).rejects.toMatchObject({
      code: 'PROJECT_BUSY',
      message: expect.stringContaining(`process ${b.pid} on`),
    });
    process.kill(b.pid!, 'SIGCONT');
    expect(await exited).toBe(0);
    expect(await snapshot(root)).toEqual(before);
    expect(await recoverInterruptedSteps(root)).toEqual([]);
    expect(await copies(root)).toEqual([]);
  }, 60_000);
});

describe('a copy put back', () => {
  /** A dead `ready` copy whose step said it would write `manifest`. */
  async function intending(root: string, manifest: string): Promise<string> {
    await snapshotProject(root, { manifest });
    const [name] = await copies(root);
    const pid = await exitedPid();
    await editRecord(root, name!, (record) => {
      record.owner.pid = pid;
    });
    return name!;
  }

  it('goes back over what its step wrote', async () => {
    const root = await project(['base']);
    const before = await snapshot(root);
    await intending(root, 'what the step wrote\n');
    await writeFile(join(root, 'opm.toml'), 'what the step wrote\n');
    expect(await recoverInterruptedSteps(root)).toEqual([
      expect.objectContaining({ restored: true }),
    ]);
    expect(await snapshot(root)).toEqual(before);
  });

  it('does not go back over what someone wrote after the step', async () => {
    const root = await project(['base']);
    const name = await intending(root, 'what the step wrote\n');
    await writeFile(join(root, 'opm.toml'), 'edited by hand since\n');
    await expect(recoverInterruptedSteps(root)).rejects.toMatchObject({
      code: 'ROLLBACK_CONFLICT',
      message: expect.stringContaining(`Remove .opm/${name}`),
    });
    expect(await readFile(join(root, 'opm.toml'), 'utf8')).toBe(
      'edited by hand since\n',
    );
    expect(await copies(root)).toEqual([name]);
  });
});
