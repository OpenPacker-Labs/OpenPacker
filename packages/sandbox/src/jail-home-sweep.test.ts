import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  chmod,
  chown,
  lstat,
  mkdir,
  readdir,
  rename,
  symlink,
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
import { fileURLToPath } from 'node:url';
import {
  currentOwner,
  OWNER_FILE,
  systemProbe,
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

/** Whether `command` ran and succeeded. */
function spawnSyncOk(command: string, args: string[]): boolean {
  return spawnSync(command, args, { stdio: 'ignore' }).status === 0;
}

// The resolve hook opm-project's tests use to run TypeScript sources in a child.
const hook = new URL(
  '../../opm-project/test/fixtures/ts-resolve.mjs',
  import.meta.url,
).href;

/**
 * Another process holding its jail home: it runs a tool through
 * `runInSandbox` that says it is up and reads the FIFO it is given, and says
 * `held` once the tool is up; the tool ends when the FIFO is written.
 */
const HOLDER = `
const [src, fifo] = process.argv.slice(1);
const { runInSandbox } = await import(src + '/run.ts');
const { createMockBackend } = await import(src + '/backends/mock.ts');
const cwd = process.env.TMPDIR;
const outcome = await runInSandbox({
  argv: ['/bin/sh', '-c', 'echo up; read line < "$GO"'],
  cwd,
  env: { GO: fifo },
  policy: { enabled: true, mode: 'fail-closed', required: true },
  readwritePaths: [],
  readonlyPaths: [cwd],
  backend: createMockBackend(),
  output: {
    stdout: (chunk) => {
      if (Buffer.from(chunk).toString('utf8').includes('up'))
        process.stdout.write('held\\n');
    },
    stderr: () => undefined,
  },
});
process.exitCode = outcome.exitCode;
`;

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

const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
});

/** The first line a child writes that `test` accepts. */
function line(child: ChildProcess, test: (text: string) => boolean) {
  return new Promise<string>((resolve, reject) => {
    let seen = '';
    child.stdout!.setEncoding('utf8').on('data', (chunk: string) => {
      seen += chunk;
      const found = seen.split('\n').find(test);
      if (found !== undefined) resolve(found);
    });
    child.once('exit', (code) =>
      reject(new Error(`the child ended (${code}) having written: ${seen}`)),
    );
  });
}

describe('a home whose owner is another process, alive', () => {
  it('is kept, its pid and start time those of a process that runs', async () => {
    await ownTmpdir();
    const sleeper = spawn('sleep', ['300'], { stdio: 'ignore' });
    children.push(sleeper);
    await new Promise((resolve) => sleeper.once('spawn', resolve));
    const started = await systemProbe.stat(sleeper.pid!);
    const owner: ProcessOwner = {
      ...(await currentOwner()),
      pid: sleeper.pid!,
      ...(!(started === undefined) && { startTime: started.startTime }),
    };
    const alive = await leftHome('home-sleeper', owner);
    const dead = await leftHome('home-dead', {
      ...(await currentOwner()),
      pid: await ended(),
    });
    expect((await aRun()).exitCode).toBe(0);
    expect(present([alive, dead])).toEqual([true, false]);
  });

  it('is kept while that process holds it through runInSandbox', async () => {
    const dir = await ownTmpdir();
    const fifo = join(dir, 'go');
    expect(spawnSyncOk('mkfifo', [fifo])).toBe(true);
    const holder = spawn(
      process.execPath,
      [
        '--experimental-transform-types',
        '--import',
        hook,
        '--input-type=module',
        '-e',
        HOLDER,
        fileURLToPath(new URL('.', import.meta.url)),
        fifo,
      ],
      {
        env: { ...process.env, TMPDIR: dir, NODE_NO_WARNINGS: '1' },
        stdio: ['ignore', 'pipe', 'inherit'],
      },
    );
    children.push(holder);
    const exited = new Promise((resolve) => holder.once('exit', resolve));
    await line(holder, (text) => text === 'held');
    const [held] = await readdir(defaultJailHomeRoot());
    // This process's run sweeps first, beside the other's home.
    expect((await aRun()).exitCode).toBe(0);
    expect(await readdir(defaultJailHomeRoot())).toEqual([held]);
    await writeFile(fifo, 'go\n');
    expect(await exited).toBe(0);
    expect(await readdir(defaultJailHomeRoot())).toEqual([]);
  });
});

describe('a home swapped for a link after it was listed', () => {
  it('is judged as what is opened, never by where the link points', async () => {
    const dir = await ownTmpdir();
    const me = await currentOwner();
    const home = await leftHome('home-swapped', me);
    // What the link points at: a directory whose owner has ended.
    const decoy = await leftHome('decoy', { ...me, pid: await ended() });
    await sweepJailHomes(
      defaultJailHomeRoot(),
      {},
      {
        beforeJudging: async (name) => {
          if (name !== 'home-swapped') return;
          await rename(home, join(dir, 'moved-away'));
          await symlink(decoy, home);
        },
      },
    );
    expect((await lstat(home)).isSymbolicLink()).toBe(true);
    expect(present([join(decoy, OWNER_FILE)])).toEqual([true]);
  });
});

describe('the jail root', () => {
  it('is refused when its group or others may write it', async () => {
    await ownTmpdir();
    const root = defaultJailHomeRoot();
    await chmod(root, 0o777);
    await expect(aRun()).rejects.toThrow(
      /can be written by its group or by others \(mode 777\)/u,
    );
    expect(await readdir(root)).toEqual([]);
  });

  it.runIf(process.geteuid?.() === 0)(
    'is refused when another user owns it',
    async () => {
      await ownTmpdir();
      const root = defaultJailHomeRoot();
      await chown(root, 65534, 65534);
      await expect(aRun()).rejects.toThrow(
        /is owned by uid 65534, not by this user/u,
      );
      expect(await readdir(root)).toEqual([]);
    },
  );

  it('is where a run removes its own home, though its path came to be a link', async () => {
    const dir = await ownTmpdir();
    const decoy = join(dir, 'decoy');
    await mkdir(decoy);
    // The tool moves the root away and leaves a link to the decoy in its
    // place, with a directory there under its own home's name.
    const outcome = await aRun(
      [
        '/bin/sh',
        '-c',
        'own=$(dirname "$HOME"); root=$(dirname "$own"); name=$(basename "$own"); ' +
          'mv "$root" "$root.moved" && mkdir -p "$DECOY/$name" && ' +
          'touch "$DECOY/$name/kept" && ln -s "$DECOY" "$root" && echo "$name"',
      ],
      { env: { DECOY: decoy } },
    );
    expect(outcome.exitCode, outcome.stderr).toBe(0);
    const name = outcome.stdout.trim();
    expect(present([join(decoy, name, 'kept')])).toEqual([true]);
    expect(await readdir(`${defaultJailHomeRoot()}.moved`)).toEqual([]);
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
