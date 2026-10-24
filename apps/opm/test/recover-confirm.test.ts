import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  cp,
  mkdtemp,
  readFile,
  readdir,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  currentOwner,
  snapshotProject,
  type ProcessOwner,
} from '@openpacker/opm-project';
import { runOpm } from '../src/opm.js';
import { capture } from './run-fixture.js';

/**
 * `opm recover --abandon-step` asks for `--force` when it cannot tell that a
 * step is dead, and says what that costs (X5); lets go of a lock it cannot
 * read, saying so (X2); removes a copy made in another project and nothing
 * else (X3); and `opm recover` takes the options it has, `--path` among them,
 * and refuses the rest (N5). A wait that makes no sense matters to the
 * commands that wait, not to `opm list`.
 */

const roots: string[] = [];
afterEach(async () => {
  delete process.env.OPM_STEP_WAIT_MS;
  await Promise.all(
    roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function opm(cwd: string, ...argv: string[]) {
  const cap = capture();
  const code = await runOpm(argv, cap.io, cwd);
  return { code, out: cap.out, err: cap.err };
}

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'opm-confirm-'));
  roots.push(root);
  expect((await opm(root, 'init', '--name', 'confirm')).code).toBe(0);
  return root;
}

const copies = async (root: string) =>
  (await readdir(join(root, '.opm'))).filter((name) =>
    name.startsWith('.rollback-'),
  );

async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise((resolve) => child.on('exit', resolve));
  return child.pid!;
}

/** A lock and a copy left by a step in another PID namespace of this machine. */
async function left(root: string) {
  const by: ProcessOwner = {
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

describe('opm recover --abandon-step of a step opm cannot see', () => {
  it('says what it costs and does nothing without --force; help says so too', async () => {
    const root = await project();
    const manifest = await readFile(join(root, 'opm.toml'), 'utf8');
    const { lock } = await left(root);
    await writeFile(join(root, 'opm.toml'), 'half-written\n');
    const run = await opm(root, 'recover', '--abandon-step', lock);
    expect(run.code).toBe(8);
    expect(run.err).toMatch(/is still running/u);
    expect(run.err).toMatch(
      /keeps writing this project with its lock gone and its work undone/u,
    );
    expect(run.err).toContain('add --force to the same command');
    expect(run.err).not.toMatch(/--abandon-step \S+ --force/u);
    expect(await readFile(join(root, 'opm.toml'), 'utf8')).toBe(
      'half-written\n',
    );
    expect(await copies(root)).toHaveLength(1);

    const forced = await opm(
      root,
      'recover',
      '--abandon-step',
      lock,
      '--force',
    );
    expect(forced.code, forced.err).toBe(0);
    expect(await readFile(join(root, 'opm.toml'), 'utf8')).toBe(manifest);

    const help = await opm(root, '--help');
    expect(help.out).toMatch(/opm recover --abandon-step <id> \[--force\]/u);
    expect(help.out).toMatch(
      /goes on\s+writing the project with its lock gone and\s+its work undone/u,
    );
  });

  it('--force alone, or with a value, is refused', async () => {
    const root = await project();
    expect((await opm(root, 'recover', '--force')).code).toBe(3);
    expect(
      (
        await opm(
          root,
          'recover',
          '--abandon-step',
          randomUUID(),
          '--force=yes',
        )
      ).code,
    ).toBe(3);
  });
});

describe('opm recover --abandon-step of a lock opm cannot read', () => {
  it('names the lock, refuses without --force, and removes only that file with it', async () => {
    const root = await project();
    const id = randomUUID();
    const path = join(root, '.opm', `step-${id}.lock`);
    await writeFile(path, '{"lockVersion":2,"owner":{}}');
    const old = new Date(Date.now() - 3_600_000);
    await utimes(path, old, old);
    const stuck = await opm(root, 'sync', '--offline', '--wait', '0');
    expect(stuck.code).toBe(8);
    expect(stuck.err).toContain(`opm recover --abandon-step ${id}`);
    const refused = await opm(root, 'recover', '--abandon-step', id);
    expect(refused.code).toBe(8);
    expect(refused.err).toContain('does not say who holds it');
    expect(refused.err).not.toContain('run this again');
    const run = await opm(root, 'recover', '--abandon-step', id, '--force');
    expect(run.code, run.err).toBe(0);
    expect(run.out).toContain(
      `Removed .opm/step-${id}.lock, which does not say who held it`,
    );
    expect(run.out).not.toContain('Took the step of');
    expect((await opm(root, 'sync', '--offline')).code).toBe(0);
  });
});

describe('opm recover with a copy made in another project', () => {
  it('refuses to put it back, and --abandon-step removes only the copy', async () => {
    const root = await project();
    await left(root);
    const other = temp(`${root}-other`);
    await cp(root, other, { recursive: true, verbatimSymlinks: true });
    await rm(
      join(
        other,
        '.opm',
        (await readdir(join(other, '.opm'))).find((n) =>
          n.startsWith('step-'),
        )!,
      ),
    );
    await writeFile(join(other, 'opm.toml'), 'the other one\n');
    const [name] = await copies(other);
    const id = name!.split('-').slice(2).join('-');
    const refused = await opm(other, 'recover');
    expect(refused.code).toBe(3);
    expect(refused.err).toMatch(/was made in another project/u);
    expect(refused.err).toContain(`opm recover --abandon-step ${id}`);
    expect(await readFile(join(other, 'opm.toml'), 'utf8')).toBe(
      'the other one\n',
    );
    const run = await opm(other, 'recover', '--abandon-step', id);
    expect(run.code, run.err).toBe(0);
    expect(run.out).toMatch(
      /^Removed \.opm\/\.rollback-.*, made for the project at .*; this project was not changed$/mu,
    );
    expect(await readFile(join(other, 'opm.toml'), 'utf8')).toBe(
      'the other one\n',
    );
    expect(await copies(other)).toEqual([]);
  });
});

function temp(path: string): string {
  roots.push(path);
  return path;
}

describe('opm recover and its options (N5)', () => {
  it('works on the project --path names', async () => {
    const root = await project();
    const elsewhere = await mkdtemp(join(tmpdir(), 'opm-confirm-cwd-'));
    roots.push(elsewhere);
    const run = await opm(elsewhere, 'recover', '--path', root);
    expect(run).toEqual({ code: 0, out: 'Nothing to recover\n', err: '' });
  });

  it('does not recover the project it is run in when --path names another', async () => {
    const here = await project();
    const there = await project();
    await snapshotProject(here);
    const [name] = await copies(here);
    const path = join(here, '.opm', name!, 'rollback.json');
    // SAFETY: the record the library wrote a moment ago.
    const record = JSON.parse(await readFile(path, 'utf8')) as {
      owner: { pid: number };
    };
    record.owner.pid = await exitedPid();
    await writeFile(path, JSON.stringify(record));
    const run = await opm(here, 'recover', '--path', there);
    expect(run.out).toBe('Nothing to recover\n');
    expect(await copies(here)).toHaveLength(1);
  });

  it.each([['--nope'], ['--offline'], ['--ecosystem', 'npm']])(
    'refuses the option %s instead of ignoring it',
    async (...argv) => {
      const root = await project();
      const run = await opm(root, 'recover', ...argv);
      expect(run.code).toBe(3);
      expect(run.err).toMatch(/opm recover has no option --/u);
    },
  );

  it('--path with nothing after it is refused', async () => {
    const root = await project();
    expect((await opm(root, 'recover', '--path')).code).toBe(3);
  });
});

describe('a wait that makes no sense (N5)', () => {
  it('does not matter to a command that never waits', async () => {
    const root = await project();
    process.env.OPM_STEP_WAIT_MS = 'abc';
    const list = await opm(root, 'list');
    expect(list.code, list.err).toBe(0);
    expect((await opm(root, 'list', '--wait', 'soon')).code).toBe(0);
  });

  it('matters to the commands that wait, and to opm recover', async () => {
    const root = await project();
    process.env.OPM_STEP_WAIT_MS = 'abc';
    for (const argv of [['sync', '--offline'], ['recover']]) {
      const run = await opm(root, ...argv);
      expect(run.code).toBe(3);
      expect(run.err).toContain('OPM_STEP_WAIT_MS');
    }
  });
});
