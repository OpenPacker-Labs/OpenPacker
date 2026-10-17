import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  currentOwner,
  describeProcessOwner,
  parseProcessOwner,
  isOwnerAlive,
  type ProcessOwner,
} from '../src/index.js';

/**
 * Whether the holder of a lock or a rollback copy may still be running. A pid
 * means something only on its own machine, boot and PID namespace; anything
 * that differs, or is known on one side only, counts as alive.
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
    expect(describeProcessOwner(owner)).toBe(
      `process ${owner.pid} on ${owner.host}`,
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

describe('an owner this process cannot judge counts as alive', () => {
  // Every case names a pid that has exited here, so only the place decides.
  // A boot id that differs on this machine is an earlier boot, which is
  // certain: see the next block. On another machine it is not.
  for (const field of ['host', 'machineId', 'pidNamespace'] as const)
    it(`when its ${field} differs`, async () => {
      const owner = await goneHere();
      expect(await isOwnerAlive({ ...owner, [field]: 'elsewhere0' })).toBe(
        true,
      );
    });
  // A record without one of these, read where it is known (an older opm, or
  // another system), says nothing about where its pid lives.
  for (const field of ['machineId', 'bootId', 'pidNamespace'] as const)
    it.runIf(linux)(`when its ${field} is known here only`, async () => {
      const { [field]: _known, ...partial } = await goneHere();
      expect(await isOwnerAlive(partial)).toBe(true);
    });
});

/** This process, where it can say which machine and boot it runs on. */
const self = await currentOwner();
const knowsBoot = self.machineId !== undefined && self.bootId !== undefined;

describe.runIf(knowsBoot)(
  'an owner from an earlier boot of this machine',
  () => {
    // This process's pid, so that only the boot id can make it gone.
    const earlier = async (): Promise<ProcessOwner> => ({
      ...(await currentOwner()),
      bootId: '00000000-0000-4000-8000-000000000000',
    });

    it('is gone: every process of that boot has ended', async () => {
      const owner = await earlier();
      expect(await isOwnerAlive(owner)).toBe(false);
      // Its PID namespace is gone with it; one that differs changes nothing.
      expect(await isOwnerAlive({ ...owner, pidNamespace: '1' })).toBe(false);
    });

    it.each([
      ['its machine id differs', { machineId: 'f'.repeat(32) }],
      ['its host differs', { host: 'elsewhere0' }],
    ])('counts as alive when %s', async (_case, other) => {
      expect(await isOwnerAlive({ ...(await earlier()), ...other })).toBe(true);
    });

    it('counts as alive when no machine id says it is this machine', async () => {
      const { machineId: _none, ...owner } = await earlier();
      expect(await isOwnerAlive(owner)).toBe(true);
    });
  },
);

describe('a record read back from disk', () => {
  it('keeps an owner whose fields are well formed', async () => {
    const owner = await currentOwner();
    expect(parseProcessOwner(JSON.parse(JSON.stringify(owner)))).toEqual(owner);
  });

  it.each([
    ['no pid', { host: 'vm' }],
    ['pid 0', { pid: 0, host: 'vm' }],
    ['a pid as text', { pid: '12', host: 'vm' }],
    ['no host', { pid: 12 }],
    [
      'a start time that is not a field',
      { pid: 12, host: 'vm', startTime: '1 2' },
    ],
    ['a namespace as a number', { pid: 12, host: 'vm', pidNamespace: 4 }],
    ['not an object', 'process 12'],
  ])('refuses %s', (_case, value) => {
    expect(parseProcessOwner(value)).toBeUndefined();
  });
});

/** Whether this machine lets a process start a PID namespace of its own. */
const unshare =
  linux &&
  spawnSync('unshare', ['--pid', '--fork', '--mount-proc', 'true']).status ===
    0;
if (!unshare)
  console.warn(
    'process-owner.test.ts: `unshare --pid --fork --mount-proc` is refused here (it needs root or user namespaces); the PID-namespace case is skipped',
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
