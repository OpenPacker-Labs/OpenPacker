import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  lstat,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect } from 'vitest';
import {
  addPackage,
  initProject,
  projectPaths,
  readManifestFile,
  writeManifestFile,
} from '../src/index.js';
import { snapshotProject } from '../src/project-rollback.js';
import { permissive } from './closure-support.js';
import { NpmRegistryFixture } from './npm-registry-fixture.js';

/**
 * Projects, copies and child processes for the tests of a step that finishes
 * or leaves the project as it was (ADR 0056): rollback-recovery, the step
 * lock, the record a copy keeps, and every entry point that recovers.
 */

const here = dirname(fileURLToPath(import.meta.url));
export const viteNode = join(here, '../../../node_modules/.bin/vite-node');
export const sources = {
  rollback: join(here, '../src/project-rollback.ts'),
  index: join(here, '../src/index.ts'),
};

/** The fixture registry's packages: plain data, so a child process can build the same. */
export const REGISTRY_PACKAGES = [
  { name: 'base', versions: { '1.0.0': {}, '1.1.0': {} } },
  { name: 'other', versions: { '1.0.0': {} } },
  { name: 'third', versions: { '1.0.0': {} } },
  // Linking it needs node_modules/.bin to be a directory.
  {
    name: 'tool',
    versions: {
      '1.0.0': {
        bin: { 'tool-cli': 'cli.js' },
        files: { 'cli.js': '#!/usr/bin/env node\n' },
      },
    },
  },
];

export const registry = () => new NpmRegistryFixture(REGISTRY_PACKAGES);
export const transport = () => ({ transport: registry() });

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(
    temps.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
/** Removed after the test, with whatever is under it. */
export function temporary(path: string): string {
  temps.push(path);
  return path;
}

/** An npm project with `packages` added at 1.0.0. */
export async function project(
  packages: readonly string[] = ['base', 'other'],
): Promise<string> {
  const root = temporary(await mkdtemp(join(tmpdir(), 'opm-recovery-')));
  await initProject({ root, name: 'recovery' });
  const paths = projectPaths(root);
  const manifest = await readManifestFile(paths.manifest);
  manifest.project.ecosystems = ['npm'];
  manifest.options.nativeProjection = 'layout';
  manifest.policy = permissive;
  await writeManifestFile(paths.manifest, manifest);
  for (const name of packages)
    await addPackage({
      root,
      spec: `pkg:npm/${name}@1.0.0`,
      registryOptions: transport(),
    });
  return root;
}

/** Every entry under `dir`: its kind, and a file's bytes or a link's target. */
export async function tree(dir: string, into = new Map<string, string>()) {
  for (const name of (await readdir(dir).catch(() => [])).sort()) {
    const path = join(dir, name);
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) into.set(path, `link ${await readlink(path)}`);
    else if (stat.isDirectory()) {
      into.set(path, `dir ${stat.mode.toString(8)}`);
      await tree(path, into);
    } else
      into.set(
        path,
        `file ${stat.mode.toString(8)} ${createHash('sha256')
          .update(await readFile(path))
          .digest('hex')}`,
      );
  }
  return into;
}

/** What a step may change, as the tests compare it. */
export async function snapshot(root: string) {
  const read = (name: string) =>
    readFile(join(root, name), 'utf8').catch(() => '(absent)');
  return {
    manifest: await read('opm.toml'),
    lock: await read('opm.lock.json'),
    packageJson: await read('package.json'),
    state: await read('.opm/project.json'),
    native: await read('.opm/native.json'),
    environment: await read('.opm/environment.json'),
    nodeModules: [...(await tree(join(root, 'node_modules')))],
    opmBin: [...(await tree(join(root, '.opm', 'bin')))],
    links: [...(await tree(join(root, '.opm', 'links')))],
    generations: [...(await tree(join(root, '.opm', 'generations')))],
  };
}

export const copies = async (root: string) =>
  (await readdir(join(root, '.opm'))).filter((name) =>
    name.startsWith('.rollback-'),
  );

export const stepLocks = async (root: string) =>
  (await readdir(join(root, '.opm')).catch(() => [])).filter(
    (name) => name.startsWith('step-') && name.endsWith('.lock'),
  );

/** The id of a process that has exited. */
export async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise((resolve) => child.on('exit', resolve));
  return child.pid!;
}

export type Record_ = {
  state: string;
  owner: Record<string, unknown> & { pid: number };
  files: unknown[];
  trees: unknown[];
};

/** Rewrite the record of the copy `name`. */
export async function editRecord(
  root: string,
  name: string,
  edit: (record: Record_) => Record_ | void,
): Promise<void> {
  const path = join(root, '.opm', name, 'rollback.json');
  // SAFETY: a record the code under test wrote a moment ago.
  const record = JSON.parse(await readFile(path, 'utf8')) as Record_;
  await writeFile(path, JSON.stringify(edit(record) ?? record));
}

/**
 * A `ready` copy of the project as it is now, left by a process that has
 * exited: what a step killed before it wrote anything leaves.
 */
export async function deadCopy(root: string): Promise<string> {
  await snapshotProject(root);
  const [name] = await copies(root);
  const pid = await exitedPid();
  await editRecord(root, name!, (record) => {
    record.owner.pid = pid;
  });
  return name!;
}

/** The writes a step makes once its copy is kept, cut short. */
export const HALF_WAY = `
  await writeFile(join(root, 'opm.toml'), 'half-written\\n');
  await writeFile(join(root, 'opm.lock.json'), '{}\\n');
  await writeFile(join(root, 'package.json'), '{}\\n');
  await writeFile(join(root, '.opm', 'project.json'), '{}\\n');
  await rm(join(root, 'node_modules', 'base'), { recursive: true });
  await writeFile(join(root, 'node_modules', 'stray.js'), 'half\\n');
`;

/**
 * Run `body` (TypeScript, with `root`, `join` and the fs helpers in scope) in
 * a child process, after `command` (`unshare …`, `node --import <hook>`).
 */
export async function child(
  root: string,
  body: string,
  command: readonly string[] = [],
  env: NodeJS.ProcessEnv = process.env,
): Promise<ChildProcess> {
  const script = temporary(
    join(dirname(root), `${basename(root)}-${randomUUID()}.ts`),
  );
  await writeFile(
    script,
    `import { readFile, rm, writeFile } from 'node:fs/promises';
     import { join } from 'node:path';
     const root = ${JSON.stringify(root)};
     ${body}`,
  );
  const [first, ...rest] = [...command, viteNode, script];
  return spawn(first!, rest, { stdio: 'ignore', env });
}

/** How a child process ended. */
export async function ended(
  process: ChildProcess,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) =>
    process.on('exit', (code, signal) => resolve({ code, signal })),
  );
}

/**
 * The environment that preloads fixtures/kill-at-fs.mjs: the process is killed
 * just before the first `fs.promises[call]` whose arguments match.
 */
export function killingAt(
  call: string,
  first: string,
  second = '',
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NODE_OPTIONS: `--import=${join(here, 'fixtures/kill-at-fs.mjs')}`,
    KILL_FS: call,
    KILL_FS_ARG0: first,
    KILL_FS_ARG1: second,
  };
}

/** Kill `process` and wait until it has gone. */
export async function kill(process: ChildProcess): Promise<void> {
  if (process.exitCode !== null || process.signalCode !== null) return;
  const gone = new Promise((resolve) => process.on('exit', resolve));
  process.kill('SIGKILL');
  await gone;
}

/** Wait until `path` exists. */
export async function until(path: string): Promise<void> {
  while (!existsSync(path))
    await new Promise((resolve) => setTimeout(resolve, 50));
}

/** A process that keeps its copy, starts the step's writes, and is killed. */
export async function killedHalfWay(root: string): Promise<void> {
  const script = temporary(
    join(dirname(root), `${root.split('/').pop()}-step.ts`),
  );
  await writeFile(
    script,
    `import { rm, writeFile } from 'node:fs/promises';
     import { join } from 'node:path';
     import { snapshotProject } from ${JSON.stringify(sources.rollback)};
     const root = ${JSON.stringify(root)};
     await snapshotProject(root);
     ${HALF_WAY}
     process.kill(process.pid, 'SIGKILL');
    `,
  );
  const step = spawn(viteNode, [script], { stdio: 'ignore' });
  const signal = await new Promise<NodeJS.Signals | null>((resolve) =>
    step.on('exit', (_code, how) => resolve(how)),
  );
  expect(signal).toBe('SIGKILL');
}
