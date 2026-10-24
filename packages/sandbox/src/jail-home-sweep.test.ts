import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import {
  currentOwner,
  OWNER_FILE,
  writeOwnerFile,
  type ProcessOwner,
} from '@openpacker/project-io';
import { createMockBackend } from './backends/mock.js';
import {
  createNativeBackend,
  findTrustedSandboxHelper,
} from './backends/native.js';
import { defaultJailHomeRoot } from './env.js';
import { sweepJailHomes, UNOWNED_JAIL_HOME_MS } from './jail-home.js';
import { runInSandbox } from './run.js';
import type { RunInSandboxInput, SandboxBackend } from './types.js';

/**
 * A run killed outright (SIGKILL, a crash, a second signal) never removed its
 * jail home, and nothing else did: `$TMPDIR/openpacker-sandbox/home-*` stayed,
 * with whatever the tool wrote there. A home now names its owner, and every run
 * first removes the homes whose owner has ended, by the owner rule
 * (`process-owner.ts`), and nothing it cannot judge.
 */

const restores: (() => void)[] = [];
const temps: string[] = [];
afterEach(async () => {
  for (const restore of restores.splice(0)) restore();
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

/** A temp directory of the test's own, so the jail root is too. */
async function ownTmpdir(): Promise<string> {
  const base = await realpath(tmpdir());
  const dir = join(base, `op-jail-sweep-${process.pid}-${temps.length}`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir);
  temps.push(dir);
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = dir;
  restores.push(() => {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
  });
  await mkdir(defaultJailHomeRoot(), { recursive: true });
  return dir;
}

/** The pid of a process that has ended. */
async function ended(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise((resolve) => child.once('exit', resolve));
  return child.pid!;
}

/** A home a run left in the jail root: its directory, with `owner` in `.owner` when given. */
async function leftHome(
  name: string,
  owner?: ProcessOwner | 'garbage',
): Promise<string> {
  const path = join(defaultJailHomeRoot(), name);
  await mkdir(join(path, 'home', 'tmp'), { recursive: true });
  await writeFile(join(path, 'home', 'tmp', 'what-the-tool-wrote'), 'x');
  if (owner === 'garbage') await writeFile(join(path, OWNER_FILE), '{');
  else if (owner !== undefined) await writeOwnerFile(path, owner);
  return path;
}

/** A home an opm from before owners left: the home itself, with no `.owner`. */
async function legacyHome(name: string, ageMs: number): Promise<string> {
  const path = join(defaultJailHomeRoot(), name);
  await mkdir(join(path, 'tmp'), { recursive: true });
  const when = new Date(Date.now() - ageMs);
  await utimes(path, when, when);
  return path;
}

/** One quick run, through the mock backend. */
async function aRun(
  argv: string[] = ['/bin/sh', '-c', 'echo ran'],
  extra: Partial<RunInSandboxInput> = {},
) {
  const cwd = await realpath(tmpdir());
  return await runInSandbox({
    argv,
    cwd,
    policy: { enabled: true, mode: 'fail-closed', required: true },
    readwritePaths: [],
    readonlyPaths: [cwd],
    backend: createMockBackend(),
    ...extra,
  });
}

const present = (paths: readonly string[]) =>
  paths.map((path) => existsSync(path));

describe('a run removes the jail homes runs that ended left', () => {
  it('removes a home whose owner is a pid that has ended', async () => {
    await ownTmpdir();
    const dead = await leftHome('home-dead', {
      ...(await currentOwner()),
      pid: await ended(),
    });
    expect((await aRun()).exitCode).toBe(0);
    expect(present([dead])).toEqual([false]);
    // Nothing is left of it, nor of the run's own home.
    expect(await readdir(defaultJailHomeRoot())).toEqual([]);
  });

  it('keeps a home whose owner is alive, elsewhere or unreadable', async () => {
    await ownTmpdir();
    const me = await currentOwner();
    const alive = await leftHome('home-alive', me);
    const elsewhere = await leftHome('home-elsewhere', {
      ...me,
      host: 'another-host',
      pid: await ended(),
    });
    const unreadable = await leftHome('home-unreadable', 'garbage');
    const dead = await leftHome('home-dead', { ...me, pid: await ended() });
    expect((await aRun()).exitCode).toBe(0);
    expect(present([alive, elsewhere, unreadable, dead])).toEqual([
      true,
      true,
      true,
      false,
    ]);
  });

  it('keeps a home with no owner while it is young, and removes it once old', async () => {
    await ownTmpdir();
    const young = await legacyHome('home-Young1', 60_000);
    const old = await legacyHome('home-OldOne', UNOWNED_JAIL_HOME_MS + 60_000);
    expect((await aRun()).exitCode).toBe(0);
    expect(present([young, old])).toEqual([true, false]);
  });

  it('removes the tombstone a run killed while removing a home left', async () => {
    await ownTmpdir();
    const tombstone = join(
      defaultJailHomeRoot(),
      '.home-left.sweep-00000000-0000-4000-8000-000000000000',
    );
    await mkdir(join(tombstone, 'home'), { recursive: true });
    expect((await aRun()).exitCode).toBe(0);
    expect(present([tombstone])).toEqual([false]);
  });
});

describe('runs at the same time', () => {
  it('never remove each other’s homes, and still remove an ended one', async () => {
    const dir = await ownTmpdir();
    const stop = join(dir, 'stop');
    const dead = await leftHome('home-dead', {
      ...(await currentOwner()),
      pid: await ended(),
    });
    // A run that writes its home, holds until told, and reads it back.
    let said = '';
    const holding = aRun(
      [
        '/bin/sh',
        '-c',
        'echo held > "$HOME/mark"; echo t > "$TMPDIR/mark"; echo up; ' +
          'while [ ! -e "$STOP" ]; do sleep 0.02; done; cat "$HOME/mark" "$TMPDIR/mark"',
      ],
      {
        env: { STOP: stop },
        output: {
          stdout: (chunk) => (said += Buffer.from(chunk).toString('utf8')),
          stderr: () => undefined,
        },
      },
    );
    for (const until = Date.now() + 20_000; Date.now() < until; ) {
      if (said.includes('up')) break;
      await sleep(20);
    }
    expect(said).toBe('up\n');
    // Six more, together, each sweeping first, each using its home meanwhile.
    const others = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        aRun([
          '/bin/sh',
          '-c',
          `echo ${index} > "$HOME/mark"; echo ${index} > "$TMPDIR/mark"; ` +
            'sleep 0.1; cat "$HOME/mark" "$TMPDIR/mark"',
        ]),
      ),
    );
    expect(others.map((outcome) => [outcome.exitCode, outcome.stdout])).toEqual(
      Array.from({ length: 6 }, (_, index) => [0, `${index}\n${index}\n`]),
    );
    expect(present([dead])).toEqual([false]);
    await writeFile(stop, '');
    expect((await holding).exitCode).toBe(0);
    expect(said).toBe('up\nheld\nt\n');
    expect(await readdir(defaultJailHomeRoot())).toEqual([]);
  }, 60_000);

  it('of two sweeps of the same homes, one removes each, and neither fails', async () => {
    await ownTmpdir();
    const me = await currentOwner();
    const dead = await Promise.all(
      Array.from({ length: 8 }, async (_, index) =>
        leftHome(`home-dead-${index}`, { ...me, pid: await ended() }),
      ),
    );
    const alive = await leftHome('home-alive', me);
    await Promise.all([
      sweepJailHomes(defaultJailHomeRoot()),
      sweepJailHomes(defaultJailHomeRoot()),
    ]);
    expect(await readdir(defaultJailHomeRoot())).toEqual(['home-alive']);
    expect(present([...dead, alive])).toEqual([...dead.map(() => false), true]);
  });
});

const nativeBackend = createNativeBackend();
const bwrapReady =
  process.platform === 'linux' &&
  findTrustedSandboxHelper('bwrap') !== undefined &&
  nativeBackend?.id === 'native-bwrap';

describe.runIf(bwrapReady)('the owner of a run’s home', () => {
  it('is this process, beside the home the tool is given, and out of its sight', async () => {
    // The run's directory, apart from the jail root that is in the same
    // temporary directory.
    const work = join(await ownTmpdir(), 'work');
    await mkdir(work);
    const stop = join(work, 'stop');
    let said = '';
    const run = aRun(
      [
        '/bin/sh',
        '-c',
        'ls -A "$HOME"; cat "$HOME/../.owner" 2>/dev/null || echo hidden; ' +
          'echo up; while [ ! -e "$STOP" ]; do sleep 0.02; done',
      ],
      {
        backend: nativeBackend as SandboxBackend,
        env: { STOP: stop },
        readonlyPaths: [work],
        cwd: work,
        output: {
          stdout: (chunk) => (said += Buffer.from(chunk).toString('utf8')),
          stderr: () => undefined,
        },
      },
    );
    for (const until = Date.now() + 20_000; Date.now() < until; ) {
      if (said.includes('up')) break;
      await sleep(20);
    }
    const [name] = await readdir(defaultJailHomeRoot());
    const record = JSON.parse(
      await readFile(join(defaultJailHomeRoot(), name!, OWNER_FILE), 'utf8'),
    ) as { owner: ProcessOwner };
    await writeFile(stop, '');
    expect((await run).exitCode).toBe(0);
    expect(record.owner).toEqual(await currentOwner());
    expect(said).toBe('tmp\nhidden\nup\n');
  }, 60_000);
});
