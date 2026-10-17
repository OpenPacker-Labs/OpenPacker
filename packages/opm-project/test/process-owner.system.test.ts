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
          bootId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
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

/** Whether this machine lets a process start a PID namespace of its own. */
const unshare =
  linux &&
  spawnSync('unshare', ['--pid', '--fork', '--mount-proc', 'true']).status ===
    0;
if (!unshare)
  console.warn(
    'process-owner.system.test.ts: `unshare --pid --fork --mount-proc` is refused here (it needs root or user namespaces); the PID-namespace case is skipped',
  );

describe.runIf(unshare)('a live process in another PID namespace', () => {
  it('counts as alive, whatever its pid names here', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'opm-owner-pidns-'));
    temps.push(dir);
    const script = join(dir, 'owner.ts');
    const report = join(dir, 'owner.json');
    await writeFile(
      script,
      `import { writeFile } from 'node:fs/promises';
       import { currentOwner } from ${JSON.stringify(ownerSource)};
       await writeFile(${JSON.stringify(report)}, JSON.stringify(await currentOwner()));
       setInterval(() => {}, 1000);`,
    );
    const child = spawn(
      'unshare',
      ['--pid', '--fork', '--kill-child', '--mount-proc', viteNode, script],
      { stdio: 'ignore' },
    );
    try {
      while (!existsSync(report))
        await new Promise((resolve) => setTimeout(resolve, 50));
      // SAFETY: written by the child a moment ago.
      const owner = JSON.parse(await readFile(report, 'utf8')) as ProcessOwner;
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
});
