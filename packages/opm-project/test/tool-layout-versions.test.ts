import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { configureDefaultAdapters } from '@openpacker/adapters-default';
import {
  ephemeralNodeRun,
  layOutTool,
  type ToolPackage,
} from '../src/index.js';
import { OWNER_FILE } from '../src/owner-file.js';

configureDefaultAdapters();

/**
 * A tool's closure can hold two versions of one name: the tool wants `shared@2`
 * and its dependency `lib` wants `shared@1`. Node finds the right one only when
 * the layout nests `shared@1` under `lib`, and the layout can only do that when
 * it is told which package requires which (ADR 0054). Told nothing, it keeps
 * one version of the name and leaves the other out.
 */

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function closureWithTwoVersions(): Promise<{
  cacheRoot: string;
  closure: ToolPackage[];
}> {
  const cacheRoot = await mkdtemp(join(tmpdir(), 'opm-tool-versions-'));
  roots.push(cacheRoot);
  const closure: ToolPackage[] = [];
  const put = async (
    name: string,
    version: string,
    files: Record<string, string>,
    requires: Record<string, string>,
  ) => {
    const digest = (closure.length + 1).toString(16).padStart(64, '0');
    const storePath = join(cacheRoot, '.opm', 'store', `sha256-${digest}`);
    await mkdir(join(storePath, 'package'), { recursive: true });
    await writeFile(
      join(storePath, 'package', 'package.json'),
      JSON.stringify({ name, version, main: 'index.js' }),
    );
    for (const [file, body] of Object.entries(files))
      await writeFile(join(storePath, 'package', file), body);
    closure.push({
      exactPurl: `pkg:npm/${name}@${version}`,
      digest: `sha256:${digest}`,
      size: 1,
      source: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
      storePath,
      requires,
    });
  };
  await put(
    'tool',
    '1.0.0',
    {
      'cli.js': `console.log(require('shared'), require('lib'), require('two'));\n`,
    },
    {
      shared: 'pkg:npm/shared@2.0.0',
      lib: 'pkg:npm/lib@1.0.0',
      // A dependency asked for under a name of its own (`two@npm:shared@2`).
      two: 'pkg:npm/shared@2.0.0',
    },
  );
  await put(
    'lib',
    '1.0.0',
    { 'index.js': `module.exports = 'lib uses ' + require('shared');\n` },
    { shared: 'pkg:npm/shared@1.0.0' },
  );
  for (const version of ['1.0.0', '2.0.0'])
    await put(
      'shared',
      version,
      { 'index.js': `module.exports = 'shared@${version}';\n` },
      {},
    );
  return { cacheRoot, closure };
}

describe('a tool whose closure holds two versions of one name', () => {
  it('finds the version each package was solved to', async () => {
    const { cacheRoot, closure } = await closureWithTwoVersions();
    const layout = await layOutTool({
      cacheRoot,
      tool: 'pkg:npm/tool@1.0.0',
      closure,
    });
    try {
      const { stdout } = await promisify(execFile)(process.execPath, [
        layout.entry('package/cli.js'),
      ]);
      expect(stdout).toBe('shared@2.0.0 lib uses shared@1.0.0 shared@2.0.0\n');
    } finally {
      await layout.dispose();
    }
  });
});

describe('what the sandbox binds for a tool', () => {
  // opmx binds the layout's root and nothing beside it (`runtimePaths` in
  // apps/openpacker-cli's opmx-spawn.ts), so that root is the `tree` of the run's scratch
  // directory: the `.owner` beside it says who made the run, and a tool that
  // could see it, or write one, could take part in judging its own run.
  it('is the tree of the run scratch, which does not hold its owner', async () => {
    const { cacheRoot, closure } = await closureWithTwoVersions();
    const tool = { exactPurl: 'pkg:npm/tool@1.0.0', cacheRoot, closure };
    const layout = await layOutTool({
      cacheRoot,
      tool: tool.exactPurl,
      closure,
    });
    const run = await ephemeralNodeRun(tool, {
      name: 'tool',
      path: 'package/cli.js',
    });
    try {
      for (const root of [layout.root, run!.root]) {
        expect(basename(root)).toBe('tree');
        expect(await readdir(root)).not.toContain(OWNER_FILE);
        expect((await readdir(dirname(root))).sort()).toEqual([
          OWNER_FILE,
          'tree',
        ]);
      }
    } finally {
      await layout.dispose();
      await run?.dispose();
    }
  });
});

describe('which ephemeral bins run from a layout', () => {
  it('lays out a Node script, whether or not it names node', async () => {
    const { cacheRoot, closure } = await closureWithTwoVersions();
    const tool = { exactPurl: 'pkg:npm/tool@1.0.0', cacheRoot, closure };
    for (const interpreter of [undefined, 'node'] as const) {
      const run = await ephemeralNodeRun(tool, {
        name: 'tool',
        path: 'package/cli.js',
        ...(interpreter && { interpreter }),
      });
      expect(run?.bin.path).toBe('node_modules/tool/cli.js');
      await run?.dispose();
    }
    expect(
      await ephemeralNodeRun(tool, {
        name: 'tool',
        path: 'package/cli.js',
        interpreter: 'native',
      }),
    ).toBeUndefined();
  });
});

describe('a tool whose tree is not wrapped in a directory', () => {
  // npm strips the one directory a tarball wraps its files in; a tree whose
  // only entry is a file has none, and the layout writer keeps it whole.
  it('runs its bin from where the layout put it', async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), 'opm-tool-unwrapped-'));
    roots.push(cacheRoot);
    const storePath = join(
      cacheRoot,
      '.opm',
      'store',
      `sha256-${'1'.repeat(64)}`,
    );
    await mkdir(storePath, { recursive: true });
    await writeFile(join(storePath, 'cli.js'), "console.log('unwrapped');\n");
    const layout = await layOutTool({
      cacheRoot,
      tool: 'pkg:npm/bare@1.0.0',
      closure: [
        {
          exactPurl: 'pkg:npm/bare@1.0.0',
          digest: `sha256:${'1'.repeat(64)}`,
          size: 1,
          source: 'https://registry.npmjs.org/bare/-/bare-1.0.0.tgz',
          storePath,
        },
      ],
    });
    try {
      expect(layout.relative('cli.js')).toBe('node_modules/bare/cli.js');
      const { stdout } = await promisify(execFile)(process.execPath, [
        layout.entry('cli.js'),
      ]);
      expect(stdout).toBe('unwrapped\n');
    } finally {
      await layout.dispose();
    }
  });
});

describe('a tool whose tarball holds a directory with no file beside its package', () => {
  // npm strips the first path component of every entry, so such a directory
  // installs nothing: the tool's files are node_modules/<name>/, as for any
  // tarball, and a path inside the store tree drops package/ as the layout did.
  it('runs its bin from node_modules/<name>/, with the package.json beside it', async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), 'opm-tool-empty-dir-'));
    roots.push(cacheRoot);
    const storePath = join(
      cacheRoot,
      '.opm',
      'store',
      `sha256-${'2'.repeat(64)}`,
    );
    await mkdir(join(storePath, 'package'), { recursive: true });
    await mkdir(join(storePath, 'other', 'deeper'), { recursive: true });
    await writeFile(
      join(storePath, 'package', 'package.json'),
      JSON.stringify({ name: 'spare', version: '1.0.0' }),
    );
    await writeFile(
      join(storePath, 'package', 'cli.js'),
      "console.log(require('./package.json').name);\n",
    );
    const layout = await layOutTool({
      cacheRoot,
      tool: 'pkg:npm/spare@1.0.0',
      closure: [
        {
          exactPurl: 'pkg:npm/spare@1.0.0',
          digest: `sha256:${'2'.repeat(64)}`,
          size: 1,
          source: 'https://registry.npmjs.org/spare/-/spare-1.0.0.tgz',
          storePath,
        },
      ],
    });
    try {
      expect(layout.relative('package/cli.js')).toBe(
        'node_modules/spare/cli.js',
      );
      expect(
        await readdir(join(layout.root, 'node_modules', 'spare')),
      ).not.toContain('package');
      const { stdout } = await promisify(execFile)(process.execPath, [
        layout.entry('package/cli.js'),
      ]);
      expect(stdout).toBe('spare\n');
    } finally {
      await layout.dispose();
    }
  });
});
