import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { configureDefaultAdapters } from '@openpacker/adapters-default';
import type { EphemeralTool, ToolPackage } from '@openpacker/opm-project';
import { runTool } from '../src/opmx-spawn.js';

configureDefaultAdapters();

/**
 * A tool that runs one of its dependencies' executables by name, as npx gives
 * it the closure's `node_modules/.bin` on PATH. The sandbox's PATH is minimal
 * (/usr/bin, /bin and node's directory), so the name was not found.
 */

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function toolCache(): Promise<{ tool: EphemeralTool; work: string }> {
  const cacheRoot = await mkdtemp(join(tmpdir(), 'opmx-bin-path-'));
  temps.push(cacheRoot);
  const closure: ToolPackage[] = [];
  const put = async (name: string, files: Record<string, string>) => {
    const digest = (closure.length + 1).toString(16).padStart(64, '0');
    const storePath = join(cacheRoot, '.opm', 'store', `sha256-${digest}`);
    await mkdir(join(storePath, 'package'), { recursive: true });
    for (const [file, body] of Object.entries(files))
      await writeFile(join(storePath, 'package', file), body);
    closure.push({
      exactPurl: `pkg:npm/${name}@1.0.0`,
      digest: `sha256:${digest}`,
      size: 1,
      source: `https://registry.npmjs.org/${name}/-/${name}-1.0.0.tgz`,
      storePath,
    });
  };
  await put('runner', {
    'package.json': JSON.stringify({ name: 'runner', version: '1.0.0' }),
    'cli.js':
      "const { execFileSync } = require('node:child_process');\n" +
      "process.stdout.write(execFileSync('helper', ['ran'], { encoding: 'utf8' }));\n",
  });
  await put('helper', {
    'package.json': JSON.stringify({
      name: 'helper',
      version: '1.0.0',
      bin: { helper: 'bin.js' },
    }),
    'bin.js': "#!/usr/bin/env node\nconsole.log('helper', process.argv[2]);\n",
  });
  const work = join(cacheRoot, 'work');
  await mkdir(work);
  return {
    work,
    tool: {
      exactPurl: 'pkg:npm/runner@1.0.0',
      digest: closure[0]!.digest,
      storePath: closure[0]!.storePath,
      bins: [{ name: 'runner', path: 'package/cli.js' }],
      cached: true,
      runtimePaths: closure.map((pkg) => pkg.storePath),
      cacheRoot,
      closure,
    },
  };
}

const canSandbox =
  process.platform === 'linux' &&
  ['/usr/bin/bwrap', '/bin/bwrap'].some((path) => existsSync(path));

describe.runIf(canSandbox)('an npm tool that runs a dependency’s bin', () => {
  it('finds it on PATH, in its layout’s node_modules/.bin', async () => {
    const { tool, work } = await toolCache();
    let out = '';
    let err = '';
    const io = {
      stdout: { write: (chunk: string) => ((out += chunk), true) },
      stderr: { write: (chunk: string) => ((err += chunk), true) },
    };
    const code = await runTool(tool, tool.bins[0]!, [], io, work);
    expect([code, out, err]).toEqual([0, 'helper ran\n', '']);
  });
});

describe.skipIf(canSandbox)('an npm tool that runs a dependency’s bin', () => {
  it.skip('needs bwrap (/usr/bin/bwrap); not checked on this host', () => {});
});
