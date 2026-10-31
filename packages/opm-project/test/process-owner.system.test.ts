import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  currentOwner,
  isOwnerAlive,
  systemProbe,
  type ProcessOwner,
} from '../src/index.js';
import { describeNamespaced, pidNamespace } from './namespaces.js';

/**
 * The owner rule against the real system: this process, a process that has
 * exited, a zombie nobody reaped, an earlier boot, and a process in another
 * PID namespace. The rule's branches are in process-owner.test.ts.
 */

const here = dirname(fileURLToPath(import.meta.url));
const viteNode = join(here, '../../../node_modules/.bin/vite-node');
const ownerSource = join(here, '../src/process-owner.ts');
const linux = process.platform === 'linux';

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(
    temps.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

/** The id of a process that has exited. */
async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise((resolve) => child.on('exit', resolve));
  return child.pid!;
}

/** This process's place (machine, boot, namespace) with an exited pid. */
async function goneHere(): Promise<ProcessOwner> {
  const { startTime: _ignored, ...place } = await currentOwner();
  return { ...place, pid: await exitedPid() };
}

describe('the owner a record names', () => {
  it('is this process, with where its pid means something', async () => {
    const owner = await currentOwner();
    expect(owner.pid).toBe(process.pid);
    expect(owner.host).not.toBe('');
    if (linux)
      expect(owner).toEqual(
        expect.objectContaining({
          startTime: expect.stringMatching(/^\d+$/u),
          pidNamespace: expect.stringMatching(/^\d+$/u),
          // A digest of the boot id, not the id (X4).
          bootId: expect.stringMatching(/^d1-[0-9a-f]{32}$/u),
        }),
      );
    expect(await isOwnerAlive(owner)).toBe(true);
  });

  it('is gone when its pid is free here', async () => {
    expect(await isOwnerAlive(await goneHere())).toBe(false);
  });

  it.runIf(linux)(
    'is gone when its pid now belongs to a process that started at another time',
    async () => {
      const owner = await currentOwner();
      expect(await isOwnerAlive({ ...owner, startTime: '1' })).toBe(false);
    },
  );
});

describe.runIf(linux)('a killed process that nobody has reaped', () => {
  it('is gone, though kill(pid, 0) still answers', async () => {
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
      const stat = await systemProbe.stat(pid);
      const owner = {
        ...(await currentOwner()),
        pid,
        startTime: stat!.startTime,
      };
      expect(await isOwnerAlive(owner)).toBe(true);

      process.kill(pid, 'SIGKILL');
      while ((await systemProbe.stat(pid))?.state !== 'Z')
        await new Promise((resolve) => setTimeout(resolve, 20));
      // Still there for the system, so the signal answers.
      expect(() => process.kill(pid, 0)).not.toThrow();
      expect(await isOwnerAlive(owner)).toBe(false);
    } finally {
      parent.kill('SIGKILL');
    }
  });
});

describe.runIf(linux)('an owner from an earlier boot of this machine', () => {
  it('is gone, though its pid is this process', async () => {
    const owner = await currentOwner();
    if (owner.machineId === undefined || owner.bootId === undefined) return;
    expect(
      await isOwnerAlive({
        ...owner,
        bootId: '00000000-0000-4000-8000-000000000000',
      }),
    ).toBe(false);
  });
});

describeNamespaced(
  'a live process in another PID namespace',
  pidNamespace,
  () => {
    it('counts as alive, whatever its pid names here', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'opm-owner-pidns-'));
      temps.push(dir);
      const script = join(dir, 'owner.ts');
      // The report is written beside its name and renamed into it, so the
      // name stands for a whole report: the wait below is for the name, and a
      // file opened but not yet written read as "Unexpected end of JSON input".
      const report = join(dir, 'owner.json');
      const part = `${report}.part`;
      await writeFile(
        script,
        `import { rename, writeFile } from 'node:fs/promises';
       import { currentOwner } from ${JSON.stringify(ownerSource)};
       await writeFile(${JSON.stringify(part)}, JSON.stringify(await currentOwner()));
       await rename(${JSON.stringify(part)}, ${JSON.stringify(report)});
       setInterval(() => {}, 1000);`,
      );
      const [command, ...options] = pidNamespace!;
      const child = spawn(
        command!,
        [...options, '--kill-child', viteNode, script],
        { stdio: 'ignore' },
      );
      try {
        while (!existsSync(report))
          await new Promise((resolve) => setTimeout(resolve, 50));
        // SAFETY: written whole by the child, then named.
        const owner = JSON.parse(
          await readFile(report, 'utf8'),
        ) as ProcessOwner;
        const self = await currentOwner();
        // The first process of its namespace: pid 1, which here is init.
        expect(owner.pid).toBe(1);
        expect(owner.pidNamespace).not.toBe(self.pidNamespace);
        expect(owner.host).toBe(self.host);
        expect(await isOwnerAlive(owner)).toBe(true);
      } finally {
        const gone = new Promise((resolve) => child.on('exit', resolve));
        child.kill('SIGKILL');
        await gone;
      }
    }, 60_000);
  },
);

describe.runIf(linux)('a zombie that leads threads that still run', () => {
  const cc = spawnSync('cc', ['--version'], { stdio: 'ignore' }).status === 0;
  it.runIf(cc)(
    'is alive: its leader is Z, and its other threads are the process',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'opm-owner-leader-'));
      temps.push(dir);
      const source = join(dir, 'leader.c');
      await writeFile(
        source,
        `#include <pthread.h>
         #include <stdio.h>
         #include <unistd.h>
         static void *worker(void *a) { for (;;) sleep(1); return 0; }
         int main(void) {
           pthread_t t;
           pthread_create(&t, 0, worker, 0);
           printf("%d\\n", (int)getpid());
           fflush(stdout);
           pthread_exit(0);
         }`,
      );
      const program = join(dir, 'leader');
      expect(spawnSync('cc', ['-pthread', '-o', program, source]).status).toBe(
        0,
      );
      const child = spawn(program, [], { stdio: ['ignore', 'pipe', 'ignore'] });
      try {
        const pid = await new Promise<number>((resolve) =>
          child.stdout.once('data', (data: Buffer) => resolve(Number(data))),
        );
        let stat = await systemProbe.stat(pid);
        while (stat?.state !== 'Z') {
          await new Promise((resolve) => setTimeout(resolve, 20));
          stat = await systemProbe.stat(pid);
        }
        const owner = {
          ...(await currentOwner()),
          pid,
          startTime: stat.startTime,
        };
        expect(await isOwnerAlive(owner)).toBe(true);
        const gone = new Promise((resolve) => child.on('exit', resolve));
        child.kill('SIGKILL');
        await gone;
        expect(await isOwnerAlive(owner)).toBe(false);
      } finally {
        child.kill('SIGKILL');
      }
    },
    60_000,
  );
});
