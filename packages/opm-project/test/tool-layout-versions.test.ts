import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { configureDefaultAdapters } from '@openpacker/adapters-default';
import {
  ephemeralNodeRun,
  layOutTool,
  type ToolPackage,
} from '../src/index.js';

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
