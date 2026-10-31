import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  currentOwner,
  projectStep,
  snapshotProject,
  type ProcessOwner,
} from '@openpacker/opm-project';
import { runOpm } from '../src/opm.js';
import { capture } from './run-fixture.js';

/**
 * `opm recover` finishes what a killed opm left; `opm recover --abandon-step
 * <id>` takes a step this machine cannot see (another container, another
 * host) as dead and puts its project back, and refuses one that is running
 * here. `--wait <ms>` and OPM_STEP_WAIT_MS say how long a command waits for
 * another opm.
 */

const roots: string[] = [];
afterEach(async () => {
  delete process.env.OPM_STEP_WAIT_MS;
  await Promise.all(
    roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function opm(root: string, ...argv: string[]) {
  const cap = capture();
  const code = await runOpm(argv, cap.io, root);
  return { code, out: cap.out, err: cap.err };
}

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'opm-abandon-'));
  roots.push(root);
  expect((await opm(root, 'init', '--name', 'abandon')).code).toBe(0);
  return root;
}

const copies = async (root: string) =>
  (await readdir(join(root, '.opm'))).filter((name) =>
    name.startsWith('.rollback-'),
  );

/** The id of a process that has exited. */
async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise((resolve) => child.on('exit', resolve));
  return child.pid!;
}

/** A lock and a copy left by a step in another PID namespace of this machine. */
async function leftByAnotherNamespace(root: string, owner?: ProcessOwner) {
  const by: ProcessOwner = owner ?? {
    ...(await currentOwner()),
    pid: await exitedPid(),
    pidNamespace: '4026539999',
  };
  await snapshotProject(root);
  const [name] = await copies(root);
  const path = join(root, '.opm', name!, 'rollback.json');
  // SAFETY: the record the library wrote a moment ago.
  const record = JSON.parse(await readFile(path, 'utf8')) as { owner: object };
  Object.assign(record.owner, by);
  await writeFile(path, JSON.stringify(record));
  const lock = randomUUID();
  await writeFile(
    join(root, '.opm', `step-${lock}.lock`),
    `${JSON.stringify({ lockVersion: 1, owner: by })}\n`,
  );
  return { lock, name: name! };
}

describe('opm recover', () => {
  it('has nothing to do in a project no step left anything in', async () => {
    const root = await project();
    const run = await opm(root, 'recover');
    expect(run).toEqual({ code: 0, out: 'Nothing to recover\n', err: '' });
  });

  it('puts back what a dead process left, and says so', async () => {
    const root = await project();
    const manifest = await readFile(join(root, 'opm.toml'), 'utf8');
    await snapshotProject(root);
    const [name] = await copies(root);
    const path = join(root, '.opm', name!, 'rollback.json');
    // SAFETY: the record the library wrote a moment ago.
    const record = JSON.parse(await readFile(path, 'utf8')) as {
      owner: { pid: number };
    };
    record.owner.pid = await exitedPid();
    await writeFile(path, JSON.stringify(record));
    await writeFile(join(root, 'opm.toml'), 'half-written\n');
    const run = await opm(root, 'recover');
    expect(run.code, run.err).toBe(0);
    expect(run.out).toBe('Recovered 1 step\n');
    expect(run.err).toContain('opm: put the project back');
    expect(await readFile(join(root, 'opm.toml'), 'utf8')).toBe(manifest);
  });
});

describe('opm recover --abandon-step', () => {
  it('lets go of a step in another PID namespace: refused first, then recovered', async () => {
    const root = await project();
    const manifest = await readFile(join(root, 'opm.toml'), 'utf8');
    const { lock } = await leftByAnotherNamespace(root);
    await writeFile(join(root, 'opm.toml'), 'half-written\n');

    const stuck = await opm(root, 'sync', '--offline', '--wait', '0');
    expect(stuck.code).toBe(8);
    expect(stuck.err).toContain(`opm recover --abandon-step ${lock}`);

    const refused = await opm(root, 'recover', '--abandon-step', lock);
    expect(refused.code).toBe(8);
    expect(refused.err).toContain('add --force to the same command');
    expect(await copies(root)).toHaveLength(1);

    const run = await opm(root, 'recover', '--abandon-step', lock, '--force');
    expect(run.code, run.err).toBe(0);
    expect(run.out).toContain(
      `Removed .opm/step-${lock}.lock, held by process`,
    );
    expect(run.out).toContain('Took the step of process');
    expect(run.out).toContain('Dealt with 1 copy it left');
    expect(run.err).toContain('opm: put the project back');
    expect(await readFile(join(root, 'opm.toml'), 'utf8')).toBe(manifest);
    expect(await copies(root)).toEqual([]);

    const next = await opm(root, 'sync', '--offline');
    expect(next.code, next.err).toBe(0);
  });

  it('refuses a step that is running here, and changes nothing', async () => {
    const root = await project();
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => (entered = resolve));
    const held = projectStep(root, {}, async () => {
      entered();
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    });
    await inside;
    const [file] = (await readdir(join(root, '.opm'))).filter((name) =>
      name.startsWith('step-'),
    );
    const id = file!.slice('step-'.length, -'.lock'.length);
    const run = await opm(root, 'recover', '--abandon-step', id, '--wait', '0');
    expect(run.code).toBe(8);
    expect(run.err).toContain(`process ${process.pid} on`);
    expect(run.err).toContain('will not call a running step dead');
    await held;
  });

  it.each([
    [['recover', '--abandon-step'], 3],
    [['recover', '--abandon-step', 'nope'], 3],
    [['recover', 'extra'], 3],
  ])('%j is refused with exit code %i', async (argv, code) => {
    const root = await project();
    expect((await opm(root, ...argv)).code).toBe(code);
  });

  it('says when no step has that id', async () => {
    const root = await project();
    const run = await opm(root, 'recover', '--abandon-step', randomUUID());
    expect(run.code).toBe(4);
  });
});

describe('how long a command waits for another opm', () => {
  /** A step held by this process for `ms`, or until `until` settles. */
  async function holding(root: string, until: number | Promise<void>) {
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => (entered = resolve));
    const held = projectStep(root, {}, async () => {
      entered();
      await (typeof until === 'number'
        ? new Promise((resolve) => setTimeout(resolve, until))
        : until);
    });
    await inside;
    // In an object: a promise returned from here would be waited for.
    return { held };
  }

  it('--wait 0 gives up at once', async () => {
    const root = await project();
    // The step is held until the run has ended, so no clock decides the
    // outcome. A run that waits says so as it starts to: the step is let go
    // there, so a run that did not take --wait 0 gets it and succeeds (code
    // 0) instead of waiting out the 10 s default.
    delete process.env.OPM_STEP_WAIT_MS;
    let letGo!: () => void;
    const { held } = await holding(
      root,
      new Promise<void>((resolve) => (letGo = resolve)),
    );
    const cap = capture();
    const io = {
      stdout: cap.io.stdout,
      stderr: {
        write: (text: string) => {
          cap.io.stderr.write(text);
          if (cap.err.includes('opm: waiting for')) letGo();
          return true;
        },
      },
    };
    try {
      const code = await runOpm(['sync', '--offline', '--wait', '0'], io, root);
      expect(cap.err).not.toContain('opm: waiting for');
      expect(code).toBe(8);
    } finally {
      letGo();
      await held;
    }
  });

  it('--wait and OPM_STEP_WAIT_MS wait for a step that finishes in time', async () => {
    const root = await project();
    const { held } = await holding(root, 600);
    process.env.OPM_STEP_WAIT_MS = '5000';
    const run = await opm(root, 'sync', '--offline');
    expect(run.code, run.err).toBe(0);
    expect(run.err).toContain('opm: waiting for process');
    await held;
  });

  it.each([
    [['sync', '--offline', '--wait', 'soon']],
    [['sync', '--offline', '--wait', '-5']],
    [['sync', '--offline', '--wait']],
    [['sync', '--offline', '--wait', '9999999']],
  ])('%j is refused, naming the flag', async (argv) => {
    const root = await project();
    const run = await opm(root, ...argv);
    expect(run.code).toBe(3);
    expect(run.err).toContain('--wait');
  });

  it('OPM_STEP_WAIT_MS that is not a number is refused, naming it', async () => {
    const root = await project();
    process.env.OPM_STEP_WAIT_MS = 'soon';
    const run = await opm(root, 'sync', '--offline');
    expect(run.code).toBe(3);
    expect(run.err).toContain('OPM_STEP_WAIT_MS');
  });
});
