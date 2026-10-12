import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunError } from '../src/commands/run-error.js';
import { readMemberPackage } from '../src/commands/run-member-files.js';
import { go, makeWorkspace } from './workspace-fixture.js';

// A link that appears between discovery and the read of a member's package.json
// can only be simulated by making the reader say so; the real reader's refusals
// are held by run-member-files.test.ts.
vi.mock('../src/commands/run-member-files.js', async (original) => {
  const real =
    await original<typeof import('../src/commands/run-member-files.js')>();
  return { ...real, readMemberPackage: vi.fn(real.readMemberPackage) };
});

const posix = describe.skipIf(process.platform === 'win32');

const temps: string[] = [];
afterEach(async () => {
  vi.mocked(readMemberPackage).mockReset();
  await Promise.all(
    temps.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});

async function outside(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'opm-outside-')));
  temps.push(dir);
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'evil', version: '9.9.9' }),
  );
  return dir;
}

posix('opm exec across members and links', () => {
  it('refuses a symbolic link as a member directory, and runs no bin', async () => {
    const ws = await makeWorkspace({ 'packages/ok': { name: 'ok' } });
    await symlink(await outside(), join(ws.root, 'packages', 'evil'));
    const ran = await go('exec', ['-r', 'fake-tool', 'x'], ws.root);
    expect(ran.status).toBe(3);
    expect(ran.err).toContain('packages/evil');
    expect(ran.err).toMatch(/symbolic link/u);
    expect(ran.out).toBe('');
  });

  it('refuses a symbolic link as a member package.json, and runs no bin', async () => {
    const ws = await makeWorkspace({ 'packages/ok': { name: 'ok' } });
    const target = await outside();
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(ws.root, 'packages', 'evil'));
    await symlink(
      join(target, 'package.json'),
      join(ws.root, 'packages', 'evil', 'package.json'),
    );
    const ran = await go('exec', ['-r', 'fake-tool', 'x'], ws.root);
    expect(ran.status).toBe(3);
    expect(ran.err).toMatch(/symbolic link/u);
    expect(ran.out).toBe('');
  });

  it('does not swallow a link refusal from reading a member package.json, and runs no bin', async () => {
    const ws = await makeWorkspace({
      'packages/a': { name: 'a' },
      'packages/b': { name: 'b' },
    });
    const real = (await vi.importActual(
      '../src/commands/run-member-files.js',
    )) as typeof import('../src/commands/run-member-files.js');
    vi.mocked(readMemberPackage).mockImplementation(async (root, dir) => {
      if (dir === 'packages/b')
        throw new RunError(
          'UNSAFE_PATH',
          `${join(root, dir)} is a symbolic link; workspace members are never read through one`,
        );
      return await real.readMemberPackage(root, dir);
    });
    const ran = await go('exec', ['-r', 'fake-tool', 'x'], ws.root);
    expect(ran.status).toBe(3);
    expect(ran.err).toContain('symbolic link');
    expect(ran.out).toBe('');
  });

  it('still runs the bin in a member whose package.json cannot be read, since exec needs only its name', async () => {
    const ws = await makeWorkspace({
      'packages/a': { name: 'a' },
      'packages/b': { name: 'b' },
    });
    const real = (await vi.importActual(
      '../src/commands/run-member-files.js',
    )) as typeof import('../src/commands/run-member-files.js');
    vi.mocked(readMemberPackage).mockImplementation(async (root, dir) => {
      if (dir === 'packages/b')
        throw new RunError('INVALID_MANIFEST', 'package.json is not valid');
      return await real.readMemberPackage(root, dir);
    });
    const ran = await go(
      'exec',
      ['-r', '--workspace-concurrency=1', 'fake-tool', 'x'],
      ws.root,
    );
    expect(ran.status, ran.err).toBe(0);
    expect(ran.out.split('\n').filter(Boolean)).toHaveLength(2);
  });
});
