import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  go,
  makeWorkspace,
  peakOverlap,
  started,
  steps,
  trace,
} from './workspace-fixture.js';

const posix = describe.skipIf(process.platform === 'win32');

/** a -> b -> c by dependency; d alone; e has no build; the root has one. Each build holds `ms`. */
async function chain(ms = 0) {
  return await makeWorkspace(
    {
      'packages/a': {
        name: '@s/a',
        version: '1.0.0',
        dependencies: { '@s/b': 'workspace:*' },
        scripts: { build: trace('a', ms) },
      },
      'packages/b': {
        name: '@s/b',
        version: '1.0.0',
        dependencies: { '@s/c': 'workspace:*' },
        scripts: { build: trace('b', ms) },
      },
      'packages/c': {
        name: '@s/c',
        version: '1.0.0',
        scripts: { build: trace('c', ms) },
      },
      'packages/d': {
        name: 'd',
        version: '1.0.0',
        scripts: { build: trace('d', ms) },
      },
      'packages/e': { name: 'e', version: '1.0.0', scripts: { other: 'true' } },
    },
    { root: { scripts: { build: trace('root', ms) } } },
  );
}

/** Run `opm run build <argv>` one member at a time and return the ids in start order. */
async function order(argv: string[]) {
  const ws = await chain();
  const ran = await go(
    'run',
    ['build', '--workspace-concurrency=1', ...argv],
    ws.root,
  );
  expect(ran.status, ran.err).toBe(0);
  return started(await ws.log());
}

posix('--filter', () => {
  it('selects one member by name', async () => {
    expect(await order(['--filter', '@s/b'])).toEqual(['b']);
  });

  it('takes the member and what it depends on with name..., dependencies first', async () => {
    expect(await order(['--filter', '@s/a...'])).toEqual(['c', 'b', 'a']);
  });

  it('takes the member and what depends on it with ...name', async () => {
    expect(await order(['--filter', '...@s/c'])).toEqual(['c', 'b', 'a']);
  });

  it('leaves the member itself out with ^', async () => {
    expect(await order(['--filter', '...^@s/c'])).toEqual(['b', 'a']);
    expect(await order(['--filter', '@s/a^...'])).toEqual(['c', 'b']);
  });

  it('subtracts with ! from the members -r selects', async () => {
    expect(await order(['-r', '--filter', '!d'])).toEqual(['c', 'b', 'a']);
  });

  it('selects by directory and by a pattern', async () => {
    expect(await order(['--filter', './packages/d'])).toEqual(['d']);
    expect(await order(['--filter', '{packages/c}...'])).toEqual(['c']);
    expect((await order(['--filter', './packages/*'])).sort()).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
  });

  it('adds the members of several filters, and reads -F and --filter=', async () => {
    expect((await order(['--filter', 'd', '--filter', '@s/c'])).sort()).toEqual(
      ['c', 'd'],
    );
    expect((await order(['-F', 'd', '--filter=@s/c'])).sort()).toEqual([
      'c',
      'd',
    ]);
  });

  it('does not select the workspace root, even by name, unless asked', async () => {
    const ws = await chain();
    const left = await go('run', ['build', '--filter', 'root'], ws.root);
    expect(left.status).toBe(4);
    expect(left.err).toContain(
      'select no workspace member once the exclusions',
    );
    expect(
      await order(['--filter', 'root', '--include-workspace-root']),
    ).toEqual(['root']);
  });

  it('refuses a filter that matches nothing, with exit 4, and one it cannot read, with exit 2', async () => {
    const ws = await chain();
    const none = await go('run', ['build', '--filter', 'nobody'], ws.root);
    expect(none.status).toBe(4);
    expect(none.err).toContain(
      'No workspace member matches the filter "nobody"',
    );
    const since = await go(
      'run',
      ['build', '--filter', '[origin/main]'],
      ws.root,
    );
    expect(since.status).toBe(2);
    expect(since.err).toContain('git history');
  });

  it('skips a member that has no such script, quietly', async () => {
    const ws = await chain();
    const ran = await go(
      'run',
      ['build', '-r', '--workspace-concurrency=1'],
      ws.root,
    );
    expect(ran.status, ran.err).toBe(0);
    expect(ran.err).toBe('');
    expect(started(await ws.log())).not.toContain('e');
  });
});

posix('order', () => {
  it('runs dependencies first with -r', async () => {
    const ids = await order(['-r']);
    expect(ids.indexOf('c')).toBeLessThan(ids.indexOf('b'));
    expect(ids.indexOf('b')).toBeLessThan(ids.indexOf('a'));
    expect(ids).toHaveLength(4);
  });

  it('runs in directory order with --no-sort, whatever depends on what', async () => {
    expect(await order(['-r', '--no-sort'])).toEqual(['a', 'b', 'c', 'd']);
  });

  it('runs dependents first with --reverse', async () => {
    const ids = await order(['-r', '--reverse']);
    expect(ids.indexOf('a')).toBeLessThan(ids.indexOf('b'));
    expect(ids.indexOf('b')).toBeLessThan(ids.indexOf('c'));
    expect(ids).toHaveLength(4);
  });

  it('holds a member back while the member it depends on is still running, and starts the others meanwhile', async () => {
    // b ends only after z has started, so z must run beside b; a depends on b.
    const ws = await makeWorkspace({
      'packages/a': {
        name: 'a',
        dependencies: { b: 'workspace:*' },
        scripts: { build: trace('a') },
      },
      'packages/b': { name: 'b', scripts: { build: trace('b', 0, 0, ['z']) } },
      'packages/z': { name: 'z', scripts: { build: trace('z', 100) } },
    });
    const ran = await go(
      'run',
      ['build', '-r', '--workspace-concurrency=3'],
      ws.root,
    );
    expect(ran.status, ran.err).toBe(0);
    const log = await ws.log();
    const at = (what: string, id: string) =>
      log.find(([w, i]) => w === what && i === id)![2];
    expect(at('start', 'a')).toBeGreaterThanOrEqual(at('end', 'b'));
    expect(at('start', 'z')).toBeLessThanOrEqual(at('end', 'b'));
  });

  it('starts a dependent only after what it depends on has ended, whatever the limit allows', async () => {
    // Nothing here is a clock that could pass by luck: c, b and a each record
    // whether the file their dependency touches at its end exists when they
    // start. A plan that dropped the edges would start all three at once (the
    // limit is 4) and each would see "no".
    const ws = await makeWorkspace({
      'packages/a': {
        name: 'a',
        scripts: { build: steps('sleep:300', 'touch:a.done') },
      },
      'packages/b': {
        name: 'b',
        dependencies: { a: 'workspace:*' },
        scripts: { build: steps('saw:a.done', 'sleep:300', 'touch:b.done') },
      },
      'packages/c': {
        name: 'c',
        dependencies: { b: 'workspace:*' },
        scripts: { build: steps('saw:b.done') },
      },
      'packages/z': { name: 'z', scripts: { build: steps('touch:z.done') } },
    });
    const ran = await go(
      'run',
      ['build', '-r', '--workspace-concurrency=4'],
      ws.root,
    );
    expect(ran.status, ran.err).toBe(0);
    expect(await readFile(join(ws.root, 'saw-a.done'), 'utf8')).toBe('yes');
    expect(await readFile(join(ws.root, 'saw-b.done'), 'utf8')).toBe('yes');
  });

  it('starts what a dependency waits for only after its dependents with --reverse', async () => {
    const ws = await makeWorkspace({
      'packages/a': {
        name: 'a',
        dependencies: { b: 'workspace:*' },
        scripts: { build: steps('sleep:300', 'touch:a.done') },
      },
      'packages/b': { name: 'b', scripts: { build: steps('saw:a.done') } },
    });
    const ran = await go(
      'run',
      ['build', '-r', '--reverse', '--workspace-concurrency=4'],
      ws.root,
    );
    expect(ran.status, ran.err).toBe(0);
    expect(await readFile(join(ws.root, 'saw-a.done'), 'utf8')).toBe('yes');
  });

  it('runs the members of a dependency cycle together and says so once', async () => {
    // Each waits for the other to have started: they finish only if run together.
    const ws = await makeWorkspace({
      'packages/x': {
        name: 'x',
        dependencies: { y: 'workspace:*' },
        scripts: { build: trace('x', 50, 0, ['y']) },
      },
      'packages/y': {
        name: 'y',
        devDependencies: { x: 'workspace:*' },
        scripts: { build: trace('y', 50, 0, ['x']) },
      },
    });
    const ran = await go('run', ['build', '-r'], ws.root);
    expect(ran.status, ran.err).toBe(0);
    expect(
      ran.err.match(/warning: cyclic workspace dependencies/gu),
    ).toHaveLength(1);
    expect(ran.err).toContain('x -> y -> x');
    expect(peakOverlap(await ws.log())).toBe(2);
  });
});

posix('npm spellings', () => {
  it('-w selects a member by name or by directory and runs them in directory order', async () => {
    expect(await order(['-w', 'd', '-w', '@s/b'])).toEqual(['b', 'd']);
    expect(await order(['--workspace', 'packages/c'])).toEqual(['c']);
    expect(await order(['--workspace=packages/c'])).toEqual(['c']);
  });

  it('-w with a directory takes the members one level below it', async () => {
    expect(await order(['-w', 'packages'])).toEqual(['a', 'b', 'c', 'd']);
  });

  it('--workspaces runs every member in directory order, one at a time, root left out', async () => {
    const ws = await chain(60);
    const ran = await go('run', ['build', '--workspaces'], ws.root);
    expect(ran.status, ran.err).toBe(0);
    const log = await ws.log();
    expect(started(log)).toEqual(['a', 'b', 'c', 'd']);
    expect(peakOverlap(log)).toBe(1);
  });

  it('--include-workspace-root adds the root to --workspaces', async () => {
    expect(await order(['--workspaces', '--include-workspace-root'])).toEqual([
      'root',
      'a',
      'b',
      'c',
      'd',
    ]);
  });

  it('refuses a name that is no member, with exit 4', async () => {
    const ws = await chain();
    const ran = await go('run', ['build', '-w', 'nope'], ws.root);
    expect(ran.status).toBe(4);
    expect(ran.err).toContain('No workspaces found');
  });

  it('--workspace-root runs the root alone', async () => {
    expect(await order(['--workspace-root'])).toEqual(['root']);
  });

  it('does not mix the two ways of choosing', async () => {
    const ws = await chain();
    for (const argv of [
      ['--filter', 'd', '-w', 'd'],
      ['-r', '--workspaces'],
      ['--workspace-root', '-r'],
      ['--parallel'],
    ]) {
      const ran = await go('run', ['build', ...argv], ws.root);
      expect(ran.status, argv.join(' ')).toBe(2);
    }
  });
});
