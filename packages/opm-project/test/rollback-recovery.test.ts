import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstat,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  writeFile,
} from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { configureDefaultAdapters } from '@openpacker/adapters-default';
import {
  addPackage,
  initProject,
  projectPaths,
  readManifestFile,
  recoverInterruptedSteps,
  syncProject,
  writeManifestFile,
} from '../src/index.js';
import { snapshotProject } from '../src/project-rollback.js';
import { permissive } from './closure-support.js';
import { NpmRegistryFixture } from './npm-registry-fixture.js';

configureDefaultAdapters();

/**
 * A step killed after it kept its copy of the project and before it discarded
 * it leaves the project half way and `.opm/.rollback-…` behind. The next step
 * that changes the project finds a copy whose owner is gone, puts the project
 * back from it and removes it. A copy whose owner is alive is never touched.
 */

const here = dirname(fileURLToPath(import.meta.url));
const viteNode = join(here, '../../../node_modules/.bin/vite-node');
const rollbackSource = join(here, '../src/project-rollback.ts');

const registry = () =>
  new NpmRegistryFixture([
    { name: 'base', versions: { '1.0.0': {} } },
    { name: 'other', versions: { '1.0.0': {} } },
  ]);

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'opm-recovery-'));
  roots.push(root);
  await initProject({ root, name: 'recovery' });
  const paths = projectPaths(root);
  const manifest = await readManifestFile(paths.manifest);
  manifest.project.ecosystems = ['npm'];
  manifest.options.nativeProjection = 'layout';
  manifest.policy = permissive;
  await writeManifestFile(paths.manifest, manifest);
  for (const name of ['base', 'other'])
    await addPackage({
      root,
      spec: `pkg:npm/${name}@1.0.0`,
      registryOptions: { transport: registry() },
    });
  return root;
}

/** The writes a step makes once its copy is kept, cut short. */
const HALF_WAY = `
  await writeFile(join(root, 'opm.toml'), 'half-written\\n');
  await writeFile(join(root, 'opm.lock.json'), '{}\\n');
  await writeFile(join(root, 'package.json'), '{}\\n');
  await writeFile(join(root, '.opm', 'project.json'), '{}\\n');
  await rm(join(root, 'node_modules', 'base'), { recursive: true });
  await writeFile(join(root, 'node_modules', 'stray.js'), 'half\\n');
`;

/** A process that keeps its copy, starts the step's writes, and is killed. */
async function killedHalfWay(root: string): Promise<void> {
  const script = join(root, '..', `${root.split('/').pop()}-step.ts`);
  roots.push(script);
  await writeFile(
    script,
    `import { rm, writeFile } from 'node:fs/promises';
     import { join } from 'node:path';
     import { snapshotProject } from ${JSON.stringify(rollbackSource)};
     const root = ${JSON.stringify(root)};
     await snapshotProject(root);
     ${HALF_WAY}
     process.kill(process.pid, 'SIGKILL');
    `,
  );
  const child = spawn(viteNode, [script], { stdio: 'ignore' });
  const signal = await new Promise<NodeJS.Signals | null>((resolve) =>
    child.on('exit', (_code, how) => resolve(how)),
  );
  expect(signal).toBe('SIGKILL');
}

/** Every entry under `dir`: its kind, and a file's bytes or a link's target. */
async function tree(dir: string, into = new Map<string, string>()) {
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

async function snapshot(root: string) {
  const read = (name: string) =>
    readFile(join(root, name), 'utf8').catch(() => '(absent)');
  return {
    manifest: await read('opm.toml'),
    lock: await read('opm.lock.json'),
    packageJson: await read('package.json'),
    state: await read('.opm/project.json'),
    native: await read('.opm/native.json'),
    nodeModules: [...(await tree(join(root, 'node_modules')))],
    opmBin: [...(await tree(join(root, '.opm', 'bin')))],
    links: [...(await tree(join(root, '.opm', 'links')))],
  };
}

const copies = async (root: string) =>
  (await readdir(join(root, '.opm'))).filter((name) =>
    name.startsWith('.rollback-'),
  );

describe.runIf(process.platform !== 'win32')(
  'a step killed after it kept its copy',
  () => {
    it('is put back byte for byte, and the copy removed', async () => {
      const root = await project();
      const before = await snapshot(root);
      await killedHalfWay(root);
      expect((await snapshot(root)).manifest).toBe('half-written\n');
      expect(await copies(root)).toHaveLength(1);

      const recovered = await recoverInterruptedSteps(root);
      expect(recovered).toEqual([
        expect.objectContaining({ restored: true, owner: expect.any(Object) }),
      ]);
      expect(await snapshot(root)).toEqual(before);
      expect(await copies(root)).toEqual([]);
    });

    it('is put back by the next opm sync, which then runs as usual', async () => {
      const root = await project();
      const before = await snapshot(root);
      await killedHalfWay(root);

      await syncProject({ root, registryOptions: { transport: registry() } });
      const after = await snapshot(root);
      expect(await copies(root)).toEqual([]);
      for (const key of [
        'manifest',
        'lock',
        'packageJson',
        'native',
        'nodeModules',
        'opmBin',
        'links',
      ] as const)
        expect(after[key], key).toEqual(before[key]);
    });
  },
);

describe('a copy whose owner is alive', () => {
  it('is never touched', async () => {
    const root = await project();
    // This process's own copy: its step is still running.
    const kept = await snapshotProject(root);
    await writeFile(join(root, 'opm.toml'), 'half-written\n');
    expect(await recoverInterruptedSteps(root)).toEqual([]);
    expect(await readFile(join(root, 'opm.toml'), 'utf8')).toBe(
      'half-written\n',
    );
    expect(await copies(root)).toHaveLength(1);
    await kept.restore();
    expect(await copies(root)).toEqual([]);
  });

  it('on another machine is left alone, since nothing here can tell', async () => {
    const root = await project();
    const kept = await snapshotProject(root);
    const [name] = await copies(root);
    const recordPath = join(root, '.opm', name!, 'rollback.json');
    // SAFETY: the record this module wrote a moment ago.
    const record = JSON.parse(await readFile(recordPath, 'utf8')) as {
      owner: { pid: number; host: string };
    };
    record.owner = { pid: 1, host: `${hostname()}-elsewhere` };
    await writeFile(recordPath, JSON.stringify(record));
    expect(await recoverInterruptedSteps(root)).toEqual([]);
    expect(await copies(root)).toHaveLength(1);
    await kept.discard();
  });
});

describe('a copy whose owner is gone before it was complete', () => {
  it('is removed without restoring anything', async () => {
    const root = await project();
    const before = await snapshot(root);
    const kept = await snapshotProject(root);
    const [name] = await copies(root);
    const recordPath = join(root, '.opm', name!, 'rollback.json');
    // SAFETY: the record this module wrote a moment ago.
    const record = JSON.parse(await readFile(recordPath, 'utf8')) as {
      state: string;
      owner: { pid: number; startTime?: string };
    };
    // Killed while it was still copying: the project was not touched yet.
    record.state = 'copying';
    record.owner.pid = await exitedPid();
    await writeFile(recordPath, JSON.stringify(record));
    expect(await recoverInterruptedSteps(root)).toEqual([
      expect.objectContaining({ restored: false }),
    ]);
    expect(await snapshot(root)).toEqual(before);
    expect(await copies(root)).toEqual([]);
    await kept.discard();
  });
});

describe.runIf(process.platform === 'linux')('a reused process id', () => {
  it('does not keep a copy alive: the start time is compared too', async () => {
    const root = await project();
    const before = await snapshot(root);
    await snapshotProject(root);
    await writeFile(join(root, 'opm.toml'), 'half-written\n');
    const [name] = await copies(root);
    const recordPath = join(root, '.opm', name!, 'rollback.json');
    // SAFETY: the record this module wrote a moment ago.
    const record = JSON.parse(await readFile(recordPath, 'utf8')) as {
      owner: { startTime?: string };
    };
    // This pid, but a process that started at another time.
    record.owner.startTime = '1';
    await writeFile(recordPath, JSON.stringify(record));
    expect(await recoverInterruptedSteps(root)).toEqual([
      expect.objectContaining({ restored: true }),
    ]);
    expect(await snapshot(root)).toEqual(before);
  });
});

/** The id of a process that has exited. */
async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise((resolve) => child.on('exit', resolve));
  return child.pid!;
}
