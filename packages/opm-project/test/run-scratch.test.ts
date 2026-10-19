import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { currentOwner, startOf } from '../src/run-owner.js';
import {
  scratchName,
  scratchNameFor,
  sweepAbandoned,
} from '../src/run-scratch.js';

/**
 * A run names what it makes for itself after its owner, and a later run removes
 * only what an owner that has ended left. A pid alone does not say that: in
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

/** This host has a machine id and a boot id to tell an earlier boot by. */
const knowsItsBoot =
  existsSync('/etc/machine-id') &&
  existsSync('/proc/sys/kernel/random/boot_id');

const exit = (child: ChildProcess) =>
  new Promise((resolve) => child.once('exit', resolve));

describe('what a run left', () => {
  it('is kept while the other process that made it runs, and removed once it ends', async () => {
    const dir = await scratchDir();
    const child = await running();
    const name = scratchNameFor(PREFIX, {
      ...currentOwner(),
      pid: child.pid,
      start: startOf(child.pid) ?? '',
    });
    await mkdir(join(dir, name));
    await sweepAbandoned(dir, PREFIX);
    expect(existsSync(join(dir, name))).toBe(true);

    const gone = exit(child);
    child.kill('SIGKILL');
    await gone;
    await sweepAbandoned(dir, PREFIX);
    expect(existsSync(join(dir, name))).toBe(false);
  });

  it('is kept when another machine id, host name or PID namespace made it, in this boot or another, though the pid is unused here', async () => {
    const dir = await scratchDir();
    const pid = await ended();
    const owner = { ...currentOwner(), pid, start: '' };
    const foreign = [
      { ...owner, machine: 'zzzzzzzz' },
      { ...owner, machine: 'zzzzzzzz', boot: 'zzzzzzzz' },
      { ...owner, host: 'zzzzzzzz' },
      { ...owner, host: 'zzzzzzzz', boot: 'zzzzzzzz' },
      // A machine whose id could not be read is not known to be this one.
      { ...owner, machine: '', boot: 'zzzzzzzz' },
      { ...owner, pidNamespace: 'zzzzzzzz' },
    ].map((item) => scratchNameFor(PREFIX, item));
    const mine = scratchNameFor(PREFIX, owner);
    for (const name of [...foreign, mine]) await mkdir(join(dir, name));
    await sweepAbandoned(dir, PREFIX);
    expect(foreign.map((name) => existsSync(join(dir, name)))).toEqual(
      foreign.map(() => true),
    );
    expect(existsSync(join(dir, mine))).toBe(false);
  });

  // After a reboot nothing of the earlier boot runs, whatever its pids are now.
  it.runIf(knowsItsBoot)(
    'is removed when this machine made it in an earlier boot, though its pid is in use',
    async () => {
      const dir = await scratchDir();
      const name = scratchNameFor(PREFIX, {
        ...currentOwner(),
        boot: 'zzzzzzzz',
      });
      await mkdir(join(dir, name));
      await sweepAbandoned(dir, PREFIX);
      expect(existsSync(join(dir, name))).toBe(false);
    },
  );

  it.skipIf(knowsItsBoot)(
    'is removed when this machine made it in an earlier boot (needs a machine id and a boot id; not checked on this host)',
    () => {},
  );

  it.runIf(process.platform === 'linux')(
    'is removed when its pid now belongs to a process that started at another time',
    async () => {
      const dir = await scratchDir();
      const child = await running();
      const start = startOf(child.pid);
      expect(start).toMatch(/^\d+$/u);
      const name = scratchNameFor(PREFIX, {
        ...currentOwner(),
        pid: child.pid,
        start: String(Number(start) - 1),
      });
      await mkdir(join(dir, name));
      await sweepAbandoned(dir, PREFIX);
      expect(existsSync(join(dir, name))).toBe(false);
    },
  );
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
      const name = scratchName(PREFIX);
      await mkdir(join(dir, name));
      const sweeper = join(dir, '..', `${name.slice(PREFIX.length)}.ts`);
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
      expect(existsSync(join(dir, name))).toBe(true);
    },
  );

  it.skipIf(canUnshare)(
    'leaves what a run still going in this one made (needs root and unshare; not checked on this host)',
    () => {},
  );
});
