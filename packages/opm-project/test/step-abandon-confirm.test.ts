import { randomUUID } from 'node:crypto';
import { cp, readFile, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { configureDefaultAdapters } from '@openpacker/adapters-default';
import {
  OpmError,
  abandonStep,
  currentOwner,
  describeRecovery,
  projectStep,
  type ProcessOwner,
} from '../src/index.js';
import { snapshotProject } from '../src/project-rollback.js';
import { copyId } from '../src/rollback-recovery.js';
import { lockOwnerOf } from '../src/step-abandon.js';
import {
  copies,
  deadCopy,
  exitedPid,
  foreign,
  leftBy,
  project,
  snapshot,
  stepLocks,
  temporary,
} from './rollback-support.js';

configureDefaultAdapters();

/**
 * `opm recover --abandon-step` takes a step for dead on the operator's word, so
 * it says what that costs and asks for `--force` when opm cannot tell (X5); it
 * lets go of a lock it cannot read, saying so (X2); and a copy made in another
 * project is only removed (X3).
 */

/** What the refusal must say about being wrong, in plain words. */
const COST = [
  /is still running/u,
  /removes its lock/u,
  /puts the project back as it was before that step/u,
  /keeps writing this project with its lock gone and its work undone/u,
  /add --force to the same command/u,
];

const knowsBoot = (await currentOwner()).machineId !== undefined;

describe('a step of another place', () => {
  const places: [string, (here: ProcessOwner) => Partial<ProcessOwner>][] = [
    ['another PID namespace', () => ({ pidNamespace: '4026539999' })],
    ['another host', (here) => ({ host: `${here.host}-elsewhere` })],
    ['another machine', () => ({ machineId: 'd1-' + 'a'.repeat(32) })],
  ];

  it.each(places)(
    'in %s is refused without --force, in plain words, and nothing changes',
    async (_place, change) => {
      const root = await project(['base']);
      const owner = {
        ...(await currentOwner()),
        pid: await exitedPid(),
        ...change(await currentOwner()),
      };
      const { lock } = await leftBy(root, owner);
      const before = await snapshot(root);
      expect(before.manifest).toBe('half-written\n');
      const refusal = abandonStep(root, lock, { waitMs: 0 });
      await expect(refusal).rejects.toMatchObject({ code: 'PROJECT_BUSY' });
      const { message } = await refusal.catch((error: Error) => error);
      for (const sentence of COST) expect(message).toMatch(sentence);
      expect(message).toContain(`process ${owner.pid} on ${owner.host}`);
      expect(message).toContain(`.opm/step-${lock}.lock`);
      expect(message).toMatch(/written (less than a minute|\d+ minutes?) ago/u);
      // The ready-to-paste forced command is never printed.
      expect(message).not.toMatch(/--abandon-step \S+ --force/u);
      expect(await stepLocks(root)).toEqual([`step-${lock}.lock`]);
      expect(await copies(root)).toHaveLength(1);
      expect(await readFile(join(root, 'opm.toml'), 'utf8')).toBe(
        'half-written\n',
      );
      expect(await snapshot(root)).toEqual(before);
    },
  );

  it.each(places)(
    'in %s is let go with --force',
    async (_place, change) => {
      const root = await project(['base']);
      const before = await snapshot(root);
      const owner = {
        ...(await currentOwner()),
        pid: await exitedPid(),
        ...change(await currentOwner()),
      };
      const { lock } = await leftBy(root, owner);
      const result = await abandonStep(root, lock, { force: true });
      expect(result.owner).toEqual(owner);
      expect(result.recovered).toEqual([
        expect.objectContaining({ restored: true }),
      ]);
      expect(await snapshot(root)).toEqual(before);
      expect(await stepLocks(root)).toEqual([]);
    },
    60_000,
  );

  it('whose copy is named is asked about in the same words', async () => {
    const root = await project(['base']);
    const { copy } = await leftBy(root, await foreign());
    await expect(abandonStep(root, copy, { waitMs: 0 })).rejects.toMatchObject({
      code: 'PROJECT_BUSY',
      message: expect.stringMatching(/keeps writing this project/u),
    });
    expect(await copies(root)).toHaveLength(1);
  });
});

describe('a step opm can tell about', () => {
  it('that is running here is refused even with --force', async () => {
    const root = await project(['base']);
    const { lock } = await leftBy(root, await currentOwner());
    await expect(
      abandonStep(root, lock, { waitMs: 0, force: true }),
    ).rejects.toMatchObject({ code: 'STEP_ALIVE' });
    expect(await copies(root)).toHaveLength(1);
  });

  it('whose pid is free here needs no --force', async () => {
    const root = await project(['base']);
    const before = await snapshot(root);
    const { lock } = await leftBy(root, {
      ...(await currentOwner()),
      pid: await exitedPid(),
    });
    expect((await abandonStep(root, lock)).recovered).toHaveLength(1);
    expect(await snapshot(root)).toEqual(before);
  }, 60_000);

  it.runIf(knowsBoot)(
    'of an earlier boot of this machine needs no --force',
    async () => {
      const root = await project(['base']);
      const before = await snapshot(root);
      const { lock } = await leftBy(root, {
        ...(await currentOwner()),
        bootId: 'd1-' + '0'.repeat(32),
      });
      expect((await abandonStep(root, lock)).recovered).toHaveLength(1);
      expect(await snapshot(root)).toEqual(before);
    },
    60_000,
  );
});

describe('a lock opm cannot read', () => {
  const unreadable: [string, string][] = [
    ['empty', ''],
    ['cut short', '{"lockVersion":1,"owner":{"pid":4'],
    [
      'from a newer opm',
      JSON.stringify({
        lockVersion: 2,
        owner: { pid: 4, host: 'vm' },
        more: 1,
      }),
    ],
    ['not a lock', 'hello'],
  ];

  async function aged(root: string, id: string, contents: string) {
    const path = join(root, '.opm', `step-${id}.lock`);
    await writeFile(path, contents);
    const old = new Date(Date.now() - 3_600_000);
    await utimes(path, old, old);
  }

  it.each(unreadable)(
    '%s is not let go of without --force, and the refusal says what --force does',
    async (_what, contents) => {
      const root = await project(['base']);
      const id = randomUUID();
      await aged(root, id, contents);
      const refusal = abandonStep(root, id, { waitMs: 0 });
      await expect(refusal).rejects.toMatchObject({ code: 'PROJECT_BUSY' });
      const { message } = await refusal.catch((error: Error) => error);
      expect(message).toContain(`.opm/step-${id}.lock`);
      expect(message).toMatch(/does not say who holds it/u);
      expect(message).toMatch(/written 1 hours? ago|written 60 minutes ago/u);
      expect(message).toMatch(
        /if that step is running it keeps writing without a lock/u,
      );
      expect(message).toMatch(
        /add --force to remove that lock file; nothing else is changed/u,
      );
      expect(message).not.toMatch(/run this again|--abandon-step \S+ --force/u);
      expect(await stepLocks(root)).toEqual([`step-${id}.lock`]);
    },
  );

  it.each(unreadable)(
    '%s is removed with --force, and only that file',
    async (_what, contents) => {
      const root = await project(['base']);
      const id = randomUUID();
      await aged(root, id, contents);
      const told: string[] = [];
      const result = await abandonStep(root, id, {
        force: true,
        onRecovered: (step) => told.push(step.copy),
      });
      expect(result.owner).toBeUndefined();
      expect(result.removedLocks).toEqual([
        { file: join('.opm', `step-${id}.lock`) },
      ]);
      expect(result.recovered).toEqual([]);
      expect(await stepLocks(root)).toEqual([]);
      expect(await projectStep(root, { waitMs: 0 }, async () => 'x')).toBe('x');
    },
  );

  it("with --force removes that file and changes nothing else, a gone step's copy included", async () => {
    const root = await project(['base']);
    const name = await deadCopy(root);
    await writeFile(join(root, 'opm.toml'), 'edited after the kill\n');
    const before = await snapshot(root);
    const id = randomUUID();
    await aged(root, id, 'hello');
    const result = await abandonStep(root, id, { force: true });
    expect(result.recovered).toEqual([]);
    expect(result.removedLocks).toEqual([
      { file: join('.opm', `step-${id}.lock`) },
    ]);
    // What the refusal promised: nothing else was changed.
    expect(await snapshot(root)).toEqual(before);
    expect(await copies(root)).toEqual([name]);
    expect(await stepLocks(root)).toEqual([]);
  }, 60_000);

  it('is named by the id its file name carries, whatever that is', async () => {
    const root = await project(['base']);
    await writeFile(join(root, '.opm', 'step-my-old-lock.lock'), 'hello');
    await expect(
      projectStep(root, { waitMs: 0 }, async () => 'x'),
    ).rejects.toMatchObject({
      message: expect.stringContaining(
        'opm recover --abandon-step my-old-lock ',
      ),
    });
    await abandonStep(root, 'my-old-lock', { force: true });
    expect(await stepLocks(root)).toEqual([]);
  });

  it('is told apart from an id that names nothing', async () => {
    const root = await project(['base']);
    await expect(abandonStep(root, 'nonsense')).rejects.toMatchObject({
      code: 'INVALID_SPEC',
    });
    await expect(abandonStep(root, '../../etc/passwd')).rejects.toMatchObject({
      code: 'INVALID_SPEC',
    });
    await expect(abandonStep(root, randomUUID())).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('a copy made in another project', () => {
  async function elsewhere() {
    const root = await project(['base']);
    const name = await deadCopy(root);
    await writeFile(join(root, 'opm.toml'), 'half-written\n');
    const other = temporary(`${root}-copy`);
    await cp(root, other, {
      recursive: true,
      verbatimSymlinks: true,
      preserveTimestamps: true,
    });
    await writeFile(join(other, 'opm.toml'), 'the other one\n');
    return { root, other, name };
  }

  it('is removed, and nothing else changed, by abandoning it, without --force', async () => {
    const { other, name } = await elsewhere();
    const result = await abandonStep(other, copyId(name));
    expect(result.recovered).toEqual([
      expect.objectContaining({ restored: false, foreign: expect.any(String) }),
    ]);
    expect(await readFile(join(other, 'opm.toml'), 'utf8')).toBe(
      'the other one\n',
    );
    expect(await copies(other)).toEqual([]);
    expect(describeRecovery(result.recovered[0]!)).toMatch(
      /removed .*which was made for the project at .*; this project was not changed/u,
    );
  }, 60_000);

  it('is removed even while the step that made it still runs here', async () => {
    const root = await project(['base']);
    await snapshotProject(root);
    const [name] = await copies(root);
    const other = temporary(`${root}-copy`);
    await cp(root, other, {
      recursive: true,
      verbatimSymlinks: true,
      preserveTimestamps: true,
    });
    await abandonStep(other, copyId(name!), { force: false });
    expect(await copies(other)).toEqual([]);
    expect(await copies(root)).toEqual([name]);
  }, 60_000);
});

describe('reading a lock to see whose it is (N4)', () => {
  const state = (code: string) => new OpmError(code, `simulated ${code}`);
  const errno = (code: string) =>
    Object.assign(new Error(`simulated ${code}`), { code });
  const reading = (throwing: Error) => async (): Promise<string> => {
    throw throwing;
  };
  const ok = async () =>
    `${JSON.stringify({ lockVersion: 1, owner: { pid: 4, host: 'vm' } })}\n`;

  it('says who holds it when it can', async () => {
    expect(await lockOwnerOf('/x', 'step-a.lock', ok)).toEqual({
      pid: 4,
      host: 'vm',
    });
  });

  it.each([
    ['a lock that is empty', async () => ''],
    ['a lock cut short', async () => '{"lockVersion":1,"owner":{"pid":'],
    ['a lock of a newer version', async () => '{"lockVersion":2}'],
    ['a link', reading(state('UNSAFE_PATH'))],
    [
      'a file that is not a file, or too large',
      reading(state('INVALID_STATE')),
    ],
  ])(
    '%s says nothing, and may be removed with --force',
    async (_what, read) => {
      expect(await lockOwnerOf('/x', 'step-a.lock', read)).toBeUndefined();
    },
  );

  it.each([
    ['too many open files', errno('EMFILE')],
    ['an input/output error', errno('EIO')],
    ['permission denied', errno('EACCES')],
    ['gone while it was read', errno('ENOENT')],
    ['changed while it was read', state('INPUT_CHANGED')],
  ])(
    'a read that failed (%s) is not the lock saying nothing: nothing is taken for unreadable',
    async (_what, failure) => {
      await expect(
        lockOwnerOf('/x', 'step-a.lock', reading(failure)),
      ).rejects.toMatchObject({
        code: 'UNAVAILABLE',
        message: expect.stringMatching(
          /could not read \.opm\/step-a\.lock.*Nothing was changed.*run this again/su,
        ),
      });
    },
  );
});
