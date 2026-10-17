import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  recoverInterruptedSteps,
  snapshotProject,
} from '@openpacker/opm-project';
import { runOpm } from '../src/opm.js';
import { capture } from './run-fixture.js';

/**
 * Every `opm` command that changes a project finishes what a killed `opm`
 * left first, says so once on stderr, and keeps its own change: no copy is
 * left for the next step to put back over it. The commands keep no list of
 * their own; each library step recovers (`project-step.ts`).
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const fixtureTgz = join(repoRoot, 'fixtures/opm/demo-tool-1.1.0.tgz');

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

/** A catalog of `alpha` and `beta` at 1.0.0 and 1.2.0, all offline. */
async function writeCatalog(root: string): Promise<void> {
  const bytes = await readFile(fixtureTgz);
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const packages: Record<string, unknown> = {};
  for (const name of ['alpha', 'beta'])
    for (const version of ['1.0.0', '1.2.0']) {
      const purl = `pkg:npm/${name}@${version}`;
      packages[purl] = {
        purl,
        version,
        digest,
        size: bytes.byteLength,
        format: 'tar+gzip',
        mediaType: 'application/vnd.npm.package+gzip',
        source: `file:${fixtureTgz}`,
        bins: [{ name, path: 'package/bin/demo-tool.js' }],
      };
    }
  await mkdir(join(root, '.opm'), { recursive: true });
  await writeFile(
    join(root, '.opm/catalog.json'),
    `${JSON.stringify({ schemaVersion: 1, packages }, null, 2)}\n`,
  );
}

async function opm(root: string, ...argv: string[]) {
  const cap = capture();
  const code = await runOpm(argv, cap.io, root);
  return { code, out: cap.out, err: cap.err };
}

/** A project with alpha@1.0.0 added, so it has a lock and a generation. */
async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'opm-recover-entry-'));
  temps.push(root);
  expect((await opm(root, 'init', '--name', 'before')).code).toBe(0);
  await writeCatalog(root);
  const added = await opm(root, 'add', 'pkg:npm/alpha@1.0.0', '--offline');
  expect(added.code, added.err).toBe(0);
  return root;
}

const copies = async (root: string) =>
  (await readdir(join(root, '.opm'))).filter((name) =>
    name.startsWith('.rollback-'),
  );

/** The id of a process that has exited. */
async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise((resolve) => child.on('exit', resolve));
  return child.pid!;
}

/** A `ready` copy of the project as it is, left by a process that is gone. */
async function deadCopy(root: string): Promise<{ name: string; pid: number }> {
  await snapshotProject(root);
  const [name] = await copies(root);
  const path = join(root, '.opm', name!, 'rollback.json');
  // SAFETY: the record the library wrote a moment ago.
  const record = JSON.parse(await readFile(path, 'utf8')) as {
    owner: { pid: number };
  };
  record.owner.pid = await exitedPid();
  await writeFile(path, JSON.stringify(record));
  return { name: name!, pid: record.owner.pid };
}

const read = (root: string, name: string) =>
  readFile(join(root, name), 'utf8').catch(() => '(absent)');

interface Command {
  argv: string[];
  prepare?: (root: string) => Promise<object | void>;
  effect: (root: string) => Promise<void>;
}

const commands: Command[] = [
  {
    argv: ['init', '--force', '--name', 'after'],
    effect: async (root) =>
      expect(await read(root, 'opm.toml')).toContain('name = "after"'),
  },
  {
    argv: ['import', '--native', '--force'],
    prepare: (root) =>
      writeFile(
        join(root, 'package.json'),
        JSON.stringify({ name: 'imported', dependencies: { beta: '^1.0.0' } }),
      ),
    effect: async (root) =>
      expect(await read(root, 'opm.toml')).toContain('pkg:npm/beta'),
  },
  {
    argv: ['add', 'pkg:npm/beta@1.0.0', '--offline'],
    effect: async (root) =>
      expect(await read(root, 'opm.toml')).toContain('pkg:npm/beta'),
  },
  {
    argv: ['remove', 'alpha', '--offline'],
    effect: async (root) =>
      expect(await read(root, 'opm.toml')).not.toContain('pkg:npm/alpha'),
  },
  {
    argv: ['sync', '--offline'],
    prepare: async (root) =>
      writeFile(
        join(root, 'opm.toml'),
        `${await read(root, 'opm.toml')}\n[packages.beta]\npurl = "pkg:npm/beta"\nversion = "1.0.0"\n`,
      ),
    effect: async (root) =>
      expect(await read(root, 'opm.lock.json')).toContain('pkg:npm/beta@1.0.0'),
  },
  {
    argv: ['update', 'alpha', '--latest', '--offline'],
    effect: async (root) =>
      expect(await read(root, 'opm.toml')).toContain('1.2.0'),
  },
  {
    // With no lock, install resolves one.
    argv: ['install', '--offline'],
    prepare: (root) => rm(join(root, 'opm.lock.json')),
    effect: async (root) =>
      expect(await read(root, 'opm.lock.json')).toContain(
        'pkg:npm/alpha@1.0.0',
      ),
  },
  {
    argv: ['uninstall'],
    effect: async (root) =>
      expect(await read(root, '.opm/project.json')).not.toContain('"alpha"'),
  },
  {
    argv: ['rollback'],
    prepare: (root) => opm(root, 'add', 'pkg:npm/beta@1.0.0', '--offline'),
    effect: async (root) =>
      expect((await opm(root, 'generations')).out).toMatch(/^\* 1\t/mu),
  },
  {
    argv: ['gc', '--keep', '1'],
    prepare: (root) => opm(root, 'add', 'pkg:npm/beta@1.0.0', '--offline'),
    effect: async (root) =>
      expect(
        (await opm(root, 'generations')).out.trim().split('\n'),
      ).toHaveLength(1),
  },
  {
    argv: ['ci', '--offline'],
    prepare: async (root) => {
      await mkdir(join(root, 'node_modules', 'stale'), { recursive: true });
      await writeFile(join(root, 'node_modules', 'stale', 'index.js'), '\n');
      await writeFile(
        join(root, 'package.json'),
        '{"name":"frozen","version":"1.0.0"}\n',
      );
      await writeFile(
        join(root, 'package-lock.json'),
        '{"name":"frozen","version":"1.0.0","lockfileVersion":3,"requires":true,"packages":{"":{"name":"frozen","version":"1.0.0"}}}\n',
      );
    },
    // The lock is the whole tree, and it names nothing.
    effect: async (root) =>
      expect(existsSync(join(root, 'node_modules', 'stale'))).toBe(false),
  },
  {
    argv: ['packslip', 'approve', '0123456789abcdef'],
    effect: async (root) =>
      expect(await read(root, 'opm.toml')).toContain('0123456789abcdef'),
  },
];

describe('an opm command after a step a killed opm left', () => {
  for (const command of commands)
    it(`opm ${command.argv.join(' ')} puts the project back first, says so once, and keeps its change`, async () => {
      const root = await project();
      await command.prepare?.(root);
      const { name, pid } = await deadCopy(root);
      const run = await opm(root, ...command.argv);
      expect(run.code, run.err).toBe(0);
      expect(
        run.err
          .split('\n')
          .filter((line) => line.startsWith('opm: put the project back')),
      ).toEqual([
        `opm: put the project back as it was before a step that process ${pid} did not finish, and removed ${join('.opm', name)}`,
      ]);
      expect(await copies(root)).toEqual([]);
      await command.effect(root);
      // Nothing is left that a later step would put back over it.
      expect(await recoverInterruptedSteps(root)).toEqual([]);
      await command.effect(root);
      const sync = await opm(root, 'sync', '--offline');
      expect(sync.code, sync.err).toBe(0);
      expect(sync.err).not.toContain('opm: put the project back');
    }, 30_000);
});

describe('a command that changes no project', () => {
  it('opm add <host package> --dry-run leaves a dead copy alone', async () => {
    const root = await project();
    const { name } = await deadCopy(root);
    const run = await opm(
      root,
      'add',
      'pkg:deb/curl',
      '--allow-elevation',
      '--dry-run',
      '--offline',
    );
    expect(run.err).not.toContain('opm: put the project back');
    expect(await copies(root)).toEqual([name]);
  });
});
