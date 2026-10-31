/**
 * A lease's pid is judged by the one owner rule (`isOwnerAlive` of
 * `process-owner.ts`), as every holder opm records is:
 *
 * - a zombie nobody reaped, and a dead process (`X`), are gone: they have
 *   exited, and cannot release a lease;
 * - a reader that cannot read its own start time may be looking at another pid
 *   namespace's `/proc` (`unshare --pid` without `--mount-proc`), where a pid's
 *   start time and descriptors are another process's: it takes every pid that
 *   answers for alive, and never removes a lease it cannot judge.
 *
 * A real zombie, and the rest through the rule's `/proc` seam (`probe`) or a
 * reader that says what it could not read.
 */

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { isOwnerAlive, type LeaseOwner } from '../src/lease-owner.js';
import type { OwnerProbe } from '../src/process-owner.js';
import { leaseHeld } from '../src/store-lease-liveness.js';
import { leaseDirectory, parseLeaseName } from '../src/store-lease.js';
import { cleanupWorlds, scratch } from './gc-race-fixture.js';
import { LINUX, endedPid, forged, leaseId, me } from './lease-fixture.js';

afterEach(cleanupWorlds);

const KEY = `sha256-${'a'.repeat(64)}`;

/** State and start time of `pid`, read here rather than by the module. */
async function stat(pid: number): Promise<{ state: string; start: string }> {
  const text = await readFile(`/proc/${pid}/stat`, 'utf8');
  const fields = text.slice(text.lastIndexOf(')') + 2).split(' ');
  return { state: fields[0]!, start: fields[19]! };
}

/** Whether a forged lease of `how`, made by `owner`, is held, judged with `options`. */
async function judged(
  how: string,
  owner: LeaseOwner,
  options: Parameters<typeof leaseHeld>[2] = {},
): Promise<boolean> {
  const store = await scratch('opm-lease-pid-');
  const id = leaseId(how, owner);
  await forged(store, id, KEY);
  return leaseHeld(
    leaseDirectory(store),
    parseLeaseName(`${id}.lock`)!,
    options,
  );
}

/** A system that answers every pid with `state`, started at `start`. */
function answering(state: string, start: string): OwnerProbe {
  return {
    signal: () => undefined,
    stat: async () => ({ state, startTime: start }),
    tasks: async () => 1,
  };
}

describe.runIf(LINUX)('a lease whose holder is a zombie nobody reaped', () => {
  it('is abandoned, though kill(pid, 0) still answers and it started when the holder did', async () => {
    // `sleep` as the parent never waits for its child: a subshell prints its
    // pid and becomes `sleep`; killed, it stays a zombie of the parent.
    const parent = spawn(
      'sh',
      ['-c', 'sh -c "echo \\$\\$; exec sleep 600" & exec sleep 600'],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    try {
      const pid = await new Promise<number>((resolve) =>
        parent.stdout.once('data', (data: Buffer) => resolve(Number(data))),
      );
      const owner = { ...(await me()), pid, start: (await stat(pid)).start };
      expect(await isOwnerAlive(owner)).toBe(true);
      expect(await judged('pid', owner)).toBe(true);

      process.kill(pid, 'SIGKILL');
      while ((await stat(pid)).state !== 'Z')
        await new Promise((resolve) => setTimeout(resolve, 20));
      // Still there for the system, so the signal answers, and its start time
      // is the holder's.
      expect(() => process.kill(pid, 0)).not.toThrow();
      expect((await stat(pid)).start).toBe(owner.start);

      expect(await isOwnerAlive(owner)).toBe(false);
      expect(await judged('pid', owner)).toBe(false);
    } finally {
      const gone = new Promise((resolve) => parent.on('exit', resolve));
      parent.kill('SIGKILL');
      await gone;
    }
  });
});

describe.runIf(LINUX)('a lease whose holder is dead (state X)', () => {
  it('is abandoned, though its pid answers and started when the holder did', async () => {
    const owner = await me();
    const probe = answering('X', owner.start);

    expect(await isOwnerAlive(owner, owner, probe)).toBe(false);
    expect(await judged('pid', owner, { probe })).toBe(false);
  });

  it('is held while that pid is a process that runs', async () => {
    const owner = await me();
    const probe = answering('S', owner.start);

    expect(await isOwnerAlive(owner, owner, probe)).toBe(true);
    expect(await judged('pid', owner, { probe })).toBe(true);
  });
});

describe.runIf(LINUX)('a reader that cannot read its own start time', () => {
  it('takes a pid that answers for the holder, whenever that process started', async () => {
    // This process has the pid and started at another time than the holder:
    // a reader that can read its own start time knows the pid was reused.
    const owner = { ...(await me()), start: '1' };
    const reader = { ...(await me()), start: '0' };

    expect(await isOwnerAlive(owner, { ...reader, start: '2' })).toBe(false);
    expect(await isOwnerAlive(owner, reader)).toBe(true);
  });

  it('never removes a `pid` lease whose pid answers', async () => {
    const owner = { ...(await me()), start: '1' };
    const reader = { ...(await me()), start: '0' };

    expect(await judged('pid', owner, { reader })).toBe(true);
  });

  it('never removes a `proc` lease by a descriptor listing it cannot trust', async () => {
    // Nobody holds the forged lock: a listing of this process's descriptors
    // would call it abandoned, and under another namespace's /proc that
    // listing is another process's.
    const owner = await me();
    const reader = { ...owner, start: '0' };
    const listed: number[] = [];
    const descriptors = async (pid: number) => {
      listed.push(pid);
      return [];
    };

    expect(await judged('proc', owner, { reader, descriptors })).toBe(true);
    expect(listed).toEqual([]);
    // A reader that can read its own start time trusts the listing.
    expect(await judged('proc', owner, { descriptors })).toBe(false);
    expect(listed).toEqual([process.pid]);
  });

  it('still takes a pid no process has for gone: the signal is asked of the kernel, not of /proc', async () => {
    const owner = { ...(await me()), pid: endedPid() };
    const reader = { ...(await me()), start: '0' };

    expect(await isOwnerAlive(owner, reader)).toBe(false);
    expect(await judged('pid', owner, { reader })).toBe(false);
  });
});
