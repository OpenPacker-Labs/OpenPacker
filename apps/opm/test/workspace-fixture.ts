/**
 * A workspace on disk for the tests of `opm run` and `opm exec` across members.
 * Scripts call `trace.cjs`, which records when each member started and ended in
 * `log.txt` at the workspace root, so order and overlap are read from the log.
 */
import { EventEmitter } from 'node:events';
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, vi } from 'vitest';
import { processHost, type ChildHost } from '../src/commands/run-child.js';
import { processContext, runProjectCommand } from '../src/commands/run.js';
import type { RunContext } from '../src/commands/run-context.js';
import { addFakeTool, capture } from './run-fixture.js';

// The run commands load the workspace library on first use (ADR 0053 §18),
// which takes half a second on a quiet machine and many times that on a busy
// one. Load it once, before the first test's clock starts, and give a test that
// starts several processes room to finish on a machine other work is using.
vi.setConfig({ testTimeout: 30_000 });
beforeAll(async () => {
  await import('@openpacker/adapter-core');
  await import('@openpacker/opm-project');
}, 120_000);

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

export interface MemberSpec {
  name?: string | undefined;
  version?: string | undefined;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

export interface WorkspaceOptions {
  tool?: 'pnpm' | 'npm';
  /** Member patterns; `packages/*` by default. */
  patterns?: string[];
  root?: MemberSpec;
  /** Write opm.toml so the root is an opm project. */
  opm?: boolean;
}

/**
 * `node trace.cjs <id> [milliseconds] [exit code] [--wait=ids]`: log the
 * start, mark it with a file (both once SIGTERM is logged as `term`, so a
 * member told to end after its mark says so), wait until each id in the
 * comma-separated list has marked its own start (so a test can prove members
 * ran at the same time without a clock; a run that serialised them would wait
 * out the twenty seconds and fail), hold for the milliseconds, log the end and
 * exit.
 */
const TRACE = `
const fs = require('node:fs');
const path = require('node:path');
const argv = process.argv.slice(2);
const waitFor = (argv.find((a) => a.startsWith('--wait=')) ?? '').slice(7);
const [id, wait = '0', code = '0'] = argv.filter((a) => !a.startsWith('--wait='));
const dir = process.env.INIT_CWD;
const log = path.join(dir, 'log.txt');
const note = (what) => fs.appendFileSync(log, what + ' ' + id + ' ' + Date.now() + '\\n');
process.on('SIGTERM', () => { note('term'); process.exit(143); });
note('start');
fs.writeFileSync(path.join(dir, 'started-' + id), '');
const deadline = Date.now() + Number(process.env.TRACE_DEADLINE_MS ?? 20000);
const release = process.env.TRACE_RELEASE;
if (release !== undefined) {
  const nap = new Int32Array(new SharedArrayBuffer(4));
  while (!fs.existsSync(path.join(dir, release))) {
    if (Date.now() > deadline) { note('stuck'); process.exit(9); }
    Atomics.wait(nap, 0, 0, 5);
  }
}
const pending = () => waitFor.split(',').filter(Boolean).some((other) => !fs.existsSync(path.join(dir, 'started-' + other)));
const finish = () => { note('end'); process.exit(Number(code)); };
const poll = () => {
  if (pending()) {
    if (Date.now() > deadline) { note('stuck'); process.exit(9); }
    return setTimeout(poll, 10);
  }
  Number(wait) > 0 ? setTimeout(finish, Number(wait)) : finish();
};
poll();
`;

/**
 * `node steps.cjs <step...>`: say:<text> writes a line, touch:<name> makes a
 * file in INIT_CWD, wait:<name> waits for one, sleep:<ms> sleeps, and
 * saw:<name> records in `saw-<name>` whether that file exists at this moment
 * (`yes` or `no`). Two members that hand a file back and forth print in an
 * order no clock decides, and a member that `saw` the file a dependency
 * touches at its end proves it started after that end.
 */
const STEPS = `
const fs = require('node:fs');
const path = require('node:path');
const dir = process.env.INIT_CWD;
const steps = process.argv.slice(2);
const deadline = Date.now() + 20000;
const next = () => {
  const step = steps.shift();
  if (step === undefined) return;
  const at = step.indexOf(':');
  const [kind, arg] = [step.slice(0, at), step.slice(at + 1)];
  if (kind === 'say') fs.writeSync(1, arg + '\\n');
  else if (kind === 'err') fs.writeSync(2, arg + '\\n');
  else if (kind === 'touch') fs.writeFileSync(path.join(dir, arg), '');
  else if (kind === 'saw') fs.writeFileSync(path.join(dir, 'saw-' + arg), fs.existsSync(path.join(dir, arg)) ? 'yes' : 'no');
  else if (kind === 'sleep') return setTimeout(next, Number(arg));
  else if (kind === 'wait') {
    if (!fs.existsSync(path.join(dir, arg))) {
      if (Date.now() > deadline) process.exit(9);
      steps.unshift(step);
      return setTimeout(next, 10);
    }
  }
  next();
};
next();
`;

/** `node whoami.cjs`: print what a member's script sees, as JSON. */
const WHOAMI = `
console.log(JSON.stringify({
  cwd: process.cwd(),
  event: process.env.npm_lifecycle_event,
  name: process.env.npm_package_name,
  version: process.env.npm_package_version,
  initCwd: process.env.INIT_CWD,
  path: (process.env.PATH ?? '').split(require('node:path').delimiter).slice(0, 3),
}));
`;

export interface Workspace {
  root: string;
  /** Lines of log.txt as `[what, id, time]`. */
  log(): Promise<[string, string, number][]>;
}

export async function makeWorkspace(
  members: Record<string, MemberSpec>,
  options: WorkspaceOptions = {},
): Promise<Workspace> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'opm-ws-')));
  temps.push(root);
  const tool = options.tool ?? 'pnpm';
  const patterns = options.patterns ?? ['packages/*'];
  const rootManifest: Record<string, unknown> = {
    name: 'root',
    version: '1.0.0',
    private: true,
    scripts: {},
    ...options.root,
  };
  if (tool === 'npm') rootManifest.workspaces = patterns;
  else
    await writeFile(
      join(root, 'pnpm-workspace.yaml'),
      `packages:\n${patterns.map((p) => `  - '${p}'`).join('\n')}\n`,
    );
  await writeFile(join(root, 'package.json'), JSON.stringify(rootManifest));
  for (const [dir, spec] of Object.entries(members)) {
    await mkdir(join(root, dir), { recursive: true });
    await writeFile(join(root, dir, 'package.json'), JSON.stringify(spec));
  }
  await writeFile(join(root, 'trace.cjs'), TRACE);
  await writeFile(join(root, 'steps.cjs'), STEPS);
  await writeFile(join(root, 'whoami.cjs'), WHOAMI);
  await addFakeTool(join(root, 'node_modules'));
  await chmod(join(root, 'node_modules', '.bin', 'fake-tool'), 0o755);
  if (options.opm === true)
    await writeFile(
      join(root, 'opm.toml'),
      '[project]\nname = "fixture"\necosystems = ["npm"]\n',
    );
  return {
    root,
    log: async () => {
      const { readFile } = await import('node:fs/promises');
      try {
        return (await readFile(join(root, 'log.txt'), 'utf8'))
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            const [what, id, time] = line.split(' ');
            return [what!, id!, Number(time)] as [string, string, number];
          });
      } catch {
        return [];
      }
    },
  };
}

/** `trace` as a script body: log member `id`, wait for the members in `after` to have started, hold `ms`, exit `code`. */
export function trace(
  id: string,
  ms = 0,
  code = 0,
  waitFor: readonly string[] = [],
): string {
  const wait = waitFor.length === 0 ? '' : ` --wait=${waitFor.join(',')}`;
  return `node "$INIT_CWD/trace.cjs" ${id} ${ms} ${code}${wait}`;
}

/** `steps` as a script body: see steps.cjs. */
export function steps(...list: string[]): string {
  return `node "$INIT_CWD/steps.cjs" ${list.map((step) => `'${step}'`).join(' ')}`;
}

/** The ids that started, in order. */
export function started(log: [string, string, number][]): string[] {
  return log.filter(([what]) => what === 'start').map(([, id]) => id);
}

/** The most members whose [start, end] intervals overlap. */
export function peakOverlap(log: [string, string, number][]): number {
  const events = log
    .filter(([what]) => what === 'start' || what === 'end')
    .map(([what, , time]) => ({ delta: what === 'start' ? 1 : -1, time }))
    .sort((a, b) => a.time - b.time || a.delta - b.delta);
  let live = 0;
  let peak = 0;
  for (const event of events) {
    live += event.delta;
    peak = Math.max(peak, live);
  }
  return peak;
}

/** The process's context with `INIT_CWD` removed (npm sets it for the test run) and `env` added. */
export function contextWith(
  env: Record<string, string | undefined> = {},
  over: Partial<RunContext> = {},
): RunContext {
  const base: Record<string, string | undefined> = { ...process.env };
  delete base.INIT_CWD;
  return { ...processContext(), env: { ...base, ...env }, ...over };
}

export interface Ran {
  status: number;
  out: string;
  err: string;
}

/** Run `opm <command> ...argv` in `root` the way the entry does, and collect what it printed. */
export async function go(
  command: 'run' | 'exec',
  argv: string[],
  root: string,
  context: RunContext = contextWith(),
): Promise<Ran> {
  const cap = capture();
  try {
    const status = await runProjectCommand(
      command,
      [],
      argv,
      cap.io,
      root,
      context,
    );
    return { status, out: cap.out, err: cap.err };
  } catch (error) {
    const { handleError } = await import('../src/opm.js');
    const status = handleError(error, cap.io);
    return { status, out: cap.out, err: cap.err };
  }
}

/** A host with no terminal whose signals the test sends. */
export function hostWithSignals() {
  const signals = new EventEmitter();
  const host: ChildHost = {
    ...processHost,
    hasTerminal: false,
    onSignal(signal, listener) {
      signals.on(signal, listener);
      return () => {
        signals.off(signal, listener);
      };
    },
  };
  return { host, signals };
}

/** Poll until `condition` holds; the budget is generous because it is only spent when something is wrong. */
export async function until(
  condition: () => Promise<boolean>,
  ms = 20_000,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
