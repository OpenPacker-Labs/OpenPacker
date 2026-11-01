import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { report, type ToolReport } from './run-fixture.js';
import { go, makeWorkspace } from './workspace-fixture.js';

const posix = describe.skipIf(process.platform === 'win32');

async function pair() {
  return await makeWorkspace({
    'packages/a': {
      name: '@s/a',
      version: '1.0.0',
      dependencies: { '@s/b': 'workspace:*' },
    },
    'packages/b': { name: '@s/b', version: '2.0.0' },
    'packages/c': { name: 'c', version: '3.0.0' },
  });
}

/** Each prefixed JSON line as `[label, report]`, in the order printed. */
function reports(out: string): [string, ToolReport][] {
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const at = line.indexOf(': ');
      return [line.slice(0, at), report(line.slice(at + 2))];
    });
}

posix('opm exec across members', () => {
  it('runs the bin in each selected member directory, dependencies first, with that member in its environment', async () => {
    const ws = await pair();
    const ran = await go(
      'exec',
      ['-r', '--workspace-concurrency=1', 'fake-tool', 'x'],
      ws.root,
    );
    expect(ran.status, ran.err).toBe(0);
    const seen = reports(ran.out);
    expect(seen.map(([label]) => label)).toEqual([
      '@s/b fake-tool',
      'c fake-tool',
      '@s/a fake-tool',
    ]);
    const [b, , a] = seen.map(([, info]) => info);
    expect(b).toMatchObject({
      argv: ['x'],
      cwd: join(ws.root, 'packages', 'b'),
      event: 'exec',
      name: '@s/b',
      version: '2.0.0',
      initCwd: ws.root,
    });
    expect(a).toMatchObject({
      cwd: join(ws.root, 'packages', 'a'),
      name: '@s/a',
    });
  });

  it('runs in the directory of the one member --filter selects, unprefixed', async () => {
    const ws = await pair();
    const ran = await go('exec', ['--filter', '@s/b', 'fake-tool'], ws.root);
    expect(ran.status, ran.err).toBe(0);
    expect(report(ran.out)).toMatchObject({
      cwd: join(ws.root, 'packages', 'b'),
      name: '@s/b',
    });
  });

  it('hands every option after the bin to the bin, including ones opm reads before it', async () => {
    const ws = await pair();
    const ran = await go(
      'exec',
      ['--filter', 'c', 'fake-tool', '--filter', 'x', '-r', '--', 'y'],
      ws.root,
    );
    expect(report(ran.out).argv).toEqual(['--filter', 'x', '-r', '--', 'y']);
  });

  it('finds a bin in the member own .bin before the root one', async () => {
    const ws = await pair();
    const bin = join(ws.root, 'packages', 'c', 'node_modules', '.bin');
    await mkdir(bin, { recursive: true });
    await writeFile(
      join(bin, 'fake-tool'),
      '#!/bin/sh\necho "own copy of $1"\n',
    );
    await chmod(join(bin, 'fake-tool'), 0o755);
    const ran = await go(
      'exec',
      ['-r', '--workspace-concurrency=1', 'fake-tool', 'q'],
      ws.root,
    );
    expect(ran.out).toContain('c fake-tool: own copy of q\n');
    expect(ran.out).toContain('@s/a fake-tool: {');
  });

  it('exits with the status of the first member whose bin fails, and names it', async () => {
    const ws = await pair();
    const ran = await go(
      'exec',
      ['-r', '--workspace-concurrency=1', 'fake-tool', '--exit', '5'],
      ws.root,
    );
    expect(ran.status).toBe(5);
    expect(ran.err).toBe('opm: "fake-tool" in @s/b exited with code 5\n');
  });

  it('refuses before starting anything when a member has no such bin, and says how many', async () => {
    const ws = await pair();
    const bin = join(ws.root, 'packages', 'a', 'node_modules', '.bin');
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, 'only-a'), '#!/bin/sh\necho hi\n');
    await chmod(join(bin, 'only-a'), 0o755);
    const ran = await go('exec', ['-r', 'only-a'], ws.root);
    expect(ran.status).toBe(4);
    expect(ran.err).toContain(
      '"only-a" is not in node_modules/.bin of 2 of the 3 selected members',
    );
    expect(ran.err).toContain('exec never fetches or searches PATH');
    expect(ran.out).toBe('');
  });

  it('runs in the workspace root with --workspace-root', async () => {
    const ws = await pair();
    const ran = await go('exec', ['--workspace-root', 'fake-tool'], ws.root);
    expect(report(ran.out)).toMatchObject({ cwd: ws.root, name: 'root' });
  });

  it('selects with npm spellings too', async () => {
    const ws = await pair();
    const ran = await go('exec', ['-w', 'c', 'fake-tool'], ws.root);
    expect(report(ran.out)).toMatchObject({ name: 'c' });
    const all = await go('exec', ['--workspaces', 'fake-tool'], ws.root);
    expect(reports(all.out).map(([label]) => label)).toEqual([
      '@s/a fake-tool',
      '@s/b fake-tool',
      'c fake-tool',
    ]);
  });

  it('refuses a name that is a path, and a workspace that is not one', async () => {
    const ws = await pair();
    expect((await go('exec', ['-r', './fake-tool'], ws.root)).status).toBe(2);
    const plain = await makeWorkspace({});
    const { rm } = await import('node:fs/promises');
    await rm(join(plain.root, 'pnpm-workspace.yaml'));
    expect((await go('exec', ['-r', 'fake-tool'], plain.root)).status).toBe(2);
  });
});
