/**
 * A workspace on disk for the tests of `opm run` and `opm exec` across members.
 * Scripts call `trace.cjs`, which records when each member started and ended in
 * `log.txt` at the workspace root, so order and overlap are read from the log.
 */
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
import { afterEach } from 'vitest';
import { processContext, runProjectCommand } from '../src/commands/run.js';
import type { RunContext } from '../src/commands/run-context.js';
import { addFakeTool, capture } from './run-fixture.js';

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

/** `node trace.cjs <id> [milliseconds] [exit code]`: log start, wait, log end, exit. */
const TRACE = `
const fs = require('node:fs');
const path = require('node:path');
const [id, wait = '0', code = '0'] = process.argv.slice(2);
const log = path.join(process.env.INIT_CWD, 'log.txt');
const note = (what) => fs.appendFileSync(log, what + ' ' + id + ' ' + Date.now() + '\\n');
note('start');
const finish = () => { note('end'); process.exit(Number(code)); };
process.on('SIGTERM', () => { note('term'); process.exit(143); });
Number(wait) > 0 ? setTimeout(finish, Number(wait)) : finish();
`;

/** `node say.cjs <text...>`: print each argument as a line, pausing between them. */
const SAY = `
const [pause, ...lines] = process.argv.slice(2);
let at = 0;
const next = () => {
  if (at >= lines.length) return;
  console.log(lines[at++]);
  setTimeout(next, Number(pause));
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
  await writeFile(join(root, 'say.cjs'), SAY);
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

/** `trace` as a script body: log member `id`, hold `ms`, exit `code`. */
export function trace(id: string, ms = 0, code = 0): string {
  return `node "$INIT_CWD/trace.cjs" ${id} ${ms} ${code}`;
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
