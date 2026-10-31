/**
 * `opm run` over the member lists of four real repositories (HoBo, ai-bdd,
 * ts-autocode, gitlang), written by `real-workspace-fixture.ts`. Every member
 * gets one script that appends its directory to order.log, so a run is read
 * back as an order. What planning HoBo costs is `run-workspace-plan.test.ts`.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  parseFilter,
  resolveWorkspaceLimits,
  selectMembers,
} from '@openpacker/adapter-core';
import { discoverWorkspace, graphOfWorkspace } from '@openpacker/opm-project';
import { describe, expect, it } from 'vitest';
import { buildRealWorkspace as build } from './real-workspace-fixture.js';
import { go } from './workspace-fixture.js';

const posix = describe.skipIf(process.platform === 'win32');

async function ranDirs(root: string): Promise<string[]> {
  return (await readFile(join(root, 'order.log'), 'utf8'))
    .split('\n')
    .filter(Boolean);
}

/** Every dependency of a member ran before it. */
async function dependenciesFirst(root: string, ran: string[]): Promise<void> {
  const discovery = await discoverWorkspace(root);
  const graph = graphOfWorkspace(discovery!);
  const at = new Map(ran.map((dir, index) => [dir, index]));
  for (const edge of graph.edges) {
    if (edge.from === '' || edge.to === '') continue;
    if (!at.has(edge.from) || !at.has(edge.to)) continue;
    expect(at.get(edge.to)!, `${edge.to} before ${edge.from}`).toBeLessThan(
      at.get(edge.from)!,
    );
  }
}

posix('the real workspaces, run with -r', () => {
  it.each([
    ['ai-bdd', 8],
    ['ts-autocode', 4],
    ['gitlang', 8],
  ])(
    '%s: every member ran once, each after its dependencies',
    async (name, count) => {
      const { root } = await build(name);
      const ran = await go('run', ['build', '-r'], root);
      expect(ran.status, ran.err).toBe(0);
      const dirs = await ranDirs(root);
      expect(dirs).toHaveLength(count);
      expect(new Set(dirs).size).toBe(count);
      await dependenciesFirst(root, dirs);
    },
  );

  it(
    'HoBo: all 791 members ran, each after its dependencies, with the default concurrency',
    { timeout: 180_000 },
    async () => {
      const { root, fixture } = await build('hobo');
      const started = Date.now();
      const ran = await go('run', ['build', '-r'], root);
      const seconds = (Date.now() - started) / 1000;
      expect(ran.status, ran.err).toBe(0);
      const dirs = await ranDirs(root);
      expect(dirs).toHaveLength(Object.keys(fixture.members).length);
      expect(new Set(dirs).size).toBe(dirs.length);
      await dependenciesFirst(root, dirs);
      console.info(
        `HoBo: ${dirs.length} members run in ${seconds.toFixed(1)} s`,
      );
    },
  );
});

posix('the filters the real scripts use', () => {
  it("HoBo: --filter '@hobo/mcp...' runs exactly the members the model selects", async () => {
    const { root } = await build('hobo');
    const ran = await go('run', ['build', '--filter', '@hobo/mcp...'], root);
    expect(ran.status, ran.err).toBe(0);
    const graph = graphOfWorkspace((await discoverWorkspace(root))!);
    const expected = selectMembers(
      graph,
      [
        parseFilter('@hobo/mcp...', {
          cwd: '',
          limits: resolveWorkspaceLimits(),
        }),
      ],
      { excludeRoot: true },
    ).selected;
    const dirs = await ranDirs(root);
    expect([...dirs].sort()).toEqual([...expected].sort());
    expect(dirs.length).toBeGreaterThan(1);
    await dependenciesFirst(root, dirs);
  });

  it('HoBo: --filter @hobo/conformance runs that one member, as pnpm --filter does', async () => {
    const { root } = await build('hobo');
    const ran = await go(
      'run',
      ['build', '--filter', '@hobo/conformance'],
      root,
    );
    expect(ran.status, ran.err).toBe(0);
    expect(ran.out).toBe('');
    expect((await ranDirs(root)).length).toBe(1);
  });

  it('ai-bdd: pnpm -r --filter "./packages/**" run build', async () => {
    const { root } = await build('ai-bdd');
    const ran = await go(
      'run',
      ['build', '-r', '--filter', './packages/**'],
      root,
    );
    expect(ran.status, ran.err).toBe(0);
    expect(await ranDirs(root)).toHaveLength(8);
  });

  it('gitlang: npm run build -w @gitlang/web runs the one member', async () => {
    const { root } = await build('gitlang');
    const ran = await go('run', ['build', '-w', '@gitlang/web'], root);
    expect(ran.status, ran.err).toBe(0);
    expect(await ranDirs(root)).toEqual(['apps/web']);
  });

  it('gitlang: npm run build --workspaces runs every member in directory order', async () => {
    const { root } = await build('gitlang');
    const ran = await go('run', ['build', '--workspaces'], root);
    expect(ran.status, ran.err).toBe(0);
    const dirs = await ranDirs(root);
    expect(dirs).toHaveLength(8);
    expect(dirs).toEqual([...dirs].sort());
  });
});
