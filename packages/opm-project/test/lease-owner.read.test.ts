import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  leaseMachine,
  readLeaseOwner,
  UNKNOWN,
  type LeaseOwner,
} from '../src/lease-owner.js';
import type { OwnerReads } from '../src/owner-system.js';
import { describeNamespaced, stalePidNamespace } from './namespaces.js';
import { childEnv, source, tsNodeArgs } from './ts-child.js';

/**
 * What a process reads about itself to name itself in a lease: its start time
 * only from a `/proc` that is its own pid namespace's (the read
 * `owner-system.ts` makes for an owner record), and its machine by a keyed
 * digest of the machine id. Through the reads' seam, and in a real pid
 * namespace that still sees its parent's `/proc`.
 */

const BOOT = '9f7295d1-5100-478f-84e5-84ce9db4b369';
const MACHINE = '4c398f739c8447eb99d3fe100ad1b0fa';

/** `/proc/<pid>/stat` of a process that started 500 ticks after boot. */
const statOf = (pid: number) =>
  `${pid} (node) S 1 ${pid} ${pid} 0 -1 4194560 1 2 3 4 5 6 7 8 20 0 1 0 500 0 0`;

/** The reads of a Linux process with pid 100 that answers as told. */
function reads(over: Partial<OwnerReads> = {}): OwnerReads {
  return {
    pid: 100,
    hostname: () => 'vm',
    stat: async () => statOf(100),
    pidNamespace: async () => '4026531836',
    bootId: async () => `${BOOT}\n`,
    machineId: async () => MACHINE,
    ...over,
  };
}

const hostHex = createHash('sha256').update('vm').digest('hex');

describe('this process as a lease names it', () => {
  it('reads its pid, start time, namespace, boot and machine', async () => {
    expect(await readLeaseOwner(reads())).toEqual({
      pid: 100,
      start: '500',
      namespace: '4026531836',
      boot: BOOT.replaceAll('-', ''),
      machine: leaseMachine(MACHINE),
      host: hostHex.slice(0, 16),
    } satisfies LeaseOwner);
  });

  it('names the machine by a keyed digest of its id, and by a digest of the host name where there is none', async () => {
    const self = await readLeaseOwner(reads());
    expect(self.machine).not.toBe(MACHINE);
    expect(JSON.stringify(self)).not.toContain(MACHINE);
    const none = await readLeaseOwner(
      reads({ machineId: async () => undefined }),
    );
    expect(none.machine).toBe(hostHex.slice(0, 32));
  });

  it("does not read a start time from a /proc that is another pid namespace's", async () => {
    // `unshare --pid` without `--mount-proc`: this process is pid 1 here, and
    // its parent namespace's /proc names it 1761.
    const stale = await readLeaseOwner(
      reads({ pid: 1, stat: async () => statOf(1761) }),
    );
    expect(stale.start).toBe(UNKNOWN);
    expect(stale.pid).toBe(1);
  });

  it('says `0` for what it could not read', async () => {
    const refused = async (): Promise<string | undefined> => {
      throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    };
    expect(
      await readLeaseOwner(
        reads({
          stat: refused,
          pidNamespace: refused,
          bootId: refused,
          machineId: refused,
        }),
      ),
    ).toEqual({
      pid: 100,
      start: UNKNOWN,
      namespace: UNKNOWN,
      boot: UNKNOWN,
      machine: hostHex.slice(0, 32),
      host: hostHex.slice(0, 16),
    });
  });
});

/** What `currentOwner` says in the child it runs in. */
const SCRIPT = `
const [src] = process.argv.slice(1);
const { currentOwner } = await import(src);
process.stdout.write(JSON.stringify(await currentOwner()));
`;

describeNamespaced(
  "a process in a pid namespace that sees its parent's /proc",
  stalePidNamespace,
  () => {
    it('names itself with no start time, which no reader would compare', () => {
      const [command, ...options] = stalePidNamespace!;
      const ran = spawnSync(
        command!,
        [
          ...options,
          '--kill-child',
          process.execPath,
          ...tsNodeArgs(SCRIPT, [source('lease-owner')]),
        ],
        { env: childEnv(), encoding: 'utf8' },
      );
      expect(ran.stderr).toBe('');
      // SAFETY: written by the child, checked field by field below.
      const owner = JSON.parse(ran.stdout) as LeaseOwner;
      // The first process of its namespace; /proc/1 here is this one's init.
      expect(owner.pid).toBe(1);
      expect(owner.start).toBe(UNKNOWN);
      expect(owner.namespace).toMatch(/^\d+$/u);
    }, 60_000);
  },
);
