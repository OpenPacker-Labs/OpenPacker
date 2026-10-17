import { createServer } from 'node:net';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { configureDefaultAdapters } from '@openpacker/adapters-default';
import {
  currentOwner,
  recoverInterruptedSteps,
  syncProject,
} from '../src/index.js';
import { undoStep } from '../src/install-commit.js';
import { snapshotProject } from '../src/project-rollback.js';
import {
  copies,
  editRecord,
  exitedPid,
  killedHalfWay,
  project,
  snapshot,
  transport,
} from './rollback-support.js';

configureDefaultAdapters();

/**
 * A step killed after it kept its copy of the project and before it discarded
 * it leaves the project half way and `.opm/.rollback-…` behind. The next step
 * that changes the project finds a copy whose owner is gone, puts the project
 * back from it and removes it. A copy whose owner may be alive stops the step,
 * untouched.
 */

describe.runIf(process.platform !== 'win32')(
  'a step killed after it kept its copy',
  () => {
    it('is put back byte for byte, and the copy removed', async () => {
      const root = await project();
      const before = await snapshot(root);
      await killedHalfWay(root);
      expect((await snapshot(root)).manifest).toBe('half-written\n');
      expect(await copies(root)).toHaveLength(1);

      const recovered = await recoverInterruptedSteps(root);
      expect(recovered).toEqual([
        expect.objectContaining({ restored: true, owner: expect.any(Object) }),
      ]);
      expect(await snapshot(root)).toEqual(before);
      expect(await copies(root)).toEqual([]);
    }, 60_000);

    it('is put back by the next opm sync, which then runs as usual', async () => {
      const root = await project();
      const before = await snapshot(root);
      await killedHalfWay(root);

      await syncProject({ root, registryOptions: transport() });
      const after = await snapshot(root);
      expect(await copies(root)).toEqual([]);
      for (const key of [
        'manifest',
        'lock',
        'packageJson',
        'native',
        'nodeModules',
        'opmBin',
        'links',
      ] as const)
        expect(after[key], key).toEqual(before[key]);
    }, 60_000);

    it('is put back again after the putting back was itself cut short', async () => {
      const root = await project();
      const before = await snapshot(root);
      await killedHalfWay(root);
      // A recovery killed right after it moved node_modules back: the kept
      // tree is gone from the copy, and the copy is still `ready`.
      const [name] = await copies(root);
      await rm(join(root, 'node_modules'), { recursive: true });
      await rename(
        join(root, '.opm', name!, 'trees', '0'),
        join(root, 'node_modules'),
      );

      expect(await recoverInterruptedSteps(root)).toEqual([
        expect.objectContaining({ restored: true }),
      ]);
      expect(await snapshot(root)).toEqual(before);
      expect(await copies(root)).toEqual([]);
    }, 60_000);
  },
);

describe('a copy whose owner may be alive', () => {
  it('stops the step, untouched', async () => {
    const root = await project();
    // This process's own copy: as far as anything on disk says, its step is
    // still running.
    const kept = await snapshotProject(root);
    await writeFile(join(root, 'opm.toml'), 'half-written\n');
    await expect(recoverInterruptedSteps(root)).rejects.toMatchObject({
      code: 'PROJECT_BUSY',
      message: expect.stringContaining(`process ${process.pid} on`),
    });
    expect(await readFile(join(root, 'opm.toml'), 'utf8')).toBe(
      'half-written\n',
    );
    expect(await copies(root)).toHaveLength(1);
    await kept.restore();
    expect(await copies(root)).toEqual([]);
  });

  it('on another machine stops it too, though its pid is free here', async () => {
    const root = await project();
    const kept = await snapshotProject(root);
    const [name] = await copies(root);
    const pid = await exitedPid();
    // Only the host differs: everything else would let this pid be judged.
    await editRecord(root, name!, (record) => {
      record.owner.pid = pid;
      record.owner.host = `${hostname()}-elsewhere`;
    });
    await expect(recoverInterruptedSteps(root)).rejects.toMatchObject({
      code: 'PROJECT_BUSY',
      message: expect.stringContaining(
        `process ${pid} on ${hostname()}-elsewhere`,
      ),
    });
    expect(await copies(root)).toHaveLength(1);
    await kept.discard();
  });
});

/** Whether this machine says which machine and which boot it is. */
const self = await currentOwner();
const knowsBoot = self.machineId !== undefined && self.bootId !== undefined;

describe('a copy made before this machine last started', () => {
  it.runIf(knowsBoot)('is put back, whatever its pid names now', async () => {
    const root = await project();
    const before = await snapshot(root);
    await snapshotProject(root);
    await writeFile(join(root, 'opm.toml'), 'half-written\n');
    const [name] = await copies(root);
    // This process's pid and start time, on an earlier boot.
    await editRecord(root, name!, (record) => {
      record.owner.bootId = '00000000-0000-4000-8000-000000000000';
    });
    expect(await recoverInterruptedSteps(root)).toEqual([
      expect.objectContaining({ restored: true }),
    ]);
    expect(await snapshot(root)).toEqual(before);
  });
});

describe('a copy whose owner is gone before it was complete', () => {
  it('is removed without restoring anything', async () => {
    const root = await project();
    const before = await snapshot(root);
    const kept = await snapshotProject(root);
    const [name] = await copies(root);
    const pid = await exitedPid();
    // Killed while it was still copying: the project was not touched yet.
    await editRecord(root, name!, (record) => {
      record.state = 'copying';
      record.owner.pid = pid;
    });
    expect(await recoverInterruptedSteps(root)).toEqual([
      expect.objectContaining({ restored: false }),
    ]);
    expect(await snapshot(root)).toEqual(before);
    expect(await copies(root)).toEqual([]);
    await kept.discard();
  });
});

describe.runIf(process.platform === 'linux')('a reused process id', () => {
  it('does not keep a copy alive: the start time is compared too', async () => {
    const root = await project();
    const before = await snapshot(root);
    await snapshotProject(root);
    await writeFile(join(root, 'opm.toml'), 'half-written\n');
    const [name] = await copies(root);
    // This pid, but a process that started at another time.
    await editRecord(root, name!, (record) => {
      record.owner.startTime = '1';
    });
    expect(await recoverInterruptedSteps(root)).toEqual([
      expect.objectContaining({ restored: true }),
    ]);
    expect(await snapshot(root)).toEqual(before);
  });
});

describe('a copy that cannot be finished', () => {
  it.runIf(process.platform !== 'win32')(
    'is removed at once, not left for the next step',
    async () => {
      const root = await project();
      // A socket in .opm/bin: copying it fails part way through the copy.
      await mkdir(join(root, '.opm', 'bin'), { recursive: true });
      const server = createServer();
      await new Promise<void>((resolve) =>
        server.listen(join(root, '.opm', 'bin', 'socket'), resolve),
      );
      try {
        await expect(snapshotProject(root)).rejects.toThrow();
        expect(await copies(root)).toEqual([]);
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    },
  );
});

describe('a step that fails and cannot be put back', () => {
  it('reports both failures', async () => {
    const step = new Error('ENOTDIR: node_modules/.bin is a file');
    const failed = new Error('EIO: i/o error, rename');
    const undone = undoStep(step, {
      restore: () => Promise.reject(failed),
      discard: () => Promise.resolve(),
    });
    await expect(undone).rejects.toBeInstanceOf(AggregateError);
    await expect(undone).rejects.toMatchObject({
      errors: [step, failed],
      message: expect.stringMatching(
        /^ENOTDIR: node_modules\/\.bin is a file; putting the project back failed too \(EIO: i\/o error, rename\)/u,
      ),
    });
  });
});
