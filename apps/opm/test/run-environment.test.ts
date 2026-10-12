import { delimiter, dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runOpm } from '../src/opm.js';
import { parseRunRequest } from '../src/commands/run-args.js';
import {
  processContext,
  runScriptCommand,
  type RunContext,
} from '../src/commands/run.js';
import {
  capture,
  makeDirectory,
  makeProject,
  report,
  type ToolReport,
} from './run-fixture.js';

const MARKER = 'vtok_dummy_marker_0123456789abcdef';

/** A context with an environment the test owns, so nothing leaks in from npm. */
function context(env: Record<string, string> = {}): RunContext {
  return {
    ...processContext(),
    env: { PATH: process.env.PATH ?? '', ...env },
  };
}

describe('opm run: the environment', () => {
  async function envReport(
    root: string,
    cwd: string,
    event: string,
    env: Record<string, string> = {},
  ): Promise<ToolReport> {
    const cap = capture();
    const status = await runScriptCommand(
      parseRunRequest([], [event]),
      cap.io,
      cwd,
      context(env),
    );
    expect(status, cap.err).toBe(0);
    return report(cap.out);
  }

  it('sets the four names and puts every .bin directory first on PATH', async () => {
    const root = await makeProject({
      opm: true,
      name: '@scope/app',
      version: '1.2.3',
      scripts: { show: 'node node_modules/fake-tool/cli.js' },
    });
    const sub = await makeDirectory(root, 'src');
    const seen = await envReport(root, sub, 'show');
    expect(seen).toMatchObject({
      event: 'show',
      name: '@scope/app',
      version: '1.2.3',
      initCwd: sub,
    });
    const inherited = (process.env.PATH ?? '').split(delimiter);
    expect(seen.path.slice(0, 2)).toEqual([
      join(root, 'node_modules', '.bin'),
      join(dirname(root), 'node_modules', '.bin'),
    ]);
    expect(seen.path.slice(-inherited.length)).toEqual(inherited);
  });

  it('names the hook being run in npm_lifecycle_event', async () => {
    const root = await makeProject({
      scripts: {
        pretest: 'node node_modules/fake-tool/cli.js',
        test: 'node node_modules/fake-tool/cli.js',
        posttest: 'node node_modules/fake-tool/cli.js',
      },
    });
    const cap = capture();
    await runScriptCommand(
      parseRunRequest([], ['test']),
      cap.io,
      root,
      context(),
    );
    const events = cap.out
      .trim()
      .split('\n')
      .map((line) => (JSON.parse(line) as ToolReport).event);
    expect(events).toEqual(['pretest', 'test', 'posttest']);
  });

  it('passes the rest of the environment through untouched', async () => {
    const root = await makeProject({
      scripts: { show: 'node -e "console.log(process.env.OPM_TEST_PASSED)"' },
    });
    const cap = capture();
    await runScriptCommand(
      parseRunRequest([], ['show']),
      cap.io,
      root,
      context({ OPM_TEST_PASSED: 'kept' }),
    );
    expect(cap.out).toBe('kept\n');
  });

  it('never prints the environment, even when the script fails', async () => {
    const root = await makeProject({
      scripts: { fail: 'node fail.cjs 9' },
    });
    const cap = capture();
    const status = await runScriptCommand(
      parseRunRequest([], ['fail']),
      cap.io,
      root,
      context({ OPM_TEST_SECRET: MARKER }),
    );
    expect(status).toBe(9);
    expect(cap.out + cap.err).not.toContain(MARKER);
    const missing = capture();
    await runOpm(['run', 'missing'], missing.io, root);
    expect(missing.out + missing.err).not.toContain(MARKER);
  });
});

describe('opm run: it loads no plugin', () => {
  it('prints nothing about a broken plugin store, where other commands do', async () => {
    const root = await makeProject({
      opm: true,
      scripts: { ok: 'node mark.cjs ok' },
    });
    const previous = process.env.OPM_PLUGIN_HOME;
    process.env.OPM_PLUGIN_HOME = 'relative/plugin/home';
    try {
      const list = capture();
      await runOpm(['list'], list.io, root);
      expect(list.err).toContain('plugin store unavailable');
      const run = capture();
      expect(await runOpm(['run', 'ok'], run.io, root)).toBe(0);
      expect(run.err).toBe('');
    } finally {
      if (previous === undefined) delete process.env.OPM_PLUGIN_HOME;
      else process.env.OPM_PLUGIN_HOME = previous;
    }
  });
});

describe('opm --help', () => {
  it('lists run and exec and says they are not sandboxed', async () => {
    const cap = capture();
    expect(await runOpm(['--help'], cap.io, process.cwd())).toBe(0);
    expect(cap.out).toContain('opm run <script>');
    expect(cap.out).toContain('opm exec <bin>');
    expect(cap.out).toMatch(/not sandboxed/u);
    expect(cap.out).toMatch(/never run/u);
  });

  it('does not print the environment', async () => {
    const previous = process.env.OPM_TEST_SECRET;
    process.env.OPM_TEST_SECRET = MARKER;
    try {
      const cap = capture();
      await runOpm(['--help'], cap.io, process.cwd());
      await runOpm(['run', '--help'], cap.io, process.cwd());
      expect(cap.out + cap.err).not.toContain(MARKER);
    } finally {
      if (previous === undefined) delete process.env.OPM_TEST_SECRET;
      else process.env.OPM_TEST_SECRET = previous;
    }
  });

  it('shows the same text for opm run --help', async () => {
    const cap = capture();
    expect(await runOpm(['run', '--help'], cap.io, process.cwd())).toBe(0);
    expect(cap.out).toContain('opm exec <bin>');
  });
});
