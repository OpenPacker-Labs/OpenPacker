/**
 * `opm run` over the member lists of four real repositories (HoBo, ai-bdd,
 * ts-autocode, gitlang). The manifests are wave one's fixtures in
 * packages/opm-project/test/fixtures/workspaces: names, versions, workspaces
 * and the dependency lists, no source. Every member gets one script that
 * appends its directory to order.log, so a run is read back as an order.
 */
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  parseFilter,
  resolveWorkspaceLimits,
  selectMembers,
} from '@openpacker/adapter-core';
import { discoverWorkspace, graphOfWorkspace } from '@openpacker/opm-project';
import { afterAll, describe, expect, it } from 'vitest';
import { go } from './workspace-fixture.js';

const posix = describe.skipIf(process.platform === 'win32');

interface Fixture {
  repo: string;
  declaration: { file: string; text?: string };
  root: Record<string, unknown>;
  bare: string[];
  members: Record<string, Record<string, unknown>>;
}

const made: string[] = [];
afterAll(async () => {
  await Promise.all(made.map((d) => rm(d, { recursive: true, force: true })));
});

const MARK = 'echo "${PWD#"$INIT_CWD"/}" >> "$INIT_CWD/order.log"';

async function build(
  name: string,
): Promise<{ root: string; fixture: Fixture }> {
  const fixture = JSON.parse(
    readFileSync(
      new URL(
        `../../../packages/opm-project/test/fixtures/workspaces/${name}.json`,
        import.meta.url,
      ),
      'utf8',
    ),
  ) as Fixture;
  const root = await mkdtemp(join(tmpdir(), `opm-real-${name}-`));
  made.push(root);
  const write = async (path: string, text: string) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  };
  await write(
    'package.json',
    JSON.stringify({ ...fixture.root, scripts: { build: MARK } }),
  );
  if (fixture.declaration.text !== undefined)
    await write('pnpm-workspace.yaml', fixture.declaration.text);
  for (const [dir, manifest] of Object.entries(fixture.members))
    await write(
      `${dir}/package.json`,
      JSON.stringify({ ...manifest, scripts: { build: MARK } }),
    );
  for (const dir of fixture.bare)
    await mkdir(join(root, dir), { recursive: true });
  return { root, fixture };
}

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

posix('the real workspaces, planned', () => {
  it('HoBo: discovery, selection and ordering of 792 members take seconds and tens of megabytes at most', async () => {
    const { root } = await build('hobo');
    const { planWorkspace } = await import('../src/commands/run-select.js');
    const { contextWith } = await import('./workspace-fixture.js');
    const { SelectionParser } = await import(
      '../src/commands/run-select-args.js'
    );
    const parse = (...tokens: string[]) => {
      const parser = new SelectionParser('run');
      for (let at = 0; at < tokens.length; ) at += parser.accept(tokens, at);
      return parser.result()!;
    };
    const before = process.memoryUsage();
    const started = performance.now();
    const all = await planWorkspace(
      parse('-r'),
      root,
      false,
      root,
      contextWith(),
    );
    const allMs = performance.now() - started;
    const closure = await planWorkspace(
      parse('--filter', '...@hobo/core'),
      root,
      false,
      root,
      contextWith(),
    );
    const after = process.memoryUsage();
    expect(all.members).toHaveLength(791);
    expect(closure.members.length).toBeGreaterThan(10);
    expect(allMs).toBeLessThan(5000);
    expect(after.heapUsed - before.heapUsed).toBeLessThan(200 * 1024 * 1024);
    console.info(
      `HoBo plan: -r ${allMs.toFixed(0)} ms (${all.members.length} members), closure ${closure.members.length} members, heap +${((after.heapUsed - before.heapUsed) / 1048576).toFixed(1)} MiB, rss +${((after.rss - before.rss) / 1048576).toFixed(1)} MiB`,
    );
  });
});
