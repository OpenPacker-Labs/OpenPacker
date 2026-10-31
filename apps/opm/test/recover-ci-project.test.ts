import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { currentOwner } from '@openpacker/opm-project';
import { runOpm } from '../src/opm.js';
import { capture } from './run-fixture.js';

/**
 * `opm ci` works in an npm or pnpm project, which has no opm.toml, and keeps
 * its step lock in that project's `.opm`. When it is killed (Ctrl-C, a
 * container stopped), `opm recover --path <project>` is how the operator puts
 * that project right: it has to find the project by its `.opm`, as `opm ci`
 * did, not refuse it for want of an opm.toml.
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

/** The id of a process that has exited. */
async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise((resolve) => child.on('exit', resolve));
  return child.pid!;
}

/** An npm project in which a killed `opm ci` left its step lock. */
async function killedCi(): Promise<{
  dir: string;
  root: string;
  lock: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'opm-recover-ci-'));
  temps.push(dir);
  const root = join(dir, 'app');
  await mkdir(join(root, '.opm'), { recursive: true });
  await writeFile(
    join(root, 'package.json'),
    '{"name":"app","version":"1.0.0"}\n',
  );
  const lock = 'step-00000000-0000-4000-8000-000000000000.lock';
  await writeFile(
    join(root, '.opm', lock),
    `${JSON.stringify({
      lockVersion: 1,
      owner: { ...(await currentOwner()), pid: await exitedPid() },
    })}\n`,
  );
  return { dir, root, lock };
}

describe('opm recover in a project opm ci installs', () => {
  it('takes the project by --path and removes the lock a killed opm ci left', async () => {
    const { dir, root, lock } = await killedCi();
    const run = await opm(dir, 'recover', '--path', root);
    expect(run.code, run.err).toBe(0);
    expect(await readdir(join(root, '.opm')).catch(() => [])).not.toContain(
      lock,
    );
  });

  it('takes the project it is run in', async () => {
    const { root, lock } = await killedCi();
    const run = await opm(root, 'recover');
    expect(run.code, run.err).toBe(0);
    expect(await readdir(join(root, '.opm')).catch(() => [])).not.toContain(
      lock,
    );
  });

  it('still says there is no project where opm has never run', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'opm-recover-none-'));
    temps.push(dir);
    const run = await opm(dir, 'recover');
    expect(run.code).not.toBe(0);
    expect(run.err).toMatch(/No opm\.toml found/u);
  });
});
