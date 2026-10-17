import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { snapshotProject } from '@openpacker/opm-project';
import { runOpm } from '../src/opm.js';
import { capture } from './run-fixture.js';

/**
 * A command that changes the project first finishes what a killed `opm` left:
 * it puts the project back from the copy and says so in one line on stderr. A
 * copy whose owner may still be running stops it, with exit code 8.
 * The kill itself is exercised in opm-project's rollback-recovery tests; here
 * the copy is made by this process and then handed to one that has exited.
 */

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'opm-recover-cli-'));
  roots.push(root);
  const cap = capture();
  expect(await runOpm(['init', '--name', 'recover'], cap.io, root)).toBe(0);
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

describe('opm sync after a step a killed process left half way', () => {
  it('puts the project back, says so once, and runs', async () => {
    const root = await project();
    const manifest = await readFile(join(root, 'opm.toml'), 'utf8');
    await snapshotProject(root);
    await writeFile(join(root, 'opm.toml'), 'half-written\n');
    const [name] = await copies(root);
    const recordPath = join(root, '.opm', name!, 'rollback.json');
    // SAFETY: the record the library wrote a moment ago.
    const record = JSON.parse(await readFile(recordPath, 'utf8')) as {
      owner: { pid: number; startTime?: string };
    };
    record.owner.pid = await exitedPid();
    await writeFile(recordPath, JSON.stringify(record));

    const cap = capture();
    expect(await runOpm(['sync', '--offline'], cap.io, root), cap.err).toBe(0);
    expect(cap.err.trim().split('\n')).toEqual([
      `opm: put the project back as it was before a step that process ${record.owner.pid} did not finish, and removed ${join('.opm', name!)}`,
    ]);
    expect(await readFile(join(root, 'opm.toml'), 'utf8')).toBe(manifest);
    expect(await copies(root)).toEqual([]);
  });

  it('stops at the copy of a process that may still be running, and keeps it', async () => {
    const root = await project();
    const kept = await snapshotProject(root);
    const cap = capture();
    expect(await runOpm(['sync', '--offline'], cap.io, root), cap.err).toBe(8);
    expect(cap.err).toContain(`belongs to a step of process ${process.pid} on`);
    expect(cap.err).not.toContain('opm: put the project back');
    expect(await copies(root)).toHaveLength(1);
    await kept.discard();
  });
});
