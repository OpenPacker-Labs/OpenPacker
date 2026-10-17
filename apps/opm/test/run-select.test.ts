import { describe, expect, it } from 'vitest';
import { RUN_HELP } from '../src/commands/run-help.js';
import {
  planWorkspace,
  workspaceConcurrency,
} from '../src/commands/run-select.js';
import { SelectionParser } from '../src/commands/run-select-args.js';
import { contextWith, makeWorkspace } from './workspace-fixture.js';

function select(...tokens: string[]) {
  const parser = new SelectionParser('run');
  for (let at = 0; at < tokens.length; ) at += parser.accept(tokens, at);
  const result = parser.result();
  if (result === undefined) throw new Error('no selection');
  return result;
}

async function plan(tokens: string[], processors?: number) {
  const ws = await makeWorkspace({
    'packages/a': { name: '@s/a', dependencies: { '@s/b': 'workspace:*' } },
    'packages/b': { name: '@s/b', dependencies: { '@s/c': 'workspace:*' } },
    'packages/c': { name: '@s/c' },
    'packages/d': {},
  });
  return await planWorkspace(
    select(...tokens),
    ws.root,
    false,
    ws.root,
    contextWith(
      {},
      processors === undefined ? {} : { parallelism: processors },
    ),
  );
}

describe('workspaceConcurrency', () => {
  it("is pnpm's: a number is itself, 0 every processor, a negative number that many fewer, never below one", () => {
    expect(workspaceConcurrency(undefined, 8, 4)).toBe(4);
    expect(workspaceConcurrency(3, 8, 4)).toBe(3);
    expect(workspaceConcurrency(0, 8, 4)).toBe(8);
    expect(workspaceConcurrency(-1, 8, 4)).toBe(7);
    expect(workspaceConcurrency(-20, 8, 4)).toBe(1);
  });

  it('is described by --help as the rule it is: 0 is every processor, not unbounded', () => {
    expect(RUN_HELP).toContain('0 every processor, -n that many fewer');
    expect(RUN_HELP).not.toMatch(/; 0 all/u);
  });
});

describe('planWorkspace', () => {
  it('runs min(4, processors) members at once by default', async () => {
    expect((await plan(['-r'], 2)).limit).toBe(2);
    expect((await plan(['-r'], 4)).limit).toBe(4);
    expect((await plan(['-r'], 64)).limit).toBe(4);
  });

  it('takes the limit asked for, and has no limit with --parallel', async () => {
    expect((await plan(['-r', '--workspace-concurrency=7'], 2)).limit).toBe(7);
    expect((await plan(['-r', '--workspace-concurrency=0'], 6)).limit).toBe(6);
    expect((await plan(['-r', '--parallel'], 2)).limit).toBe(Infinity);
  });

  it('runs npm-style selections one at a time unless told otherwise', async () => {
    expect((await plan(['--workspaces'], 8)).limit).toBe(1);
    expect((await plan(['-w', 'packages/d'], 8)).limit).toBe(1);
    expect(
      (await plan(['--workspaces', '--workspace-concurrency=3'], 8)).limit,
    ).toBe(3);
  });

  it('groups the output of members that run at once and streams the rest', async () => {
    expect((await plan(['-r'], 4)).mode).toBe('group');
    expect((await plan(['-r', '--stream'], 4)).mode).toBe('stream');
    expect((await plan(['-r', '--parallel'], 4)).mode).toBe('stream');
    expect((await plan(['-r', '--workspace-concurrency=1'], 4)).mode).toBe(
      'stream',
    );
    expect((await plan(['--workspaces'], 4)).mode).toBe('stream');
  });

  it('puts dependencies first and says what each member waits for', async () => {
    const p = await plan(['-r']);
    const dirs = p.members.map((m) => m.dir);
    expect(dirs.indexOf('packages/c')).toBeLessThan(dirs.indexOf('packages/b'));
    expect(dirs.indexOf('packages/b')).toBeLessThan(dirs.indexOf('packages/a'));
    const after = Object.fromEntries(p.members.map((m) => [m.dir, m.after]));
    expect(after['packages/a']).toEqual(['packages/b']);
    expect(after['packages/b']).toEqual(['packages/c']);
    expect(after['packages/c']).toEqual([]);
    expect(after['packages/d']).toEqual([]);
  });

  it('reverses both the order and what waits for what with --reverse', async () => {
    const p = await plan(['-r', '--reverse']);
    const after = Object.fromEntries(p.members.map((m) => [m.dir, m.after]));
    expect(after['packages/c']).toEqual(['packages/b']);
    expect(after['packages/a']).toEqual([]);
    const dirs = p.members.map((m) => m.dir);
    expect(dirs.indexOf('packages/a')).toBeLessThan(dirs.indexOf('packages/c'));
  });

  it('waits for nothing with --no-sort or --parallel, and keeps directory order', async () => {
    for (const flag of ['--no-sort', '--parallel']) {
      const p = await plan(['-r', flag]);
      expect(
        p.members.map((m) => m.dir),
        flag,
      ).toEqual(['packages/a', 'packages/b', 'packages/c', 'packages/d']);
      expect(
        p.members.every((m) => m.after.length === 0),
        flag,
      ).toBe(true);
    }
  });

  it('labels a member by its name, else its directory', async () => {
    const p = await plan(['-r']);
    expect(p.members.map((m) => m.label).sort()).toEqual([
      '@s/a',
      '@s/b',
      '@s/c',
      'packages/d',
    ]);
  });

  it('names the absolute directory of each member under the canonical root', async () => {
    const p = await plan(['--workspace-root']);
    expect(p.members).toHaveLength(1);
    expect(p.members[0]).toMatchObject({ dir: '', abs: p.root, label: 'root' });
  });
});
