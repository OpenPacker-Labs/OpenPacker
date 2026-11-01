/**
 * The command lines of five repositories (HoBo, ai-bdd, ts-autocode, gitlang,
 * OpenSesame) that call pnpm, npm or npx, counted by form, and what opm does
 * with each (docs/guides/opm.md has the table, ADR 0053 the reasons). A form
 * that occurs is read here the way the process entry reads it, so a change
 * that turns one of them into a usage error fails this file.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { COMMANDS } from '../src/commands/command-names.js';
import { parseExecRequest, parseRunRequest } from '../src/commands/run-args.js';
import { routeRun } from '../src/commands/run-route.js';
import { runOpm } from '../src/opm.js';
import { capture, makeProject } from './run-fixture.js';
import { makeWorkspace } from './workspace-fixture.js';

interface Form {
  form: string;
  kind: 'supported' | 'redirected' | 'other' | 'refused';
  count?: number;
  repos?: Record<string, number>;
  opm?: string;
  argvs?: string[][];
  argv?: string[];
  status?: number;
  message?: string;
}

const fixture = JSON.parse(
  readFileSync(
    new URL('./fixtures/workspace-run-forms.json', import.meta.url),
    'utf8',
  ),
) as { occurring: Form[]; defined: Form[] };

const argvsOf = (form: Form): string[][] =>
  form.argvs ?? (form.argv === undefined ? [] : [form.argv]);

/** A project that has a script for every word the forms put where a command goes. */
async function projectFor(forms: Form[]) {
  const scripts: Record<string, string> = {};
  for (const form of forms)
    for (const argv of argvsOf(form)) {
      const first = argv[0];
      if (
        first !== undefined &&
        !first.startsWith('-') &&
        first !== 'run' &&
        first !== 'exec'
      )
        scripts[first] = 'true';
    }
  return await makeProject({ scripts });
}

async function readsAsOpm(argv: string[], cwd: string): Promise<string> {
  const routed = await routeRun(argv, cwd);
  expect(routed, argv.join(' ')).toBeDefined();
  const request =
    routed!.command === 'run'
      ? parseRunRequest([], routed!.rest)
      : parseExecRequest([], routed!.rest);
  expect(request, argv.join(' ')).toBeDefined();
  return routed!.command;
}

describe('the forms that occur', () => {
  it('are all counted: 482 command lines in 34 forms', () => {
    expect(fixture.occurring).toHaveLength(34);
    expect(
      fixture.occurring.reduce((n, form) => n + (form.count ?? 0), 0),
    ).toBe(482);
  });

  it('are none refused: what is not supported is another command, or an npx/dlx pointed at opm exec and opmx', () => {
    expect(fixture.occurring.filter((form) => form.kind === 'refused')).toEqual(
      [],
    );
  });

  it('read as run or exec, every supported form, each argument list as it occurs', async () => {
    const forms = fixture.occurring.filter((form) => form.kind === 'supported');
    const root = await projectFor(forms);
    let read = 0;
    for (const form of forms)
      for (const argv of argvsOf(form)) {
        await readsAsOpm(argv, root);
        read += 1;
      }
    // Every form was read at least once, none was skipped for having no arguments.
    expect(read).toBeGreaterThanOrEqual(forms.length);
  });

  it('keep the command each supported form names: pnpm exec is exec, run and a script word are run', async () => {
    const forms = fixture.occurring.filter((form) => form.kind === 'supported');
    const root = await projectFor(forms);
    for (const form of forms)
      for (const argv of argvsOf(form)) {
        const command = await readsAsOpm(argv, root);
        const execs = form.form.includes(' exec ');
        if (execs) expect(command, form.form).toBe('exec');
        else expect(command, form.form).toBe('run');
      }
  });

  it('have an opm command of their own when they are another command', () => {
    for (const form of fixture.occurring.filter((f) => f.kind === 'other')) {
      const named = /^opm ([a-z]+)/u.exec(form.opm ?? '')?.[1];
      if (named !== undefined)
        expect(COMMANDS.has(named), form.form).toBe(true);
    }
  });
});

describe('the forms pnpm and npm define that these repositories do not use', () => {
  it('read as run or exec when they are supported', async () => {
    const forms = fixture.defined.filter((form) => form.kind === 'supported');
    const root = await projectFor(forms);
    for (const form of forms)
      for (const argv of argvsOf(form)) await readsAsOpm(argv, root);
  });

  it.each(fixture.defined.filter((form) => form.kind !== 'supported'))(
    '$form is answered with exit $status and "$message"',
    async (form) => {
      const ws = await makeWorkspace({
        'packages/a': { name: 'a', scripts: { build: 'true' } },
        'packages/b': { name: 'b', scripts: { build: 'true' } },
      });
      const cap = capture();
      const status = await runOpm(form.argv ?? [], cap.io, ws.root);
      expect(status, cap.err).toBe(form.status);
      expect(cap.err).toContain(form.message);
    },
  );
});
