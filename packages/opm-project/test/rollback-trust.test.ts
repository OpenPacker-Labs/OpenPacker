import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  chown,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { configureDefaultAdapters } from '@openpacker/adapters-default';
import {
  currentProcessOwner,
  recoverInterruptedSteps,
  syncProject,
} from '../src/index.js';
import {
  child,
  copies,
  deadCopy,
  editRecord,
  exitedPid,
  kill,
  project,
  snapshot,
  sources,
  temporary,
  transport,
  until,
} from './rollback-support.js';

configureDefaultAdapters();

/**
 * A copy is read back from the project directory, which may have come from
 * anywhere. Recovery rebuilds every path from its own tables, acts only on a
 * directory of this user directly under the project's own `.opm`, and stops,
 * with nothing changed, at anything else: a record it cannot read, one that
 * names paths, a holder that is a link, an owner it cannot judge.
 */

/** A project inside `dir`, beside a directory and a file outside it. */
async function beside(): Promise<{ dir: string; root: string }> {
  const dir = temporary(await mkdtemp(join(tmpdir(), 'opm-trust-')));
  const root = await project([]);
  await rename(root, join(dir, 'project'));
  await mkdir(join(dir, 'victim-dir'));
  await writeFile(join(dir, 'victim-dir', 'keep.txt'), 'outside the project\n');
  return { dir, root: join(dir, 'project') };
}

async function outsideUntouched(dir: string): Promise<void> {
  expect(await readFile(join(dir, 'victim-dir', 'keep.txt'), 'utf8')).toBe(
    'outside the project\n',
  );
  expect(existsSync(join(dir, 'outside-written.txt'))).toBe(false);
}

describe('a planted record that names paths outside the project', () => {
  /** The record review 182 r2 planted: a dead owner on this host, and paths. */
  async function plant(root: string): Promise<string> {
    const pid = await exitedPid();
    const holder = join(root, '.opm', `.rollback-${pid}-crafted`);
    await mkdir(join(holder, 'files'), { recursive: true });
    await writeFile(
      join(holder, 'files', '0'),
      'written by a crafted rollback.json\n',
    );
    await writeFile(
      join(holder, 'rollback.json'),
      JSON.stringify({
        rollbackVersion: 1,
        state: 'ready',
        owner: { pid, host: hostname() },
        files: [{ path: '../outside-written.txt', present: true }],
        trees: [{ path: '../victim-dir', present: false }],
      }),
    );
    return holder;
  }

  it('is refused by recovery, and nothing outside is touched', async () => {
    const { dir, root } = await beside();
    await plant(root);
    const before = await snapshot(root);
    await expect(recoverInterruptedSteps(root)).rejects.toMatchObject({
      code: 'INVALID_ROLLBACK',
    });
    await outsideUntouched(dir);
    expect(await snapshot(root)).toEqual(before);
    expect(await copies(root)).toHaveLength(1);
  });

  it('is refused by a step that changes the project', async () => {
    const { dir, root } = await beside();
    await plant(root);
    await expect(
      syncProject({ root, registryOptions: transport() }),
    ).rejects.toMatchObject({ code: 'INVALID_ROLLBACK' });
    await outsideUntouched(dir);
  });
});

describe('a copy that is not a directory of this project', () => {
  it('is refused when it is a link out of the project', async () => {
    const { dir, root } = await beside();
    const name = await deadCopy(root);
    // The whole copy moved out of the project, and a link left in its place.
    await rename(join(root, '.opm', name), join(dir, 'moved'));
    await symlink(join(dir, 'moved'), join(root, '.opm', name));
    await expect(recoverInterruptedSteps(root)).rejects.toMatchObject({
      code: 'UNSAFE_PATH',
    });
    expect(existsSync(join(dir, 'moved', 'rollback.json'))).toBe(true);
    await outsideUntouched(dir);
  });

  it('is refused when .opm itself is a link out of the project', async () => {
    const { dir, root } = await beside();
    await deadCopy(root);
    await rename(join(root, '.opm'), join(dir, 'elsewhere'));
    await symlink(join(dir, 'elsewhere'), join(root, '.opm'));
    await expect(recoverInterruptedSteps(root)).rejects.toMatchObject({
      code: 'UNSAFE_PATH',
    });
    expect(await copies(root)).toHaveLength(1);
    await outsideUntouched(dir);
  });

  it.runIf(process.getuid?.() === 0)(
    'is refused when it belongs to another user (run as root here)',
    async () => {
      const root = await project([]);
      const name = await deadCopy(root);
      await chown(join(root, '.opm', name), 65534, 65534);
      await expect(recoverInterruptedSteps(root)).rejects.toMatchObject({
        code: 'UNSAFE_PATH',
        message: expect.stringContaining('belongs to user 65534'),
      });
      expect(await copies(root)).toEqual([name]);
    },
  );
});

describe('a file put back where a link now is', () => {
  it('replaces the link, and never writes through it', async () => {
    const { dir, root } = await beside();
    const kept = await readFile(join(root, 'opm.toml'), 'utf8');
    await deadCopy(root);
    await writeFile(join(dir, 'outside.txt'), 'outside the project\n');
    await rm(join(root, 'opm.toml'));
    await symlink(join(dir, 'outside.txt'), join(root, 'opm.toml'));
    expect(await recoverInterruptedSteps(root)).toEqual([
      expect.objectContaining({ restored: true }),
    ]);
    expect(await readFile(join(dir, 'outside.txt'), 'utf8')).toBe(
      'outside the project\n',
    );
    expect((await lstat(join(root, 'opm.toml'))).isSymbolicLink()).toBe(false);
    expect(await readFile(join(root, 'opm.toml'), 'utf8')).toBe(kept);
  });
});

describe('a record that cannot be read', () => {
  it('stops the step and keeps the copy, whatever the error', async () => {
    const root = await project(['base']);
    const name = await deadCopy(root);
    await writeFile(join(root, 'opm.toml'), 'half-written\n');
    // Not ENOENT: a directory where the record belongs.
    await rm(join(root, '.opm', name, 'rollback.json'));
    await mkdir(join(root, '.opm', name, 'rollback.json'));
    await expect(recoverInterruptedSteps(root)).rejects.toMatchObject({
      code: 'INVALID_ROLLBACK',
      message: expect.stringContaining('the copy is kept'),
    });
    expect(await copies(root)).toEqual([name]);
    expect(await readFile(join(root, 'opm.toml'), 'utf8')).toBe(
      'half-written\n',
    );
  });

  it('stops the step and keeps the copy when it is another version', async () => {
    const root = await project([]);
    const name = await deadCopy(root);
    await editRecord(root, name, (record) => {
      Object.assign(record, { rollbackVersion: 2 });
    });
    await expect(recoverInterruptedSteps(root)).rejects.toMatchObject({
      code: 'INVALID_ROLLBACK',
    });
    expect(await copies(root)).toEqual([name]);
  });
});

const linux = process.platform === 'linux';
const unshare =
  linux &&
  spawnSync('unshare', ['--pid', '--fork', '--mount-proc', 'true']).status ===
    0;
if (!unshare)
  console.warn(
    'rollback-trust.test.ts: `unshare --pid --fork --mount-proc` is refused here (it needs root or user namespaces); the PID-namespace case is skipped',
  );

describe.runIf(unshare)('a live step in another PID namespace', () => {
  it('keeps its copy: recovery from here stops, and nothing is put back', async () => {
    const root = await project(['base']);
    const ready = `${root}.ready`;
    temporary(ready);
    const step = await child(
      root,
      `const { snapshotProject } = await import(${JSON.stringify(sources.rollback)});
       await snapshotProject(root);
       await writeFile(join(root, 'opm.toml'), 'half-written\\n');
       await writeFile(${JSON.stringify(ready)}, '');
       setInterval(() => {}, 1000);`,
      ['unshare', '--pid', '--fork', '--kill-child', '--mount-proc'],
    );
    try {
      await until(ready);
      const [name] = await copies(root);
      // SAFETY: the record the child's snapshotProject wrote.
      const owner = JSON.parse(
        await readFile(join(root, '.opm', name!, 'rollback.json'), 'utf8'),
      ).owner as { pid: number; host: string; pidNamespace?: string };
      expect(owner.pid).toBe(1);
      expect(owner.host).toBe(hostname());
      expect(owner.pidNamespace).not.toBe(
        (await currentProcessOwner()).pidNamespace,
      );
      await expect(recoverInterruptedSteps(root)).rejects.toMatchObject({
        code: 'PROJECT_BUSY',
      });
      expect(step.exitCode).toBeNull();
      expect(await copies(root)).toEqual([name]);
      expect(await readFile(join(root, 'opm.toml'), 'utf8')).toBe(
        'half-written\n',
      );
    } finally {
      await kill(step);
    }
  }, 60_000);
});
