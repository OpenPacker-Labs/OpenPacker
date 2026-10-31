import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { solveToolClosure } from '../src/ephemeral-closure.js';
import { layOutTool, type ToolPackage } from '../src/index.js';
import {
  NpmRegistryFixture,
  type FixturePackage,
} from './npm-registry-fixture.js';

/**
 * A plugin's peer dependency is the copy its parent sees: the tool uses `host`
 * and `plugin`, which names `host` as a peer. The solve gives the plugin's peer
 * edge as it gives any other, and the layout must place the plugin where the
 * `host` it finds is the tool's own copy, the same module. (A peer name the
 * closure would need at two versions is refused by the solve: a peer is the
 * one release its dependent's parent sees, closure-edges.ts.)
 */

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

const files: Record<string, Record<string, string>> = {
  'pkg:npm/tool@1.0.0': {
    'cli.js':
      "const host = require('host');\n" +
      "console.log(host.version, require('plugin') === host);\n",
  },
  'pkg:npm/plugin@1.0.0': { 'index.js': "module.exports = require('host');\n" },
  'pkg:npm/host@2.0.0': { 'index.js': "exports.version = '2.0.0';\n" },
};

const registry: FixturePackage[] = [
  {
    name: 'tool',
    versions: {
      '1.0.0': { dependencies: { host: '^2.0.0', plugin: '1' } },
    },
  },
  {
    name: 'plugin',
    versions: { '1.0.0': { peerDependencies: { host: '>=1' } } },
  },
  { name: 'host', versions: { '1.0.0': {}, '2.0.0': {} } },
];

describe('a tool with a plugin that names a peer', () => {
  it('runs with the plugin seeing the tool’s own copy of the peer', async () => {
    const tool = 'pkg:npm/tool@1.0.0';
    const closure = await solveToolClosure({
      tool,
      ecosystem: 'npm',
      options: { transport: new NpmRegistryFixture(registry) },
    });
    expect(closure?.requires.get('pkg:npm/plugin@1.0.0')).toEqual({
      host: 'pkg:npm/host@2.0.0',
    });

    // The store trees materialiseExact would make, with the solve's edges.
    const cacheRoot = await mkdtemp(join(tmpdir(), 'opm-tool-peer-'));
    temps.push(cacheRoot);
    const packages: ToolPackage[] = [];
    for (const exactPurl of [
      tool,
      ...(closure?.dependencies.map((pkg) => pkg.exactPurl) ?? []),
    ]) {
      const digest = (packages.length + 1).toString(16).padStart(64, '0');
      const storePath = join(cacheRoot, '.opm', 'store', `sha256-${digest}`);
      const name = exactPurl.slice('pkg:npm/'.length).split('@')[0]!;
      const version = exactPurl.split('@')[1]!;
      await mkdir(join(storePath, 'package'), { recursive: true });
      await writeFile(
        join(storePath, 'package', 'package.json'),
        JSON.stringify({ name, version, main: 'index.js' }),
      );
      for (const [file, body] of Object.entries(files[exactPurl]!))
        await writeFile(join(storePath, 'package', file), body);
      packages.push({
        exactPurl,
        digest: `sha256:${digest}`,
        size: 1,
        source: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
        storePath,
        requires: closure?.requires.get(exactPurl) ?? {},
      });
    }
    const layout = await layOutTool({ cacheRoot, tool, closure: packages });
    try {
      const { stdout } = await promisify(execFile)(process.execPath, [
        layout.entry('package/cli.js'),
      ]);
      expect(stdout).toBe('2.0.0 true\n');
    } finally {
      await layout.dispose();
    }
  });
});
