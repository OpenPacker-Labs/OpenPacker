import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunContext } from '../src/commands/run-context.js';
import { RunError } from '../src/commands/run-error.js';
import { readMemberPackage } from '../src/commands/run-member-files.js';
import { contextWith, go, makeWorkspace } from './workspace-fixture.js';

const posix = describe.skipIf(process.platform === 'win32');

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(
    temps.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});

async function outside(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'opm-outside-')));
  temps.push(dir);
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'evil', version: '9.9.9', scripts: { go: 'true' } }),
  );
  return dir;
}

/**
 * The real reader, except that `fails` says what reading `dir` does: a link
 * that appears after discovery can only be simulated by the reader.
 */
function readerFailing(dir: string, error: RunError): RunContext['readMember'] {
  return async (root, member) => {
    if (member === dir) throw error;
    return await readMemberPackage(root, member);
  };
}

const LINK = (dir: string) =>
  new RunError(
    'UNSAFE_PATH',
    `${dir} is a symbolic link; workspace members are never read through one`,
  );

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
    const ran = await go(
      'exec',
      ['-r', 'fake-tool', 'x'],
      ws.root,
      contextWith(
        {},
        { readMember: readerFailing('packages/b', LINK('packages/b')) },
      ),
    );
    expect(ran.status).toBe(3);
    expect(ran.err).toContain('symbolic link');
    expect(ran.out).toBe('');
  });

  it('still runs the bin in a member whose package.json cannot be read, since exec needs only its name', async () => {
    const ws = await makeWorkspace({
      'packages/a': { name: 'a' },
      'packages/b': { name: 'b' },
    });
    const ran = await go(
      'exec',
      ['-r', '--workspace-concurrency=1', 'fake-tool', 'x'],
      ws.root,
      contextWith(
        {},
        {
          readMember: readerFailing(
            'packages/b',
            new RunError('INVALID_MANIFEST', 'package.json is not valid'),
          ),
        },
      ),
    );
    expect(ran.status, ran.err).toBe(0);
    expect(ran.out.split('\n').filter(Boolean)).toHaveLength(2);
  });
});

posix('opm run across members and a link that appears after discovery', () => {
  it('refuses it and starts no script', async () => {
    const ws = await makeWorkspace({
      'packages/a': { name: 'a', scripts: { go: 'echo ran-a' } },
      'packages/b': { name: 'b', scripts: { go: 'echo ran-b' } },
    });
    const ran = await go(
      'run',
      ['go', '-r'],
      ws.root,
      contextWith(
        {},
        { readMember: readerFailing('packages/b', LINK('packages/b')) },
      ),
    );
    expect(ran.status).toBe(3);
    expect(ran.err).toContain('symbolic link');
    expect(ran.out).toBe('');
  });
});
