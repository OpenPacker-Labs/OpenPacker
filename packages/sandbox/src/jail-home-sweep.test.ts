import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
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
import { heard } from './test-output.js';
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
const stops: AbortController[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  for (const stop of stops.splice(0)) stop.abort();
});

/** A signal that ends a run the test left holding, should it fail. */
function ending(): AbortSignal {
  const stop = new AbortController();
  stops.push(stop);
  return stop.signal;
}

/** FIFOs in `dir`, one per name: a tool reading one holds until it is written. */
function gates(dir: string, names: readonly string[]): string[] {
  return names.map((name) => {
    const fifo = join(dir, name);
    expect(spawnSyncOk('mkfifo', [fifo])).toBe(true);
    return fifo;
  });
}

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
  it('is refused when others may write it', async () => {
    await ownTmpdir();
    const root = defaultJailHomeRoot();
    await chmod(root, 0o777);
    await expect(aRun()).rejects.toThrow(
      /can be written by others \(mode 777\)/u,
    );
    expect(await readdir(root)).toEqual([]);
  });

  it.each([
    ['0775', 0o775],
    ['0755', 0o755],
  ])(
    'is made 0700 when this user owns it and it is %s, as an older opm left it',
    async (_, mode) => {
      await ownTmpdir();
      const root = defaultJailHomeRoot();
      await chmod(root, mode);
      expect((await aRun()).exitCode).toBe(0);
      expect((await lstat(root)).mode & 0o777).toBe(0o700);
    },
  );

  it('is this user’s own, by its uid, beside any other user’s', () => {
    expect(defaultJailHomeRoot()).toBe(
      join(
        realpathSync.native(tmpdir()),
        `openpacker-sandbox-${process.geteuid?.()}`,
      ),
    );
  });

  it.runIf(process.geteuid?.() === 0)(
    'is not stopped by the root of the same name another user made in the shared temporary directory',
    async () => {
      const dir = await ownTmpdir();
      // As an opm before roots per uid left it, made by someone else.
      const shared = join(dir, 'openpacker-sandbox');
      await mkdir(shared);
      await chown(shared, 65534, 65534);
      const other = join(dir, 'openpacker-sandbox-65534');
      await mkdir(other, { mode: 0o700 });
      await chown(other, 65534, 65534);
      expect((await aRun()).exitCode).toBe(0);
      expect(await readdir(defaultJailHomeRoot())).toEqual([]);
    },
  );

  it('still removes what ended runs left in the shared root an older opm used', async () => {
    const dir = await ownTmpdir();
    const shared = join(dir, 'openpacker-sandbox');
    await mkdir(shared, { mode: 0o700 });
    const dead = join(shared, 'home-left');
    await mkdir(join(dead, 'home'), { recursive: true });
    await writeOwnerFile(dead, {
      ...(await currentOwner()),
      pid: await ended(),
    });
    expect((await aRun()).exitCode).toBe(0);
    expect(present([dead])).toEqual([false]);
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
    const dead = await leftHome('home-dead', {
      ...(await currentOwner()),
      pid: await ended(),
    });
    // Runs that each sweep first, write their home, and hold until told,
    // then read it back: one that holds, and six more beside it, together.
    const go = gates(
      dir,
      Array.from({ length: 7 }, (_, index) => `go-${index}`),
    );
    const start = (index: number) => {
      const { seen, output, until } = heard();
      const run = aRun(
        [
          '/bin/sh',
          '-c',
          `echo ${index} > "$HOME/mark"; echo ${index} > "$TMPDIR/mark"; echo up; ` +
            'read line < "$GO"; cat "$HOME/mark" "$TMPDIR/mark"',
        ],
        { env: { GO: go[index]! }, output, signal: ending() },
      );
      return { seen, run, up: until(() => seen.stdout === 'up\n', run) };
    };
    const holding = start(0);
    await holding.up;
    const runs = [holding, ...[1, 2, 3, 4, 5, 6].map(start)];
    await Promise.all(runs.map(({ up }) => up));
    expect(present([dead])).toEqual([false]);
    expect(await readdir(defaultJailHomeRoot())).toHaveLength(7);
    await Promise.all(go.map((gate) => writeFile(gate, 'go\n')));
    const outcomes = await Promise.all(runs.map(({ run }) => run));
    expect(
      outcomes.map((outcome, index) => [
        outcome.exitCode,
        runs[index]!.seen.stdout,
      ]),
    ).toEqual(
      Array.from({ length: 7 }, (_, index) => [0, `up\n${index}\n${index}\n`]),
    );
    expect(await readdir(defaultJailHomeRoot())).toEqual([]);
  });

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
    const [go] = gates(work, ['go']);
    const { seen, output, until } = heard();
    const run = aRun(
      [
        '/bin/sh',
        '-c',
        'ls -A "$HOME"; cat "$HOME/../.owner" 2>/dev/null || echo hidden; ' +
          'echo up; read line < "$GO"',
      ],
      {
        backend: nativeBackend as SandboxBackend,
        env: { GO: go! },
        readonlyPaths: [work],
        cwd: work,
        output,
        signal: ending(),
      },
    );
    await until(() => seen.stdout.endsWith('up\n'), run);
    const [name] = await readdir(defaultJailHomeRoot());
    const record = JSON.parse(
      await readFile(join(defaultJailHomeRoot(), name!, OWNER_FILE), 'utf8'),
    ) as { owner: ProcessOwner };
    await writeFile(go!, 'go\n');
    expect((await run).exitCode).toBe(0);
    expect(record.owner).toEqual(await currentOwner());
    expect(seen.stdout).toBe('tmp\nhidden\nup\n');
  });
});
