/**
 * A `proc` lease is held while its pid has the lock file open. When the
 * descriptors cannot be inspected (another user's process, one that is not
 * dumpable) nothing says whether the pid is still the holder's, except when
 * it started: a pid reused by a process that started later is not the holder,
 * and one that started when the holder did, or that cannot be read, may be.
 *
 * Two ways in: the descriptor listing refused as the kernel refuses it (a
 * child run as another user, against a process of root's), and refused by a
 * seam, so that every platform with `/proc` runs the rule.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmod, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { leaseHeld } from '../src/store-lease-liveness.js';
import { leaseDirectory, parseLeaseName } from '../src/store-lease.js';
import { cleanupWorlds, scratch } from './gc-race-fixture.js';
import { LINUX, forged, leaseId, me } from './lease-fixture.js';
import { childEnv, source, tsNodeArgs } from './ts-child.js';

afterEach(cleanupWorlds);

const PACKAGE = fileURLToPath(new URL('..', import.meta.url));
const KEY = `sha256-${'a'.repeat(64)}`;

/** A listing the operating system refuses. */
function refused(code: string) {
  return async (): Promise<string[]> => {
    throw Object.assign(new Error(`${code}: cannot list descriptors`), {
      code,
    });
  };
}

/** Judge a forged `proc` lease made by `owner`, nobody holding its lock. */
async function judge(
  owner: Awaited<ReturnType<typeof me>>,
  descriptors: (pid: number) => Promise<string[]>,
): Promise<boolean> {
  const store = await scratch('opm-lease-proc-');
  const id = leaseId('proc', owner);
  await forged(store, id, KEY);
  return leaseHeld(leaseDirectory(store), parseLeaseName(`${id}.lock`)!, {
    descriptors,
  });
}

describe.runIf(LINUX)(
  'a proc lease whose holder has its descriptors hidden',
  () => {
    it('is abandoned when the process with its pid started after the holder', async () => {
      const calls: number[] = [];
      const held = await judge({ ...(await me()), start: '1' }, async (pid) => {
        calls.push(pid);
        return refused('EACCES')();
      });

      expect(calls).toEqual([process.pid]);
      expect(held).toBe(false);
    });

    it('is held when the process with its pid started when the holder did', async () => {
      // This process has the pid and the start time, and not the lock.
      expect(await judge(await me(), refused('EACCES'))).toBe(true);
    });

    it('is held when it does not say when its holder started', async () => {
      expect(
        await judge({ ...(await me()), start: '0' }, refused('EACCES')),
      ).toBe(true);
    });

    it('is held when the listing is refused any other way', async () => {
      expect(await judge(await me(), refused('EIO'))).toBe(true);
    });

    it.each(['ENOENT', 'ESRCH'])(
      'is abandoned when the listing says the process is gone (%s), whenever it started',
      async (code) => {
        expect(await judge(await me(), refused(code))).toBe(false);
      },
    );
  },
);

/** What a child run as another user says of the leases it is asked about. */
const SCRIPT = `
const [src, directory, pid, ...names] = process.argv.slice(1);
const { readdir } = await import('node:fs/promises');
const { leaseHeld, parseLeaseName } = await import(src + '/store-lease.ts');
const listing = await readdir('/proc/' + pid + '/fd').then(
  () => 'listed',
  (error) => error.code,
);
const held = {};
for (const name of names)
  held[name] = await leaseHeld(directory, parseLeaseName(name + '.lock'));
process.stdout.write(JSON.stringify({ uid: process.getuid(), listing, held }));
`;

const NOBODY = 65534;

describe.runIf(LINUX && process.getuid?.() === 0)(
  'a lease whose pid is now a process of another user',
  () => {
    const children: ChildProcess[] = [];
    afterEach(() => {
      for (const child of children.splice(0)) child.kill('SIGKILL');
    });

    it('is abandoned when that process started after the holder, and held while it started when the holder did, whichever lock the lease uses', async (context) => {
      // A process of root's that never held any of these locks.
      const sleeper = spawn('sleep', ['300'], { stdio: 'ignore' });
      children.push(sleeper);
      const pid = sleeper.pid!;
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
      const started = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]!;
      const store = await scratch('opm-lease-proc-user-');
      const ids: Record<string, string> = {};
      for (const how of ['proc', 'pid']) {
        const owner = { ...(await me()), pid };
        ids[`${how}, started later`] = leaseId(how, { ...owner, start: '1' });
        ids[`${how}, same start`] = leaseId(how, { ...owner, start: started });
      }
      for (const id of Object.values(ids)) await forged(store, id, KEY);
      for (const path of [store, leaseDirectory(store)])
        await chmod(path, 0o755);

      const ran = spawnSync(
        process.execPath,
        tsNodeArgs(SCRIPT, [
          dirname(source('index')),
          leaseDirectory(store),
          String(pid),
          ...Object.values(ids),
        ]),
        {
          cwd: PACKAGE,
          env: childEnv(),
          uid: NOBODY,
          gid: NOBODY,
          encoding: 'utf8',
        },
      );
      context.skip(
        ran.status !== 0,
        `a child run as uid ${NOBODY} cannot import the sources here: ${ran.stderr.slice(0, 200)}`,
      );
      const seen = JSON.parse(ran.stdout) as {
        uid: number;
        listing: string;
        held: Record<string, boolean>;
      };
      context.skip(
        seen.listing === 'listed',
        'this system lets any user list the descriptors of root-owned processes',
      );

      expect(seen.uid).toBe(NOBODY);
      expect(seen.listing).toBe('EACCES');
      expect(
        Object.fromEntries(
          Object.entries(ids).map(([label, id]) => [label, seen.held[id]]),
        ),
      ).toEqual({
        'proc, started later': false,
        'proc, same start': true,
        'pid, started later': false,
        'pid, same start': true,
      });
    }, 60_000);
  },
);
