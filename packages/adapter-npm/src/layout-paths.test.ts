import { execFileSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { NativeLockEntry } from '@openpacker/adapter-core';
import {
  LayoutPathsError,
  LayoutTooLargeError,
  planLayout,
  planLayoutFromPaths,
  toLayoutEntries,
  type LayoutEntry,
} from './layout-plan.js';
import { NpmProjectFormat } from './project.js';

function layoutEntry(id: string, version = '1.0.0'): LayoutEntry {
  const source = {
    purl: `pkg:npm/${id}`,
    exactPurl: `pkg:npm/${id}@${version}`,
    name: id,
    version,
    scope: 'runtime',
    source: 'x',
    digest: `sha256:${id}${version}`,
    size: 1,
    transitive: true,
  } satisfies NativeLockEntry;
  return {
    id: `${id}@${version}`,
    name: id,
    version,
    digest: source.digest,
    direct: false,
    dependencies: [],
    source,
  };
}

const at = (id: string, ...chain: string[]) => ({
  entry: layoutEntry(id),
  chain,
});

describe('planLayoutFromPaths', () => {
  it('puts each package exactly where the lock says, parents first', () => {
    const plan = planLayoutFromPaths([
      at('c', 'b', 'c'),
      at('b', 'b'),
      at('c', 'c'),
      at('n', '@s/n'),
      at('x', '@s/n', 'x'),
    ]);
    expect(plan.placements.map((place) => place.chain.join('>'))).toEqual([
      '@s/n',
      'b',
      'c',
      '@s/n>x',
      'b>c',
    ]);
    expect(plan.skipped).toEqual([]);
  });

  it('chooses nothing: a nested copy stays nested when the planner would hoist it', () => {
    const entries = [
      at('a', 'a'),
      { entry: { ...layoutEntry('c'), dependencies: [] }, chain: ['a', 'c'] },
    ];
    // Planned from edges, the only `c` would move up to the root.
    const planned = planLayout(
      entries.map(({ entry }, index) => ({
        ...entry,
        direct: index === 0,
        dependencies: index === 0 ? [entry.id.replace('a@', 'c@')] : [],
      })),
    );
    expect(
      planned.placements.map((place) => place.chain.join('>')).sort(),
    ).toEqual(['a', 'c']);
    expect(
      planLayoutFromPaths(entries).placements.map((place) =>
        place.chain.join('>'),
      ),
    ).toEqual(['a', 'a>c']);
  });

  it('is the same however the input is ordered', () => {
    const entries = [
      at('a', 'a'),
      at('c', 'a', 'c'),
      at('b', 'b'),
      at('c', 'c'),
    ];
    expect(planLayoutFromPaths([...entries].reverse())).toEqual(
      planLayoutFromPaths(entries),
    );
  });

  it('refuses, naming each, what cannot be written as written', () => {
    let thrown: unknown;
    try {
      planLayoutFromPaths([
        at('ok', 'ok'),
        at('dup1', 'd'),
        at('dup2', 'd'),
        at('orphan', 'gone', 'orphan'),
        at('dot', '.bin'),
        at('empty'),
      ]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(LayoutPathsError);
    expect((thrown as LayoutPathsError).problems).toEqual([
      expect.stringMatching(
        /dup1@1\.0\.0 and dup2@1\.0\.0 both claim node_modules\/d/u,
      ),
      expect.stringMatching(/\.bin.*not a safe directory name/u),
      'empty@1.0.0 has no place',
      expect.stringMatching(
        /orphan@1\.0\.0 lives inside gone, which is not installed/u,
      ),
    ]);
  });

  it('bounds the tree it will write', () => {
    expect(() =>
      planLayoutFromPaths([at('a', 'a'), at('b', 'b')], {
        maximumPlacements: 1,
      }),
    ).toThrow(LayoutTooLargeError);
  });
});

describe('writeLayout from the places a lock names', () => {
  const temps: string[] = [];
  afterEach(async () => {
    await Promise.all(
      temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  async function setup() {
    const dir = await mkdtemp(join(tmpdir(), 'npm-paths-'));
    temps.push(dir);
    const project = join(dir, 'project');
    await mkdir(project);
    let counter = 0;
    const entry = async (
      layoutPath: string,
      name: string,
      version: string,
      files: Record<string, string> = {},
      wrapper = 'package',
    ): Promise<NativeLockEntry> => {
      counter += 1;
      const storePath = join(dir, 'store', `sha256-${counter}`);
      const all = {
        'package.json': JSON.stringify({ name, version, main: 'index.js' }),
        'index.js': `module.exports = { at: ${JSON.stringify(layoutPath)}, version: ${JSON.stringify(version)} };\n`,
        ...files,
      };
      for (const [path, contents] of Object.entries(all)) {
        const target = join(storePath, wrapper, path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, contents);
      }
      return {
        purl: `pkg:npm/${name}`,
        exactPurl: `pkg:npm/${name}@${version}`,
        name,
        version,
        scope: 'runtime',
        source: 'x',
        digest: `sha256:${String(counter).padStart(64, '0')}`,
        size: 1,
        storePath,
        transitive: true,
        layoutPath,
      };
    };
    const layout = async (entries: NativeLockEntry[]) => {
      const format = new NpmProjectFormat();
      const detected = await format.detectLayout(project);
      return format.writeLayout(detected!, entries);
    };
    return { dir, project, entry, layout };
  }

  it('installs one package at every path the lock gives it', async () => {
    const w = await setup();
    const c = (path: string) => w.entry(path, 'c', '2.0.0');
    await w.layout([
      await w.entry('node_modules/a', 'a', '1.0.0'),
      await w.entry('node_modules/b', 'b', '1.0.0'),
      await c('node_modules/a/node_modules/c'),
      await c('node_modules/b/node_modules/c'),
      await w.entry('node_modules/c', 'c', '1.0.0'),
      await w.entry('node_modules/@s/n', '@s/n', '3.0.0'),
    ]);
    const read = async (path: string) =>
      JSON.parse(
        await readFile(join(w.project, path, 'package.json'), 'utf8'),
      ) as { version: string };
    expect((await read('node_modules/a/node_modules/c')).version).toBe('2.0.0');
    expect((await read('node_modules/b/node_modules/c')).version).toBe('2.0.0');
    expect((await read('node_modules/c')).version).toBe('1.0.0');
    expect((await read('node_modules/@s/n')).version).toBe('3.0.0');
    expect(
      execFileSync(
        process.execPath,
        [
          '-e',
          "console.log(require('a/node_modules/c').version, require('c').version)",
        ],
        { cwd: w.project, encoding: 'utf8' },
      ).trim(),
    ).toBe('2.0.0 1.0.0');
  });

  it('strips the one directory a tarball wraps its files in, whatever it is called', async () => {
    const w = await setup();
    await w.layout([
      await w.entry('node_modules/old', 'old', '0.1.0', {}, 'old-0.1.0'),
    ]);
    await expect(
      stat(join(w.project, 'node_modules/old/package.json')),
    ).resolves.toBeTruthy();
    await expect(
      stat(join(w.project, 'node_modules/old/old-0.1.0')),
    ).rejects.toThrow();
  });

  it('names a string bin after the package, not after the alias it lives under', async () => {
    const w = await setup();
    await w.layout([
      await w.entry('node_modules/string-width-cjs', 'string-width', '4.2.3', {
        'package.json': JSON.stringify({
          name: 'string-width',
          version: '4.2.3',
          bin: 'cli.js',
        }),
        'cli.js': "console.log('hi')\n",
      }),
    ]);
    await expect(
      stat(join(w.project, 'node_modules/.bin/string-width')),
    ).resolves.toBeTruthy();
    await expect(
      stat(join(w.project, 'node_modules/.bin/string-width-cjs')),
    ).rejects.toThrow();
  });

  it('writes nothing when a place cannot be honoured', async () => {
    const w = await setup();
    await expect(
      w.layout([await w.entry('node_modules/a/node_modules/c', 'c', '1.0.0')]),
    ).rejects.toThrow(LayoutPathsError);
    await expect(stat(join(w.project, 'node_modules'))).rejects.toThrow();
  });

  it('will not mix planned and placed entries in one layout', async () => {
    const w = await setup();
    const placed = await w.entry('node_modules/a', 'a', '1.0.0');
    const planned = { ...(await w.entry('x', 'b', '1.0.0')) };
    delete planned.layoutPath;
    await expect(w.layout([placed, planned])).rejects.toThrow(
      /every package of a layout names its place/u,
    );
  });

  it('keeps entries planned from edges working as before', () => {
    const plan = planLayout(
      toLayoutEntries([
        {
          purl: 'pkg:npm/a',
          exactPurl: 'pkg:npm/a@1.0.0',
          name: 'a',
          version: '1.0.0',
          scope: 'runtime',
          source: 'x',
          digest: 'sha256:a',
          size: 1,
          transitive: false,
        },
      ]),
    );
    expect(plan.placements).toHaveLength(1);
  });
});
