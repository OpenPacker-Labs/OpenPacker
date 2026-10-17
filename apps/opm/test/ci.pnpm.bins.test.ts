/**
 * Whose executable a script runs after `opm ci` of a pnpm workspace (ADR 0055
 * §9). pnpm links each importer's direct dependencies' executables into that
 * importer's own `node_modules/.bin`, wherever the package was written, so a
 * member runs its own tool even when the tool is shared at the project, and
 * the project runs its own even when a member's tool of the same name sits
 * beside it.
 */

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

/** A package whose executable `bin` prints which package it is. */
const tool = (name: string, bin: string) => ({ name, bin });

/**
 * A pnpm workspace whose importers each need one tool and run it as `build`:
 * `importers` maps a directory (`.` for the project) to its tool, or none.
 */
async function installed(
  tools: readonly { name: string; bin: string }[],
  importers: Record<string, string | undefined>,
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'opm-ci-pnpm-bins-'));
  const store = await mkdtemp(join(tmpdir(), 'opm-ci-pnpm-bins-store-'));
  temps.push(dir, store);
  process.env.OPM_STORE_HOME = join(store, 'shared');
  const archives = new Map<string, Uint8Array>();
  const packages: string[] = [];
  const snapshots: string[] = [];
  const text = (value: string) => new TextEncoder().encode(value);
  for (const { name, bin } of tools) {
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
    snapshots.push(`  ${name}@1.0.0: {}\n`);
  }
  const lockImporters: string[] = [];
  for (const [id, need] of Object.entries(importers)) {
    const manifest = {
      name: id === '.' ? 'app' : id.split('/').at(-1),
      version: '1.0.0',
      scripts: { build: tools.find((t) => t.name === need)?.bin ?? 'true' },
      ...(need !== undefined && { dependencies: { [need]: '^1.0.0' } }),
    };
    await mkdir(join(dir, id), { recursive: true });
    await writeFile(join(dir, id, 'package.json'), JSON.stringify(manifest));
    lockImporters.push(
      need === undefined
        ? `  ${id}: {}\n`
        : `  ${id}:\n    dependencies:\n      ${need}:\n        specifier: ^1.0.0\n        version: 1.0.0\n`,
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
