import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { configureDefaultAdapters } from '@openpacker/adapters-default';
import { addPackage, recoverInterruptedSteps } from '../src/index.js';
import { snapshotProject } from '../src/project-rollback.js';
import {
  copies,
  deadCopy,
  editRecord,
  exitedPid,
  project,
  snapshot,
  temporary,
  transport,
} from './rollback-support.js';

configureDefaultAdapters();

/**
 * The copy keeps a link as a link and never reads what it points at; a file
 * keeps its mode; and putting the project back checks everything before it
 * writes anything: the kept bytes against the record's digest, a kept entry
 * that is a link or has other names, a kept tree that is not a directory.
 */

const SECRET = 'API_TOKEN=dummy_marker_0123456789abcdef\n';

/** A project, and a directory `dir` of files that are not its own. */
async function beside(): Promise<{ dir: string; root: string }> {
  const dir = temporary(await mkdtemp(join(tmpdir(), 'opm-links-')));
  const root = await project(['base']);
  await writeFile(join(dir, 'secret.txt'), SECRET);
  return { dir, root };
}

/** A file where the layout needs node_modules/.bin to be a directory. */
async function blockBin(root: string) {
  await rm(join(root, 'node_modules', '.bin'), {
    recursive: true,
    force: true,
  });
  await writeFile(join(root, 'node_modules', '.bin'), 'not a directory\n');
}

describe('a step that fails in a project whose files are links', () => {
  it('puts a package.json that is a link back as that link, never as a copy of what it points at', async () => {
    const { dir, root } = await beside();
    const outside = join(dir, 'outside-package.json');
    await writeFile(
      outside,
      '{"name":"x","token":"dummy_marker_0123456789abcdef"}\n',
    );
    await rm(join(root, 'package.json'), { force: true });
    await symlink(outside, join(root, 'package.json'));
    await blockBin(root);
    const before = await snapshot(root);
    await expect(
      addPackage({
        root,
        spec: 'pkg:npm/tool@1.0.0',
        registryOptions: transport(),
      }),
    ).rejects.toThrow(/ENOTDIR/u);
    expect((await lstat(join(root, 'package.json'))).isSymbolicLink()).toBe(
      true,
    );
    expect(await readlink(join(root, 'package.json'))).toBe(outside);
    expect(await readFile(outside, 'utf8')).toContain(
      'dummy_marker_0123456789abcdef',
    );
    expect(await snapshot(root)).toEqual(before);
  });

  it('puts an opm.toml that is a link back as that link', async () => {
    const { dir, root } = await beside();
    await writeFile(
      join(dir, 'real-opm.toml'),
      await readFile(join(root, 'opm.toml')),
    );
    const snap = await (async () => {
      await rm(join(root, 'opm.toml'));
      await symlink(join(dir, 'real-opm.toml'), join(root, 'opm.toml'));
      return snapshotProject(root);
    })();
    await rm(join(root, 'opm.toml'));
    await writeFile(join(root, 'opm.toml'), 'half-written\n');
    await snap.restore();
    expect(await readlink(join(root, 'opm.toml'))).toBe(
      join(dir, 'real-opm.toml'),
    );
    expect(await readFile(join(dir, 'real-opm.toml'), 'utf8')).toContain(
      '[project]',
    );
  });

  it('puts a node_modules that is a link back as that link, and keeps what is behind it out of it', async () => {
    const { dir, root } = await beside();
    await rename(join(root, 'node_modules'), join(dir, 'shared-modules'));
    await symlink(join(dir, 'shared-modules'), join(root, 'node_modules'));
    const snap = await snapshotProject(root);
    await rm(join(root, 'node_modules'));
    await mkdir(join(root, 'node_modules'));
    await writeFile(join(root, 'node_modules', 'stray.js'), 'half\n');
    await snap.restore();
    expect(await readlink(join(root, 'node_modules'))).toBe(
      join(dir, 'shared-modules'),
    );
    expect((await lstat(join(root, 'node_modules'))).isSymbolicLink()).toBe(
      true,
    );
  });
});

describe('a file keeps its mode', () => {
  it('exactly, whatever it is written as meanwhile', async () => {
    const root = await project(['base']);
    await writeFile(join(root, 'package.json'), '{"name":"x"}\n', {
      mode: 0o750,
    });
    const snap = await snapshotProject(root);
    await rm(join(root, 'package.json'));
    await writeFile(join(root, 'package.json'), 'half\n', { mode: 0o600 });
    await snap.restore();
    expect((await stat(join(root, 'package.json'))).mode & 0o7777).toBe(0o750);
    expect(await readFile(join(root, 'package.json'), 'utf8')).toBe(
      '{"name":"x"}\n',
    );
  });
});

describe('a copy planted with links', () => {
  /** A dead copy of the project, and its kept file 0 and kept tree 0. */
  async function planted() {
    const { dir, root } = await beside();
    const name = await deadCopy(root);
    const holder = join(root, '.opm', name);
    return { dir, root, name, holder };
  }

  it('is refused when a kept file is a link out of the project, and nothing is written', async () => {
    const { dir, root, holder } = await planted();
    await writeFile(join(root, 'opm.toml'), 'half-written\n');
    await rm(join(holder, 'files', '0'));
    await symlink(join(dir, 'secret.txt'), join(holder, 'files', '0'));
    await expect(recoverInterruptedSteps(root)).rejects.toMatchObject({
      code: 'UNSAFE_PATH',
    });
    expect(await readFile(join(root, 'opm.toml'), 'utf8')).toBe(
      'half-written\n',
    );
    expect(await readFile(join(dir, 'secret.txt'), 'utf8')).toBe(SECRET);
    expect(await copies(root)).toHaveLength(1);
  });

  it('is refused when a kept tree is a link out of the project, and nothing is written', async () => {
    const { dir, root, holder } = await planted();
    await mkdir(join(dir, 'outside-tree'));
    await writeFile(join(root, 'opm.toml'), 'half-written\n');
    await rm(join(holder, 'trees', '0'), { recursive: true });
    await symlink(join(dir, 'outside-tree'), join(holder, 'trees', '0'));
    await expect(recoverInterruptedSteps(root)).rejects.toMatchObject({
      code: 'UNSAFE_PATH',
    });
    expect((await lstat(join(root, 'node_modules'))).isSymbolicLink()).toBe(
      false,
    );
    expect(await readFile(join(root, 'opm.toml'), 'utf8')).toBe(
      'half-written\n',
    );
  });

  it('is refused when a kept file has another name, though its bytes are the right ones', async () => {
    const { dir, root, holder } = await planted();
    const bytes = await readFile(join(holder, 'files', '0'));
    await writeFile(join(dir, 'twin.txt'), bytes);
    await rm(join(holder, 'files', '0'));
    await link(join(dir, 'twin.txt'), join(holder, 'files', '0'));
    await writeFile(join(root, 'opm.toml'), 'half-written\n');
    await expect(recoverInterruptedSteps(root)).rejects.toMatchObject({
      code: 'UNSAFE_PATH',
      message: expect.stringContaining('2 names'),
    });
    expect(await readFile(join(root, 'opm.toml'), 'utf8')).toBe(
      'half-written\n',
    );
  });

  it('is refused when a kept file is not the file the record says, and nothing is written', async () => {
    const { root, holder } = await planted();
    await writeFile(join(root, 'opm.toml'), 'half-written\n');
    await writeFile(join(root, 'node_modules', 'stray.js'), 'half\n');
    await writeFile(join(holder, 'files', '0'), '[project]\nname = "forged"\n');
    await expect(recoverInterruptedSteps(root)).rejects.toMatchObject({
      code: 'ROLLBACK_CONFLICT',
    });
    expect(await readFile(join(root, 'opm.toml'), 'utf8')).toBe(
      'half-written\n',
    );
    // Trees are planned before any is moved: the live node_modules is as it was.
    expect(await readFile(join(root, 'node_modules', 'stray.js'), 'utf8')).toBe(
      'half\n',
    );
    expect(await copies(root)).toHaveLength(1);
  });

  it('is refused when a kept file is missing from it', async () => {
    const { root, holder } = await planted();
    await rm(join(holder, 'files', '0'));
    await expect(recoverInterruptedSteps(root)).rejects.toMatchObject({
      code: 'ROLLBACK_CONFLICT',
    });
  });

  it('is refused when a project file has become a directory', async () => {
    const { root } = await planted();
    await rm(join(root, 'opm.toml'));
    await mkdir(join(root, 'opm.toml'));
    await expect(recoverInterruptedSteps(root)).rejects.toMatchObject({
      code: 'ROLLBACK_CONFLICT',
    });
  });

  it('carries a link row only with the digest of its target', async () => {
    const { root, name } = await planted();
    await editRecord(root, name, (record) => {
      record.files[2] = { before: record.files[2], link: '/etc/passwd' };
    });
    await expect(recoverInterruptedSteps(root)).rejects.toMatchObject({
      code: 'INVALID_ROLLBACK',
    });
  });
});

describe('a file put back where it has other names', () => {
  it('replaces the name and leaves the other file as it is', async () => {
    const { dir, root } = await beside();
    const kept = await readFile(join(root, 'opm.toml'), 'utf8');
    await deadCopy(root);
    await rm(join(root, 'opm.toml'));
    await writeFile(join(dir, 'outside.txt'), 'outside the project\n');
    await link(join(dir, 'outside.txt'), join(root, 'opm.toml'));
    expect(await recoverInterruptedSteps(root)).toEqual([
      expect.objectContaining({ restored: true }),
    ]);
    expect(await readFile(join(dir, 'outside.txt'), 'utf8')).toBe(
      'outside the project\n',
    );
    expect((await stat(join(root, 'opm.toml'))).nlink).toBe(1);
    expect(await readFile(join(root, 'opm.toml'), 'utf8')).toBe(kept);
  });
});

describe('a link in a copy of this opm', () => {
  it('is a row of its own: the target, and the digest of the target', async () => {
    const { dir, root } = await beside();
    await rm(join(root, 'package.json'), { force: true });
    await symlink(join(dir, 'secret.txt'), join(root, 'package.json'));
    await snapshotProject(root);
    const [name] = await copies(root);
    const record = JSON.parse(
      await readFile(join(root, '.opm', name!, 'rollback.json'), 'utf8'),
    );
    expect(record.files[2]).toEqual({
      before: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      link: join(dir, 'secret.txt'),
    });
    // And the pid of nobody, so the project's own tests clean up after it.
    await exitedPid();
  });
});
