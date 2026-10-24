import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { OWNER_FILE } from '../src/owner-file.js';
import {
  currentOwner,
  makeCurrentOwner,
  placeDigest,
  systemProbe,
  type OwnerProbe,
  type OwnerReads,
  type ProcessOwner,
} from '../src/process-owner.js';
import {
  makeScratch,
  sweepAbandoned,
  UNOWNED_AFTER_MS,
  type Judge,
} from '../src/run-scratch.js';

/**
 * A run keeps who made what it makes for itself in `.owner`, and a later run
 * removes only what an owner that has ended left, by the rule every holder opm
 * records is judged by (`process-owner.ts`). A pid alone does not say that: in
 * another PID namespace, on another boot or another machine the same number is
 * another process or none, and a reused pid is another process.
 */

const PREFIX = '.view-';
const temps: string[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function scratchDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'opm-run-scratch-'));
  temps.push(dir);
  return dir;
}

/** A process that runs until it is killed. */
async function running(): Promise<ChildProcess & { pid: number }> {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e3)'], {
    stdio: 'ignore',
  });
  children.push(child);
  await new Promise((resolve) => child.once('spawn', resolve));
  // SAFETY: a spawned child has a pid.
  return child as ChildProcess & { pid: number };
}

/** The pid of a process that has ended. */
async function ended(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise((resolve) => child.once('exit', resolve));
  return child.pid!;
}

const exit = (child: ChildProcess) =>
  new Promise((resolve) => child.once('exit', resolve));

/** `owner` as a process that could not read its machine id names itself. */
function withoutMachine(owner: ProcessOwner): ProcessOwner {
  const { machineId: _machineId, ...rest } = owner;
  return rest;
}

/** Which of `paths` are still there. */
const left = (paths: readonly string[]) =>
  paths.map((path) => existsSync(path));

/**
 * A process on a machine, boot and PID namespace named here, so that the rule
 * is the same on every host the suite runs on, with or without a machine id.
 */
const reader: ProcessOwner = {
  pid: process.pid,
  host: 'here',
  startTime: '1000',
  pidNamespace: '4026531836',
  bootId: placeDigest('boot', 'this boot'),
  machineId: placeDigest('machine', 'this machine'),
};

describe('what a run made', () => {
  it('holds who made it beside the tree it uses, which is empty', async () => {
    const dir = await scratchDir();
    const { path, tree } = await makeScratch(dir, PREFIX);
    expect(dirname(tree)).toBe(path);
    expect((await readdir(path)).sort()).toEqual([OWNER_FILE, 'tree']);
    expect(await readdir(tree)).toEqual([]);
  });
});

describe('what a run left', () => {
  it('is kept while the other process that made it runs, and removed once it ends', async () => {
    const dir = await scratchDir();
    const child = await running();
    const stat = await systemProbe.stat(child.pid);
    const { path } = await makeScratch(dir, PREFIX, {
      ...(await currentOwner()),
      pid: child.pid,
      ...(!(stat === undefined) && { startTime: stat.startTime }),
    });
    await sweepAbandoned(dir, PREFIX);
    expect(existsSync(path)).toBe(true);

    const gone = exit(child);
    child.kill('SIGKILL');
    await gone;
    await sweepAbandoned(dir, PREFIX);
    expect(existsSync(path)).toBe(false);
  });

  it('is kept when another machine id, host name or PID namespace made it, in this boot or another, though the pid is unused here', async () => {
    const dir = await scratchDir();
    const owner = { ...reader, pid: await ended() };
    const otherBoot = placeDigest('boot', 'another boot');
    const otherMachine = placeDigest('machine', 'another machine');
    const foreign = await Promise.all(
      [
        { ...owner, machineId: otherMachine },
        { ...owner, machineId: otherMachine, bootId: otherBoot },
        { ...owner, host: 'there' },
        { ...owner, host: 'there', bootId: otherBoot },
        { ...owner, pidNamespace: '4026531999' },
        // A machine whose id the owner could not read is not known to be this one.
        { ...withoutMachine(owner), bootId: otherBoot },
      ].map(async (item) => (await makeScratch(dir, PREFIX, item)).path),
    );
    const mine = (await makeScratch(dir, PREFIX, owner)).path;
    await sweepAbandoned(dir, PREFIX, { reader });
    expect(left(foreign)).toEqual(foreign.map(() => true));
    expect(existsSync(mine)).toBe(false);
  });

  // After a reboot nothing of the earlier boot runs, whatever its pids are now.
  it('is removed when this machine made it in an earlier boot, though its pid is in use', async () => {
    const dir = await scratchDir();
    const { path } = await makeScratch(dir, PREFIX, {
      ...reader,
      bootId: placeDigest('boot', 'an earlier boot'),
    });
    await sweepAbandoned(dir, PREFIX, { reader });
    expect(existsSync(path)).toBe(false);
  });

  it.runIf(process.platform === 'linux')(
    'is removed when its pid now belongs to a process that started at another time',
    async () => {
      const dir = await scratchDir();
      const child = await running();
      const start = (await systemProbe.stat(child.pid))?.startTime;
      expect(start).toMatch(/^\d+$/u);
      const { path } = await makeScratch(dir, PREFIX, {
        ...(await currentOwner()),
        pid: child.pid,
        startTime: String(Number(start) - 1),
      });
      await sweepAbandoned(dir, PREFIX);
      expect(existsSync(path)).toBe(false);
    },
  );

  it('leaves alone what is not a run scratch of its kind', async () => {
    const dir = await scratchDir();
    const other = join(dir, 'sha256-0');
    await mkdir(other);
    await makeScratch(dir, '.other-', { ...reader, pid: await ended() });
    await sweepAbandoned(dir, PREFIX, { reader });
    expect((await readdir(dir)).length).toBe(2);
  });
});

/**
 * The branches of the owner rule a run's scratch could not reach before it was
 * judged by `process-owner.ts`, driven through its seams: the reader, the
 * system it asks about a pid, and the reads a reader is made from.
 */
describe('the owner rule, as the sweep applies it', () => {
  it('keeps what an owner left whose boot id one side cannot read, though the pid is unused', async () => {
    const pid = await ended();
    const { bootId: _bootId, ...noBoot } = reader;
    // The owner could not read its boot id; then the reader could not.
    const ownerSide = await scratchDir();
    const ownerUnread = (
      await makeScratch(ownerSide, PREFIX, { ...noBoot, pid })
    ).path;
    await sweepAbandoned(ownerSide, PREFIX, { reader });
    const readerSide = await scratchDir();
    const readerUnread = (
      await makeScratch(readerSide, PREFIX, { ...reader, pid })
    ).path;
    await sweepAbandoned(readerSide, PREFIX, { reader: noBoot });
    expect(left([ownerUnread, readerUnread])).toEqual([true, true]);
    // Both unreadable is the same place, and the pid decides.
    await sweepAbandoned(ownerSide, PREFIX, { reader: noBoot });
    expect(existsSync(ownerUnread)).toBe(false);
  });

  describe('on a host where neither side can read a machine id', () => {
    /** This process, as a host with no machine id file names it. */
    const reads: OwnerReads = {
      pid: process.pid,
      hostname: () => 'here',
      stat: async () =>
        `${process.pid} (node) S ${Array.from({ length: 18 }, () => '0').join(' ')} 1000`,
      pidNamespace: async () => '4026531836',
      bootId: async () => 'f0a1b2c3-0000-4000-8000-000000000001',
      machineId: async () => {
        throw Object.assign(new Error('no machine id'), { code: 'ENOENT' });
      },
    };

    it('judges a gone pid gone, and a running one alive', async () => {
      const host = await makeCurrentOwner(reads)();
      expect(host.machineId).toBeUndefined();
      expect(host.startTime).toBe('1000');
      const dir = await scratchDir();
      const gone = (
        await makeScratch(dir, PREFIX, { ...host, pid: await ended() })
      ).path;
      const child = await running();
      const live = (
        await makeScratch(dir, PREFIX, {
          ...host,
          pid: child.pid,
          startTime: (await systemProbe.stat(child.pid))!.startTime,
        })
      ).path;
      await sweepAbandoned(dir, PREFIX, { reader: host });
      expect(left([gone, live])).toEqual([false, true]);
    });
  });

  describe('a pid another user’s process holds (EPERM)', () => {
    /** The system as it answers for a pid this process may not signal. */
    const otherUser = (startTime: string): OwnerProbe => ({
      signal: () => {
        throw Object.assign(new Error('not permitted'), { code: 'EPERM' });
      },
      stat: async () => ({ state: 'S', startTime }),
    });

    it('is the owner when it started when the owner did, and kept', async () => {
      const dir = await scratchDir();
      const { path } = await makeScratch(dir, PREFIX, { ...reader, pid: 7 });
      await sweepAbandoned(dir, PREFIX, {
        reader,
        probe: otherUser(reader.startTime!),
      });
      expect(existsSync(path)).toBe(true);
    });

    it('is another process when it started at another time: the owner has ended', async () => {
      const dir = await scratchDir();
      const { path } = await makeScratch(dir, PREFIX, { ...reader, pid: 7 });
      await sweepAbandoned(dir, PREFIX, { reader, probe: otherUser('2000') });
      expect(existsSync(path)).toBe(false);
    });
  });

  describe('a directory with no owner to read', () => {
    const later: Judge['now'] = () => Date.now() + UNOWNED_AFTER_MS + 60_000;

    it('is kept while it is young, and removed once it is old: its maker was cut short', async () => {
      const dir = await scratchDir();
      const path = join(dir, `${PREFIX}cut-short`);
      await mkdir(join(path, 'tree'), { recursive: true });
      await sweepAbandoned(dir, PREFIX, { reader });
      expect(existsSync(path)).toBe(true);
      await sweepAbandoned(dir, PREFIX, { reader, now: later });
      expect(existsSync(path)).toBe(false);
    });

    it('is kept however old it is when its owner file says nothing opm reads', async () => {
      const dir = await scratchDir();
      const garbled = join(dir, `${PREFIX}garbled`);
      await mkdir(garbled);
      await writeFile(join(garbled, OWNER_FILE), '{"ownerVersion": 9}\n');
      await sweepAbandoned(dir, PREFIX, { reader, now: later });
      expect(existsSync(garbled)).toBe(true);
    });
  });
});

const here = dirname(fileURLToPath(import.meta.url));
const viteNode = join(here, '../../../node_modules/.bin/vite-node');
const canUnshare =
  process.platform === 'linux' &&
  process.getuid?.() === 0 &&
  existsSync('/usr/bin/unshare');

describe('a run in another PID namespace', () => {
  // A container that shares the cache and the host's name: the owner's pid is
  // not visible there, so a pid check alone took the owner for ended.
  it.runIf(canUnshare)(
    'leaves what a run still going in this one made',
    { timeout: 60_000 },
    async () => {
      const dir = await scratchDir();
      const { path } = await makeScratch(dir, PREFIX);
      const sweeper = join(dir, '..', `${dir.split('/').pop()}-sweep.ts`);
      temps.push(sweeper);
      await writeFile(
        sweeper,
        `import { sweepAbandoned } from ${JSON.stringify(join(here, '../src/run-scratch.ts'))};
         await sweepAbandoned(${JSON.stringify(dir)}, ${JSON.stringify(PREFIX)});
        `,
      );
      execFileSync(
        'unshare',
        ['--pid', '--fork', '--mount-proc', viteNode, sweeper],
        { stdio: 'ignore' },
      );
      expect(existsSync(path)).toBe(true);
    },
  );

  it.skipIf(canUnshare)(
    'leaves what a run still going in this one made (needs root and unshare; not checked on this host)',
    () => {},
  );
});
