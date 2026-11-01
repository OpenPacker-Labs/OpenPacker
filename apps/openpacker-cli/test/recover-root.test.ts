import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runOpm } from '../src/opm.js';
import { capture } from './run-fixture.js';

/**
 * A command recovers the project it works on and no other: `opm ci --path
 * <dir>` never walks up to a parent that holds an opm.toml (a world-writable
 * /tmp, a checkout inside someone else's project). And a record that names
 * paths of its own is refused, with nothing outside the project touched.
 */

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function opm(cwd: string, ...argv: string[]) {
  const cap = capture();
  const code = await runOpm(argv, cap.io, cwd);
  return { code, out: cap.out, err: cap.err };
}

const PACKAGE = '{"name":"x","version":"1.0.0"}\n';
const LOCK =
  '{"name":"x","version":"1.0.0","lockfileVersion":3,"requires":true,"packages":{"":{"name":"x","version":"1.0.0"}}}\n';

/** An opm project in `dir/project` holding review 182 r2's planted record. */
async function planted(): Promise<{
  dir: string;
  root: string;
  holder: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'opm-recover-root-'));
  temps.push(dir);
  const root = join(dir, 'project');
  await mkdir(join(dir, 'victim-dir'));
  await writeFile(join(dir, 'victim-dir', 'keep.txt'), 'outside\n');
  await mkdir(root);
  expect((await opm(root, 'init', '--name', 'planted')).code).toBe(0);
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise((resolve) => child.on('exit', resolve));
  const holder = join(root, '.opm', `.rollback-${child.pid}-crafted`);
  await mkdir(join(holder, 'files'), { recursive: true });
  await writeFile(join(holder, 'files', '0'), 'written by a crafted record\n');
  await writeFile(
    join(holder, 'rollback.json'),
    JSON.stringify({
      rollbackVersion: 1,
      state: 'ready',
      owner: { pid: child.pid, host: hostname() },
      files: [{ path: '../outside-written.txt', present: true }],
      trees: [{ path: '../victim-dir', present: false }],
    }),
  );
  return { dir, root, holder };
}

async function untouched(dir: string, holder: string): Promise<void> {
  expect(await readFile(join(dir, 'victim-dir', 'keep.txt'), 'utf8')).toBe(
    'outside\n',
  );
  expect(existsSync(join(dir, 'outside-written.txt'))).toBe(false);
  expect(existsSync(join(holder, 'rollback.json'))).toBe(true);
}

describe('opm ci', () => {
  it('in a checkout below a planted project leaves the parent alone', async () => {
    const { dir, root, holder } = await planted();
    const below = join(root, 'some-checkout');
    await mkdir(below);
    await writeFile(join(below, 'package.json'), PACKAGE);
    await writeFile(join(below, 'package-lock.json'), LOCK);
    const run = await opm(dir, 'ci', '--offline', '--path', below);
    expect(run.code, run.err).toBe(0);
    expect(run.err).not.toContain('put the project back');
    await untouched(dir, holder);
    expect(existsSync(join(below, '.opm'))).toBe(false);
  });

  it('in a planted project refuses its record and touches nothing outside', async () => {
    const { dir, root, holder } = await planted();
    await writeFile(join(root, 'package.json'), PACKAGE);
    await writeFile(join(root, 'package-lock.json'), LOCK);
    const run = await opm(dir, 'ci', '--offline', '--path', root);
    expect(run.code).toBe(3);
    expect(run.err).toContain('is not a record this opm writes');
    await untouched(dir, holder);
  });
});
