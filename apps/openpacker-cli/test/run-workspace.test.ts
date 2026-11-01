import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  contextWith,
  go,
  makeWorkspace,
  peakOverlap,
  started,
  trace,
} from './workspace-fixture.js';

const posix = describe.skipIf(process.platform === 'win32');

/** a depends on b depends on c; d depends on nothing; e has no build. */
async function chain(extra: Record<string, string> = {}) {
  return await makeWorkspace({
    'packages/a': {
      name: '@s/a',
      version: '1.0.0',
      dependencies: { '@s/b': 'workspace:*' },
      scripts: { build: trace('a'), ...extra },
    },
    'packages/b': {
      name: '@s/b',
      version: '1.0.0',
      dependencies: { '@s/c': 'workspace:*' },
      scripts: { build: trace('b') },
    },
    'packages/c': {
      name: '@s/c',
      version: '1.0.0',
      scripts: { build: trace('c') },
    },
    'packages/d': {
      name: 'd',
      version: '1.0.0',
      scripts: { build: trace('d') },
    },
    'packages/e': { name: 'e', version: '1.0.0', scripts: { other: 'true' } },
  });
}

posix('opm run -r', () => {
  it('runs the script in every member that has it, dependencies first, and leaves the root out', async () => {
    const ws = await chain();
    const ran = await go(
      'run',
      ['build', '-r', '--workspace-concurrency=1'],
      ws.root,
    );
    expect(ran.status, ran.err).toBe(0);
    const order = started(await ws.log());
    expect(order).toHaveLength(4);
    expect(order.indexOf('c')).toBeLessThan(order.indexOf('b'));
    expect(order.indexOf('b')).toBeLessThan(order.indexOf('a'));
  });

  it('exits 4 when no member has the script, and 0 with --if-present', async () => {
    const ws = await chain();
    const missing = await go('run', ['nothing', '-r'], ws.root);
    expect(missing.status).toBe(4);
    expect(missing.err).toContain(
      'None of the 5 selected members has a "nothing" script',
    );
    expect(
      (await go('run', ['nothing', '-r', '--if-present'], ws.root)).status,
    ).toBe(0);
  });

  it('refuses -r where there is no workspace, with exit 2', async () => {
    const ws = await makeWorkspace({});
    await rm(join(ws.root, 'pnpm-workspace.yaml'));
    const ran = await go('run', ['x', '-r'], ws.root);
    expect(ran.status).toBe(2);
    expect(ran.err).toContain('declares no workspace');
  });
});

posix('concurrency', () => {
  /** Six independent members; the ones named in `together` wait for each other to have started. */
  async function wide(together: string[] = [], ms = 100) {
    const members: Record<
      string,
      { name: string; scripts: Record<string, string> }
    > = {};
    for (const id of ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'])
      members[`packages/${id}`] = {
        name: id,
        scripts: {
          build: trace(
            id,
            ms,
            0,
            together.filter((other) => other !== id),
          ),
        },
      };
    return await makeWorkspace(members);
  }

  it('runs at most --workspace-concurrency members at once, and that many when it can', async () => {
    // m1 and m2 each wait for the other to have started, so they only finish
    // if two run at once; the bound itself is read off the log.
    const ws = await wide(['m1', 'm2']);
    const ran = await go(
      'run',
      ['build', '-r', '--workspace-concurrency=2'],
      ws.root,
    );
    expect(ran.status, ran.err).toBe(0);
    expect(peakOverlap(await ws.log())).toBe(2);
  });

  it('runs one at a time with --workspace-concurrency=1', async () => {
    const ws = await wide();
    await go('run', ['build', '-r', '--workspace-concurrency=1'], ws.root);
    expect(peakOverlap(await ws.log())).toBe(1);
  });

  it('runs everything at once with --parallel: each member waits for the other five to have started', async () => {
    const ws = await wide(['m1', 'm2', 'm3', 'm4', 'm5', 'm6']);
    const ran = await go('run', ['build', '--parallel', '-r'], ws.root);
    expect(ran.status, ran.err).toBe(0);
    expect(started(await ws.log())).toHaveLength(6);
    expect(peakOverlap(await ws.log())).toBe(6);
  });

  it('proves the handshake: two members that wait for each other cannot run one at a time', async () => {
    const ws = await makeWorkspace({
      'packages/a': { name: 'a', scripts: { build: trace('a', 0, 0, ['b']) } },
      'packages/b': { name: 'b', scripts: { build: trace('b', 0, 0, ['a']) } },
    });
    const ran = await go(
      'run',
      ['build', '-r', '--workspace-concurrency=1'],
      ws.root,
      contextWith({ TRACE_DEADLINE_MS: '1500' }),
    );
    expect(ran.status).toBe(9);
  });
});

posix('opm run -r with no script', () => {
  it('asks for one, with exit 2', async () => {
    const ws = await chain();
    const ran = await go('run', ['-r'], ws.root);
    expect(ran.status).toBe(2);
    expect(ran.err).toContain('Name the script to run in the selected members');
  });
});
