import { randomUUID } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { configureDefaultAdapters } from '@openpacker/adapters-default';
import {
  abandonStep,
  currentOwner,
  MAX_STEP_WAIT_MS,
  parseStepWait,
  projectStep,
  recoverInterruptedSteps,
} from '../src/index.js';
import {
  child,
  copies,
  exitedPid,
  foreign,
  kill,
  leftBy,
  project,
  snapshot,
  sources,
  stepLocks,
  temporary,
  until,
} from './rollback-support.js';

configureDefaultAdapters();

/**
 * A step whose owner this machine cannot judge (a container restarted over the
 * project, another host) holds the project for ever, and the operator says it
 * is dead: `abandonStep` removes its lock and puts its copy back, and refuses
 * a step that is running here.
 */

const ABANDON = (id: string) => `opm recover --abandon-step ${id}`;

describe('a step this machine cannot judge', () => {
  it('holds the project, and the refusal says how to let it go', async () => {
    const root = await project(['base']);
    const { lock } = await leftBy(root, await foreign());
    await expect(
      projectStep(root, { waitMs: 0 }, async () => 'x'),
    ).rejects.toMatchObject({
      code: 'PROJECT_BUSY',
      message: expect.stringContaining(ABANDON(lock)),
    });
  });

  it('is let go by its lock id: the lock is removed and the copy put back', async () => {
    const root = await project(['base']);
    const before = await snapshot(root);
    const { lock } = await leftBy(root, await foreign());
    const told: string[] = [];
    const result = await abandonStep(root, lock, {
      onRecovered: (step) => told.push(step.copy),
      force: true,
    });
    expect(result.removedLocks).toEqual([
      expect.objectContaining({ file: join('.opm', `step-${lock}.lock`) }),
    ]);
    expect(result.recovered).toEqual([
      expect.objectContaining({ restored: true }),
    ]);
    expect(told).toHaveLength(1);
    expect(await snapshot(root)).toEqual(before);
    expect(await stepLocks(root)).toEqual([]);
    expect(await projectStep(root, { waitMs: 0 }, async () => 'x')).toBe('x');
  }, 60_000);

  it('is let go by its copy id as well, when the lock was removed by hand', async () => {
    const root = await project(['base']);
    const before = await snapshot(root);
    const { lock, copy } = await leftBy(root, await foreign());
    await rm(join(root, '.opm', `step-${lock}.lock`));
    // Without the lock, the copy still holds the project.
    await expect(
      projectStep(root, { waitMs: 0 }, async () => 'x'),
    ).rejects.toMatchObject({
      message: expect.stringContaining(ABANDON(copy)),
    });
    await abandonStep(root, `.rollback-4242-${copy}`, { force: true });
    expect(await snapshot(root)).toEqual(before);
    expect(await copies(root)).toEqual([]);
  }, 60_000);

  it('does not let go of a step of another owner', async () => {
    const root = await project(['base']);
    const other = { ...(await foreign()), pidNamespace: '4026538888' };
    const mine = await leftBy(root, await foreign());
    const theirLock = randomUUID();
    await writeFile(
      join(root, '.opm', `step-${theirLock}.lock`),
      `${JSON.stringify({ lockVersion: 1, owner: other })}\n`,
    );
    await expect(
      abandonStep(root, mine.lock, { waitMs: 0, force: true }),
    ).rejects.toMatchObject({
      code: 'PROJECT_BUSY',
      message: expect.stringContaining(ABANDON(theirLock)),
    });
    // Their lock is untouched, and so is the project.
    expect(await stepLocks(root)).toContain(`step-${theirLock}.lock`);
    expect(await readFile(join(root, 'opm.toml'), 'utf8')).toBe(
      'half-written\n',
    );
  });
});

describe('a step that is running here', () => {
  it('is not called dead: its pid answers in this PID namespace', async () => {
    const root = await project(['base']);
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
      const [file] = await stepLocks(root);
      const id = file!.slice('step-'.length, -'.lock'.length);
      await expect(abandonStep(root, id, { waitMs: 0 })).rejects.toMatchObject({
        code: 'STEP_ALIVE',
        message: expect.stringContaining(`process ${holder.pid} on`),
      });
      expect(await stepLocks(root)).toEqual([file]);
    } finally {
      await kill(holder);
    }
  }, 60_000);

  it('is not called dead when it is this process', async () => {
    const root = await project(['base']);
    const { lock } = await leftBy(root, await currentOwner());
    await expect(abandonStep(root, lock, { waitMs: 0 })).rejects.toMatchObject({
      code: 'STEP_ALIVE',
    });
    expect(await copies(root)).toHaveLength(1);
    expect(await stepLocks(root)).toHaveLength(1);
  });

  it('is let go once it is gone: that is ordinary recovery', async () => {
    const root = await project(['base']);
    const before = await snapshot(root);
    const { lock } = await leftBy(root, {
      ...(await currentOwner()),
      pid: await exitedPid(),
    });
    expect((await abandonStep(root, lock)).recovered).toHaveLength(1);
    expect(await snapshot(root)).toEqual(before);
  }, 60_000);
});

describe('an id that names nothing', () => {
  it('is not an id', async () => {
    const root = await project(['base']);
    await expect(abandonStep(root, 'step-1.lock')).rejects.toMatchObject({
      code: 'INVALID_SPEC',
    });
  });

  it('is not found, and the refusal lists what is there', async () => {
    const root = await project(['base']);
    const { lock } = await leftBy(root, await foreign());
    await expect(abandonStep(root, randomUUID())).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: expect.stringContaining(`step-${lock}.lock`),
    });
  });

  it('is a lock that says nothing about who holds it: not let go of without --force', async () => {
    const root = await project(['base']);
    const lock = randomUUID();
    await writeFile(join(root, '.opm', `step-${lock}.lock`), '');
    await expect(abandonStep(root, lock)).rejects.toMatchObject({
      code: 'PROJECT_BUSY',
      message: expect.stringContaining('does not say who holds it'),
    });
    expect(await stepLocks(root)).toEqual([`step-${lock}.lock`]);
  });
});

describe('how long a step waits', () => {
  it.each([
    ['0', 0],
    ['250', 250],
    [String(MAX_STEP_WAIT_MS), MAX_STEP_WAIT_MS],
  ])('takes %s milliseconds', (text, wait) => {
    expect(parseStepWait(text, '--wait')).toBe(wait);
  });

  it.each([
    '-1',
    '1.5',
    '1e3',
    '',
    'soon',
    String(MAX_STEP_WAIT_MS + 1),
    '9999999999',
  ])('refuses %j', (text) => {
    expect(() => parseStepWait(text, '--wait')).toThrow(
      /--wait takes whole milliseconds/u,
    );
  });

  it.each([-1, 1.5, Number.NaN, MAX_STEP_WAIT_MS + 1])(
    'a library step refuses %s',
    async (waitMs) => {
      const root = await project([]);
      await expect(
        projectStep(root, { waitMs }, async () => 'x'),
      ).rejects.toMatchObject({ code: 'INVALID_SPEC' });
    },
  );

  it('is as long as asked: none at all gives up at once', async () => {
    const root = await project([]);
    await leftBy(root, await foreign());
    // A step is told when it starts to wait (`onWait`), and waitMs 0 never
    // starts. One that did not take it would wait the 10 s default: it is
    // stopped there, with an error that is not PROJECT_BUSY. No clock is read.
    const waited = new Error('the step waited for the step that holds it');
    await expect(
      recoverInterruptedSteps(root, {
        waitMs: 0,
        onWait: () => {
          throw waited;
        },
      }),
    ).rejects.toMatchObject({
      code: 'PROJECT_BUSY',
    });
  });
});
