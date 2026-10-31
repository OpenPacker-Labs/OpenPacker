import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { configureDefaultAdapters } from '@openpacker/adapters-default';
import { jailedPath, MAX_INHERITED_HANDLES } from '@openpacker/sandbox';
import {
  layOutTool,
  runSandboxedPackageProcess,
  type ToolPackage,
} from '../src/index.js';
import { storeViews } from '../src/store-view.js';

configureDefaultAdapters();

/**
 * A tool with a larger closure than 16 packages, as `opmx pkg:npm/cowsay hi`
 * has: it failed with "At most 16 valid handles may be inherited", because
 * every package of the closure was bound into the sandbox through a directory
 * handle of its own. And once past that, `require('yargs')` failed: nothing
 * laid the closure out where Node looks for it.
 */

const DEPENDENCIES = 20;

/** Handles left for store entries beside a working directory and a jail home. */
const ROOM = MAX_INHERITED_HANDLES - 2;

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

/** A tool cache holding `big-tool` and the 20 packages it requires. */
async function toolCache(): Promise<{
  cacheRoot: string;
  closure: ToolPackage[];
}> {
  const cacheRoot = await mkdtemp(join(tmpdir(), 'opm-tool-many-'));
  roots.push(cacheRoot);
  const closure: ToolPackage[] = [];
  const put = async (
    index: number,
    name: string,
    files: Record<string, string>,
  ) => {
    const storePath = join(
      cacheRoot,
      '.opm',
      'store',
      `sha256-${index.toString(16).padStart(64, '0')}`,
    );
    await mkdir(join(storePath, 'package'), { recursive: true });
    for (const [file, body] of Object.entries(files))
      await writeFile(join(storePath, 'package', file), body);
    closure.push({
      exactPurl: `pkg:npm/${name}@1.0.0`,
      digest: `sha256:${index.toString(16).padStart(64, '0')}`,
      size: 1,
      source: `https://registry.npmjs.org/${name}/-/${name}-1.0.0.tgz`,
      storePath,
    });
  };
  const names = Array.from({ length: DEPENDENCIES }, (_, i) => `dep-${i}`);
  await put(0, 'big-tool', {
    'package.json': JSON.stringify({
      name: 'big-tool',
      version: '1.0.0',
      bin: { 'big-tool': 'cli.js' },
    }),
    'cli.js': `const names = ${JSON.stringify(names)};\nconsole.log('ok', names.map((n) => require(n)).join(' '));\n`,
  });
  for (const [index, name] of names.entries())
    await put(index + 1, name, {
      'package.json': JSON.stringify({ name, version: '1.0.0' }),
      'index.js': `module.exports = ${JSON.stringify(name)};\n`,
    });
  return { cacheRoot, closure };
}

const canSandbox =
  process.platform === 'linux' &&
  ['/usr/bin/bwrap', '/bin/bwrap'].some((path) => existsSync(path));

describe.runIf(canSandbox)('a tool whose closure is 21 packages', () => {
  it('can bind every package of the closure into the sandbox', async () => {
    const { cacheRoot, closure } = await toolCache();
    // Each named where the jail has it.
    const read = `for (const p of ${JSON.stringify(
      closure.map((item) => jailedPath(item.storePath)),
    )}) console.log(require(p + '/package/package.json').name)`;
    const outcome = await runSandboxedPackageProcess({
      timeoutMs: 0,
      argv: [process.execPath, '-e', read],
      cwd: cacheRoot,
      storePaths: closure.map((item) => item.storePath),
    });
    expect(outcome.stderr).toBe('');
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout.trim().split('\n')).toHaveLength(DEPENDENCIES + 1);
  });

  it('runs with every dependency where Node looks for it', async () => {
    const { cacheRoot, closure } = await toolCache();
    const layout = await layOutTool({
      cacheRoot,
      tool: closure[0]!.exactPurl,
      closure,
    });
    try {
      const outcome = await runSandboxedPackageProcess({
        timeoutMs: 0,
        argv: [process.execPath, layout.entry('cli.js')],
        cwd: cacheRoot,
        storePaths: [layout.root],
      });
      expect(outcome.stderr).toBe('');
      expect(outcome.stdout).toBe(
        `ok ${Array.from({ length: DEPENDENCIES }, (_, i) => `dep-${i}`).join(' ')}\n`,
      );
    } finally {
      await layout.dispose();
    }
    expect(existsSync(layout.root)).toBe(false);
  });

  it('binds a closure that fits in the handles one entry at a time, as before', async () => {
    const { cacheRoot, closure } = await toolCache();
    const paths = closure.slice(0, ROOM).map((item) => item.storePath);
    const before = await directories(cacheRoot);
    const view = await storeViews(paths, ROOM);
    expect(view.readonlyPaths).toEqual(paths);
    expect(view.authorities).toEqual([]);
    expect(await directories(cacheRoot)).toEqual(before);
    await view.dispose();
  });

  it('refuses an entry that is a symbolic link, bound alone or with others', async () => {
    const { cacheRoot, closure } = await toolCache();
    const outside = await mkdtemp(join(tmpdir(), 'opm-tool-outside-'));
    roots.push(outside);
    await writeFile(join(outside, 'secret'), 'not a package\n');
    const linked = join(
      dirname(closure[0]!.storePath),
      `sha256-${'f'.repeat(64)}`,
    );
    await symlink(outside, linked);
    const run = (storePaths: string[]) =>
      runSandboxedPackageProcess({
        timeoutMs: 0,
        argv: [
          process.execPath,
          '-e',
          `process.stdout.write(require('fs').readFileSync(${JSON.stringify(
            join(linked, 'secret'),
          )}, 'utf8'))`,
        ],
        cwd: cacheRoot,
        storePaths,
      });
    await expect(run([linked])).rejects.toThrow();
    await expect(
      run([...closure.map((item) => item.storePath), linked]),
    ).rejects.toThrow();
  });
});

const here = dirname(fileURLToPath(import.meta.url));
const viteNode = join(here, '../../../node_modules/.bin/vite-node');
const source = (path: string) => JSON.stringify(join(here, path));

/** Every directory under `dir`, three levels down, relative to it. */
async function directories(dir: string, depth = 3): Promise<string[]> {
  if (depth === 0) return [];
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(dir, entry.name);
    found.push(relative(dir, path));
    for (const below of await directories(path, depth - 1))
      found.push(join(entry.name, below));
  }
  return found.sort();
}

/** A run that makes its store view and its layout, and is killed in them. */
async function killedInRun(cacheRoot: string, closure: ToolPackage[]) {
  const script = `${cacheRoot}-run.ts`;
  roots.push(script);
  await writeFile(
    script,
    `import { configureDefaultAdapters } from ${source('../../adapters-default/src/index.ts')};
     import { layOutTool } from ${source('../src/ephemeral-layout.ts')};
     import { storeViews } from ${source('../src/store-view.ts')};
     configureDefaultAdapters();
     const closure = ${JSON.stringify(closure)};
     await storeViews(closure.map((item) => item.storePath), ${ROOM});
     await layOutTool({ cacheRoot: ${JSON.stringify(cacheRoot)}, tool: closure[0].exactPurl, closure });
     process.kill(process.pid, 'SIGKILL');
    `,
  );
  const child = spawn(viteNode, [script], { stdio: 'ignore' });
  const signal = await new Promise<NodeJS.Signals | null>((resolve) =>
    child.on('exit', (_code, how) => resolve(how)),
  );
  expect(signal).toBe('SIGKILL');
}

describe.runIf(process.platform === 'linux')(
  'a run stopped before it removed what it made',
  () => {
    // A child under vite-node; a busy machine takes its time starting one.
    it(
      'is cleaned up by the next run in the same place',
      { timeout: 60_000 },
      async () => {
        const { cacheRoot, closure } = await toolCache();
        // A cache that has run the tool before.
        await (
          await layOutTool({ cacheRoot, tool: closure[0]!.exactPurl, closure })
        ).dispose();
        const before = await directories(cacheRoot);
        await killedInRun(cacheRoot, closure);
        expect(await directories(cacheRoot)).not.toEqual(before);

        const view = await storeViews(
          closure.map((item) => item.storePath),
          ROOM,
        );
        await view.dispose();
        const layout = await layOutTool({
          cacheRoot,
          tool: closure[0]!.exactPurl,
          closure,
        });
        await layout.dispose();
        expect(await directories(cacheRoot)).toEqual(before);
      },
    );

    it('leaves what a run still going has made', async () => {
      const { cacheRoot, closure } = await toolCache();
      const paths = closure.map((item) => item.storePath);
      const before = await directories(cacheRoot);
      const running = await storeViews(paths, ROOM);
      const during = await directories(cacheRoot);
      expect(during).not.toEqual(before);

      await (await storeViews(paths, ROOM)).dispose();
      expect(await directories(cacheRoot)).toEqual(during);
      await running.dispose();
      expect(await directories(cacheRoot)).toEqual(before);
    });
  },
);
