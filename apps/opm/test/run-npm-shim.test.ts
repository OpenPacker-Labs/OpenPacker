/**
 * A script that calls `npm run <x>` (or `npm test`, `pnpm <x>`, `yarn <x>`)
 * inside `opm run` gets opm, not npm (ADR 0061): the shims in
 * `apps/opm/shims/bin` lead the script's PATH and route the run back into
 * `opm run`; npm's other commands are refused, naming opm's.
 *
 * Every run here has a PATH with no npm, pnpm, yarn or node on it at all, so
 * nothing but the shims can answer. The shims start `dist/shims/*.js`: run
 * `npm run build -w @openpacker/opm` first.
 */
import { mkdir, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseRunRequest } from '../src/commands/run-args.js';
import {
  processContext,
  runScriptCommand,
  type RunContext,
} from '../src/commands/run.js';
import { capture, makeProject } from './run-fixture.js';
import { makeWorkspace } from './workspace-fixture.js';

const appRoot = join(import.meta.dirname, '..');

/** No package manager and no node: only the shims can answer `npm`. */
function bare(env: Record<string, string> = {}): RunContext {
  return { ...processContext(), env: { PATH: '/nonexistent', ...env } };
}

async function run(
  scripts: Record<string, string>,
  script = 'a',
  where?: string,
): Promise<{ status: number; out: string; err: string; root: string }> {
  const root = where ?? (await makeProject({ name: 'app', scripts }));
  const cap = capture();
  const status = await runScriptCommand(
    parseRunRequest([], ['--path', root, script]),
    cap.io,
    root,
    bare(),
  );
  return { status, out: cap.out, err: cap.err, root };
}

const posix = describe.skipIf(process.platform === 'win32');

posix('npm inside opm run', () => {
  it('runs `npm run b` as opm run b: no banner, opm sets the names', async () => {
    const ran = await run({
      a: 'npm run b',
      b: 'echo "b ran: $npm_lifecycle_event $npm_package_name"',
    });
    expect(ran.err).toBe('');
    expect(ran.status).toBe(0);
    expect(ran.out).toBe('b ran: b app\n');
  });

  it('routes npm to opm though a real npm is on the inherited PATH', async () => {
    const root = await makeProject({
      name: 'app',
      scripts: { a: 'npm run b', b: 'echo "b ran: $npm_execpath"' },
    });
    const cap = capture();
    const status = await runScriptCommand(
      parseRunRequest([], ['--path', root, 'a']),
      cap.io,
      root,
      { ...processContext(), env: { PATH: process.env.PATH ?? '' } },
    );
    expect(cap.err).toBe('');
    expect(status).toBe(0);
    expect(cap.out).toBe(
      `b ran: ${join(appRoot, 'dist', 'shims', 'npm.js')}\n`,
    );
  });

  it('runs `npm test` with its pre and post hooks', async () => {
    const ran = await run({
      a: 'npm test && npm t',
      pretest: 'echo pre',
      test: 'echo test',
      posttest: 'echo post',
    });
    expect(ran.err).toBe('');
    expect(ran.out).toBe('pre\ntest\npost\npre\ntest\npost\n');
  });

  it('passes what follows -- to the script, and what follows its name', async () => {
    const ran = await run({
      a: 'npm run x -- --flag && npm run x one -- --two "three four"',
      x: 'echo x-args',
    });
    expect(ran.err).toBe('');
    expect(ran.out).toBe('x-args --flag\nx-args one --two three four\n');
  });

  it('takes --if-present: a missing script is a success that runs nothing', async () => {
    const ran = await run({
      a: 'npm run missing --if-present && npm run --if-present missing && echo after',
    });
    expect(ran.err).toBe('');
    expect(ran.status).toBe(0);
    expect(ran.out).toBe('after\n');
  });

  it('exits 4 for a missing script, as opm run does', async () => {
    const ran = await run({ a: 'npm run missing' });
    expect(ran.status).toBe(4);
    expect(ran.err).toContain('No script "missing"');
  });

  it("runs the script of the package.json nearest the script's directory, as npm does", async () => {
    const root = await makeProject({
      name: 'app',
      scripts: { a: 'cd sub/deeper && npm run c', c: 'echo root-c' },
    });
    await mkdir(join(root, 'sub', 'deeper'), { recursive: true });
    await writeFile(
      join(root, 'sub', 'package.json'),
      JSON.stringify({ name: 'sub', scripts: { c: 'echo sub-c' } }),
    );
    const ran = await run({}, 'a', root);
    expect(ran.err).toBe('');
    expect(ran.out).toBe('sub-c\n');
  });

  it('puts the shim first on PATH, before a project bin named npm, and in a nested run too', async () => {
    const root = await makeProject({
      name: 'app',
      scripts: { a: 'npm run b', b: 'npm run c', c: 'echo c ran' },
    });
    const fake = join(root, 'node_modules', '.bin', 'npm');
    await writeFile(fake, '#!/bin/sh\necho the project npm\n');
    await chmod(fake, 0o755);
    const ran = await run({}, 'a', root);
    expect(ran.err).toBe('');
    expect(ran.out).toBe('c ran\n');
  });

  it('sets npm_execpath to the shim, which Node starts as npm-run-all does', async () => {
    const ran = await run({
      a: 'echo "$npm_execpath" && "$npm_node_execpath" "$npm_execpath" run b',
      b: 'echo b ran',
    });
    expect(ran.err).toBe('');
    expect(ran.out).toBe(
      `${join(appRoot, 'dist', 'shims', 'npm.js')}\nb ran\n`,
    );
  });

  it('runs a workspace member with -w and --workspace', async () => {
    const ws = await makeWorkspace(
      {
        'packages/one': {
          name: 'one',
          version: '1.0.0',
          scripts: { build: 'echo one built' },
        },
        'packages/two': {
          name: 'two',
          version: '1.0.0',
          scripts: { build: 'echo two built' },
        },
      },
      {
        tool: 'npm',
        root: {
          scripts: {
            a: 'npm run build -w one && npm --workspace=packages/two run build',
          },
        },
      },
    );
    const ran = await run({}, 'a', ws.root);
    expect(ran.err).toBe('');
    expect(ran.status).toBe(0);
    expect(ran.out).toContain('one built');
    expect(ran.out).toContain('two built');
  });

  it('refuses `npm install`, naming what opm does instead', async () => {
    const ran = await run({ a: 'npm install left-pad' });
    expect(ran.status).toBe(2);
    expect(ran.err).toContain('npm install');
    expect(ran.err).toContain('opm ci');
    expect(ran.err).toContain('opm add');
  });

  it('refuses npm exec and an npm option opm does not read, rather than passing either on', async () => {
    const exec = await run({ a: 'npm exec tsc' });
    expect(exec.status).toBe(2);
    expect(exec.err).toContain('opm exec');
    const option = await run({ a: 'npm run b --watch', b: 'echo b' });
    expect(option.status).toBe(2);
    expect(option.err).toContain('--watch');
    expect(option.out).toBe('');
  });
});

posix('pnpm and yarn inside opm run', () => {
  it('runs `pnpm run b` and `pnpm b`, passing what follows the name as pnpm does', async () => {
    const ran = await run({
      a: 'pnpm run b one --two && pnpm b -- three && pnpm --silent run b',
      b: 'echo b-args',
    });
    expect(ran.err).toBe('');
    expect(ran.out).toBe('b-args one --two\nb-args -- three\nb-args\n');
  });

  it("runs pnpm's member selection", async () => {
    const ws = await makeWorkspace(
      {
        'packages/one': {
          name: 'one',
          version: '1.0.0',
          scripts: { build: 'echo one built' },
        },
      },
      { root: { scripts: { a: 'pnpm --filter one build' } } },
    );
    const ran = await run({}, 'a', ws.root);
    expect(ran.err).toBe('');
    expect(ran.out).toContain('one built');
  });

  it('refuses `pnpm install` and `pnpm dlx`, naming opm', async () => {
    const install = await run({ a: 'pnpm install' });
    expect(install.status).toBe(2);
    expect(install.err).toContain('opm ci');
    const dlx = await run({ a: 'pnpm dlx cowsay' });
    expect(dlx.status).toBe(2);
    expect(dlx.err).toContain('opmx');
  });

  it('runs `yarn b` and `yarn run b` with plain arguments', async () => {
    const ran = await run({
      a: 'yarn b one && yarn run b two',
      b: 'echo b-args',
    });
    expect(ran.err).toBe('');
    expect(ran.out).toBe('b-args one\nb-args two\n');
  });

  it('refuses yarn arguments its releases read differently, and yarn install', async () => {
    const dashes = await run({ a: 'yarn b -- --x', b: 'echo b' });
    expect(dashes.status).toBe(2);
    expect(dashes.err).toContain('yarn');
    expect(dashes.out).toBe('');
    const install = await run({ a: 'yarn' });
    expect(install.status).toBe(2);
    expect(install.err).toContain('opm ci');
  });
});
