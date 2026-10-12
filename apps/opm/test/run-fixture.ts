/**
 * A project on disk for `opm run` and `opm exec` tests, with a fake bin that
 * needs no network: `node_modules/.bin/fake-tool` runs
 * `node_modules/fake-tool/cli.js`, which prints what it was given as JSON.
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

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

export function capture() {
  let out = '';
  let err = '';
  return {
    io: {
      stdout: { write: (s: string) => ((out += s), true) },
      stderr: { write: (s: string) => ((err += s), true) },
    },
    get out() {
      return out;
    },
    get err() {
      return err;
    },
  };
}

/** What `cli.js` prints: its arguments, directory and the names `opm` sets. */
export interface ToolReport {
  argv: string[];
  cwd: string;
  event: string | undefined;
  name: string | undefined;
  version: string | undefined;
  initCwd: string | undefined;
  path: string[];
}

const CLI = `
const args = process.argv.slice(2);
const at = args.indexOf('--exit');
if (at !== -1) process.exit(Number(args[at + 1]));
const env = process.env;
console.log(JSON.stringify({
  argv: args,
  cwd: process.cwd(),
  event: env.npm_lifecycle_event,
  name: env.npm_package_name,
  version: env.npm_package_version,
  initCwd: env.INIT_CWD,
  path: (env.PATH ?? env.Path ?? '').split(require('node:path').delimiter),
}));
`;

const MARK = `
require('node:fs').appendFileSync('log.txt', process.argv[2] + '\\n');
`;

const FAIL = `
process.exit(Number(process.argv[2]));
`;

const KILL_SELF = `
process.kill(process.pid, 'SIGTERM');
setInterval(() => {}, 1000);
`;

export interface FixtureOptions {
  scripts?: Record<string, string> | undefined;
  name?: string | undefined;
  version?: string | undefined;
  /** Write no package.json at all. */
  noPackage?: boolean | undefined;
  /** Write opm.toml, making this directory an opm project root. */
  opm?: boolean | undefined;
}

export async function makeProject(
  options: FixtureOptions = {},
): Promise<string> {
  // realpath: a temporary directory may sit behind a symbolic link, and the
  // child reports the directory it really runs in.
  const root = await realpath(await mkdtemp(join(tmpdir(), 'opm-run-')));
  temps.push(root);
  if (options.noPackage !== true) {
    const manifest: Record<string, unknown> = {};
    if (options.name !== undefined) manifest.name = options.name;
    if (options.version !== undefined) manifest.version = options.version;
    manifest.scripts = options.scripts ?? {};
    await writeFile(join(root, 'package.json'), JSON.stringify(manifest));
  }
  if (options.opm === true)
    await writeFile(
      join(root, 'opm.toml'),
      '[project]\nname = "fixture"\necosystems = ["npm"]\n\n[options]\noffline = true\nlayout = "opm"\n',
    );
  await writeFile(join(root, 'mark.cjs'), MARK);
  await writeFile(join(root, 'fail.cjs'), FAIL);
  await writeFile(join(root, 'kill-self.cjs'), KILL_SELF);
  await addFakeTool(join(root, 'node_modules'));
  return root;
}

/** `fake-tool` in `<modules>/.bin`, a POSIX shim and a `.cmd` shim. */
export async function addFakeTool(modules: string): Promise<void> {
  await mkdir(join(modules, '.bin'), { recursive: true });
  await mkdir(join(modules, 'fake-tool'), { recursive: true });
  await writeFile(join(modules, 'fake-tool', 'cli.js'), CLI);
  const shim = join(modules, '.bin', 'fake-tool');
  await writeFile(
    shim,
    '#!/bin/sh\nexec node "$(dirname "$0")/../fake-tool/cli.js" "$@"\n',
  );
  await chmod(shim, 0o755);
  await writeFile(
    `${shim}.cmd`,
    '@ECHO off\r\nnode "%~dp0\\..\\fake-tool\\cli.js" %*\r\n',
  );
}

export function report(output: string): ToolReport {
  // SAFETY: cli.js prints exactly this shape.
  return JSON.parse(output.trim().split('\n').at(-1) ?? '{}') as ToolReport;
}

export async function makeDirectory(
  parent: string,
  name: string,
): Promise<string> {
  const directory = join(parent, name);
  await mkdir(directory, { recursive: true });
  return directory;
}
