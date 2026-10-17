/**
 * Whose executable a script runs after `opm ci` of a pnpm workspace (ADR 0055
 * §9). pnpm links each importer's direct dependencies' executables into that
 * importer's own `node_modules/.bin`, wherever the package was written, so a
 * member runs its own tool even when the tool is shared at the project, and
 * the project runs its own even when a member's tool of the same name sits
 * beside it.
 */

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { packTarGzip } from '@openpacker/project-io';
import { EXIT_CODES, runOpm } from '../src/opm.js';
import { capture } from './run-fixture.js';
import { go } from './workspace-fixture.js';

const posix = describe.skipIf(process.platform === 'win32');
const ORIGIN = 'https://registry.npmjs.org';
const temps: string[] = [];
let previous: string | undefined;
beforeEach(() => {
  previous = process.env.OPM_STORE_HOME;
});
afterEach(async () => {
  if (previous === undefined) delete process.env.OPM_STORE_HOME;
  else process.env.OPM_STORE_HOME = previous;
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

/** A package whose executable `bin` prints which package it is, and the packages it depends on. */
const tool = (name: string, bin: string, needs: readonly string[] = []) => ({
  name,
  bin,
  needs,
});

/** An importer's side of a workspace: a tool it needs, members it links, executables it declares itself. */
interface Importer {
  readonly tool?: string;
  /** Link name to the member's directory. */
  readonly links?: Readonly<Record<string, string>>;
  /** Executables of its own: name to a script that prints whose it is. */
  readonly bin?: Readonly<Record<string, string>>;
  /** What its `build` script runs; the tool's executable when it has one. */
  readonly build?: string;
}

/**
 * A pnpm workspace whose importers each need one tool and run it as `build`:
 * `importers` maps a directory (`.` for the project) to its tool (a name, or
 * none) or to a fuller description.
 */
async function installed(
  tools: readonly {
    name: string;
    bin: string;
    needs: readonly string[];
  }[],
  importers: Record<string, string | undefined | Importer>,
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'opm-ci-pnpm-bins-'));
  const store = await mkdtemp(join(tmpdir(), 'opm-ci-pnpm-bins-store-'));
  temps.push(dir, store);
  process.env.OPM_STORE_HOME = join(store, 'shared');
  const archives = new Map<string, Uint8Array>();
  const packages: string[] = [];
  const snapshots: string[] = [];
  const text = (value: string) => new TextEncoder().encode(value);
  for (const { name, bin, needs } of tools) {
    const bytes = packTarGzip([
      {
        path: 'package/package.json',
        contents: text(
          JSON.stringify({ name, version: '1.0.0', bin: { [bin]: 'cli.js' } }),
        ),
      },
      {
        path: 'package/cli.js',
        contents: text(`console.log(${JSON.stringify(`I am ${name}`)});\n`),
      },
    ]);
    archives.set(`${ORIGIN}/${name}/-/${name}-1.0.0.tgz`, bytes);
    const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
    packages.push(
      `  ${name}@1.0.0:\n    resolution: {integrity: ${integrity}}\n    hasBin: true\n`,
    );
    snapshots.push(
      needs.length === 0
        ? `  ${name}@1.0.0: {}\n`
        : `  ${name}@1.0.0:\n    dependencies:\n${needs.map((need) => `      ${need}: 1.0.0\n`).join('')}`,
    );
  }
  const lockImporters: string[] = [];
  for (const [id, given] of Object.entries(importers)) {
    const importer: Importer =
      typeof given === 'object' ? given : { tool: given };
    const need = importer.tool;
    const links = Object.entries(importer.links ?? {});
    const run =
      importer.build ?? tools.find((t) => t.name === need)?.bin ?? 'true';
    const manifest = {
      name: id === '.' ? 'app' : id.split('/').at(-1),
      version: '1.0.0',
      scripts: { build: run },
      ...(importer.bin !== undefined && { bin: importer.bin }),
      dependencies: {
        ...(need !== undefined && { [need]: '^1.0.0' }),
        ...Object.fromEntries(links.map(([alias]) => [alias, 'workspace:*'])),
      },
    };
    await mkdir(join(dir, id), { recursive: true });
    await writeFile(join(dir, id, 'package.json'), JSON.stringify(manifest));
    for (const [name, file] of Object.entries(importer.bin ?? {}))
      await writeFile(
        join(dir, id, file),
        `console.log(${JSON.stringify(`I am the member ${manifest.name} (${name})`)});\n`,
      );
    const lines = [
      ...(need === undefined
        ? []
        : [
            `      ${need}:\n        specifier: ^1.0.0\n        version: 1.0.0\n`,
          ]),
      ...links.map(
        ([alias, target]) =>
          `      ${alias}:\n        specifier: workspace:*\n        version: link:${relative(join(dir, id), join(dir, target))}\n`,
      ),
    ];
    lockImporters.push(
      lines.length === 0
        ? `  ${id}: {}\n`
        : `  ${id}:\n    dependencies:\n${lines.join('')}`,
    );
  }
  await writeFile(
    join(dir, 'pnpm-workspace.yaml'),
    'packages:\n  - "packages/*"\n',
  );
  await writeFile(
    join(dir, 'pnpm-lock.yaml'),
    `lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\nimporters:\n\n${lockImporters.join('\n')}\npackages:\n\n${packages.join('\n')}\nsnapshots:\n\n${snapshots.join('\n')}`,
  );
  const fetcher = (async (input: string | URL | Request) => {
    const body = archives.get(
      typeof input === 'string' ? input : String(input),
    );
    return body === undefined
      ? new Response(null, { status: 404 })
      : new Response(body);
  }) as typeof fetch;
  const c = capture();
  const code = await runOpm(['ci', '--path', dir], c.io, '/', {
    fetch: fetcher,
  });
  expect(code, c.err).toBe(EXIT_CODES.success);
  return dir;
}

/** What `opm run build` prints in `member` (`''` for the project). */
async function build(dir: string, member: string): Promise<string> {
  const ran = await go('run', ['build'], join(dir, member));
  expect(ran.status, ran.err).toBe(0);
  return ran.out.trim().split('\n').at(-1)!;
}

posix("each importer's own executable", () => {
  it("runs a member's tool, shared at the project, over the project's tool of the same name", async () => {
    const dir = await installed(
      [tool('esbuild', 'esbuild'), tool('esbuild-wasm', 'esbuild')],
      { '.': 'esbuild', 'packages/wasm': 'esbuild-wasm' },
    );
    expect(await build(dir, 'packages/wasm')).toBe('I am esbuild-wasm');
    expect(await build(dir, '')).toBe('I am esbuild');
    const exec = await go('exec', ['esbuild'], join(dir, 'packages/wasm'));
    expect(exec.status, exec.err).toBe(0);
    expect(exec.out.trim()).toBe('I am esbuild-wasm');
  });

  it('runs each member its own tool when two members have tools of one name', async () => {
    const dir = await installed(
      [tool('npm-run-all', 'run-p'), tool('npm-run-all2', 'run-p')],
      {
        '.': undefined,
        'packages/a': 'npm-run-all',
        'packages/b': 'npm-run-all2',
      },
    );
    expect(await build(dir, 'packages/a')).toBe('I am npm-run-all');
    expect(await build(dir, 'packages/b')).toBe('I am npm-run-all2');
  });

  it("keeps the project's own tool when a member's tool of the same name sorts first", async () => {
    const dir = await installed(
      [tool('esbuild', 'esbuild'), tool('esbuild-wasm', 'esbuild')],
      { '.': 'esbuild-wasm', 'packages/native': 'esbuild' },
    );
    expect(await build(dir, '')).toBe('I am esbuild-wasm');
    expect(await build(dir, 'packages/native')).toBe('I am esbuild');
  });
});

posix("a member's own executable", () => {
  it("is not offered to the project's .bin, where the project's own dependency keeps the name", async () => {
    // `aaa` sorts before `esbuild`, which used to decide who kept the name.
    const dir = await installed([tool('esbuild', 'esbuild')], {
      '.': 'esbuild',
      'packages/aaa': { bin: { esbuild: 'bin.js' } },
    });
    expect(await build(dir, '')).toBe('I am esbuild');
    expect(await readdir(join(dir, 'node_modules/.bin'))).toEqual(['esbuild']);
  });

  it('goes to the .bin of the importer that links the member, and only there', async () => {
    const dir = await installed([tool('pad', 'pad')], {
      '.': 'pad',
      'packages/a': { links: { b: 'packages/b' }, build: 'tool' },
      'packages/b': { bin: { tool: 'bin.js' } },
      'packages/c': undefined,
    });
    expect(await build(dir, 'packages/a')).toBe('I am the member b (tool)');
    expect(await readdir(join(dir, 'packages/a/node_modules/.bin'))).toEqual([
      'tool',
    ]);
    // Not the project's, not the member's own, not another member's.
    expect(await readdir(join(dir, 'node_modules/.bin'))).toEqual(['pad']);
    for (const member of ['packages/b', 'packages/c'])
      expect(
        await readdir(join(dir, member, 'node_modules/.bin')).catch(() => []),
      ).toEqual([]);
  });

  it("is in the project's .bin when the project links it", async () => {
    const dir = await installed([tool('pad', 'pad')], {
      '.': { links: { b: 'packages/b' }, build: 'tool' },
      'packages/b': { bin: { tool: 'bin.js' } },
      'packages/c': 'pad',
    });
    expect(await build(dir, '')).toBe('I am the member b (tool)');
    // Beside `pad`, which `packages/c` needs and is written at the project.
    expect(await readdir(join(dir, 'node_modules/.bin'))).toEqual([
      'pad',
      'tool',
    ]);
  });

  it("leaves a member's own dependencies' executables in its own .bin beside a linked member's", async () => {
    const dir = await installed([tool('esbuild', 'esbuild')], {
      '.': 'esbuild',
      'packages/a': {
        tool: 'esbuild',
        links: { b: 'packages/b' },
        build: 'esbuild && tool',
      },
      'packages/b': { bin: { tool: 'bin.js' } },
    });
    expect(
      (await readdir(join(dir, 'packages/a/node_modules/.bin'))).sort(),
    ).toEqual(['esbuild', 'tool']);
    const ran = await go('run', ['build'], join(dir, 'packages/a'));
    expect(ran.status, ran.err).toBe(0);
    expect(ran.out.trim().split('\n').slice(-2)).toEqual([
      'I am esbuild',
      'I am the member b (tool)',
    ]);
  });

  it('outranks the executable of a transitive dependency of the same name, hoisted beside it at the project', async () => {
    // `deep` sorts before `zed`, which decides when neither is direct.
    const dir = await installed(
      [tool('viax', 'vx', ['deep']), tool('deep', 'tool')],
      {
        '.': { tool: 'viax', links: { zed: 'packages/zed' }, build: 'tool' },
        'packages/zed': { bin: { tool: 'bin.js' } },
      },
    );
    expect(await build(dir, '')).toBe('I am the member zed (tool)');
  });

  it('is kept, between two linked members that declare one name, by the member whose name sorts first', async () => {
    const dir = await installed([tool('pad', 'pad')], {
      '.': {
        links: { aaa: 'packages/aaa', bbb: 'packages/bbb' },
        build: 'tool',
      },
      'packages/aaa': { bin: { tool: 'bin.js' } },
      'packages/bbb': { bin: { tool: 'bin.js' } },
      'packages/c': 'pad',
    });
    expect(await build(dir, '')).toBe('I am the member aaa (tool)');
  });
});
