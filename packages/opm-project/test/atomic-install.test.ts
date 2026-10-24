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
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { configureDefaultAdapters } from '@openpacker/adapters-default';
import {
  addPackage,
  initProject,
  projectPaths,
  readManifestFile,
  syncProject,
  updateProject,
  writeManifestFile,
} from '../src/index.js';
import { permissive } from './closure-support.js';
import {
  NpmRegistryFixture,
  tarEntry,
  type FixturePackage,
} from './npm-registry-fixture.js';

configureDefaultAdapters();

/**
 * `opm sync` and `opm update` either finish or leave the project as it was,
 * as `opm add` does. Two kinds of failure: a package that cannot be extracted
 * (nothing outside the store has changed yet), and a place in node_modules the
 * layout cannot write once linking has started (a file where `.bin` should be
 * a directory), after packages were already placed, the lock written and the
 * install recorded. Both used to leave the lock (and an update's opm.toml)
 * rewritten for a closure that was never installed, and the second a
 * node_modules half way between the two.
 */

/** One path listed twice with different bytes: refused when extracted. */
const twoBodies = new Uint8Array(
  gzipSync(
    Buffer.concat([
      tarEntry('package/index.js', Buffer.from('one\n')),
      tarEntry('package/index.js', Buffer.from('two\n')),
      tarEntry(
        'package/package.json',
        Buffer.from(JSON.stringify({ name: 'broken', version: '1.0.0' })),
      ),
      Buffer.alloc(1024),
    ]),
  ),
);

const withBin = {
  bin: { 'tool-cli': 'cli.js' },
  files: { 'cli.js': '#!/usr/bin/env node\n' },
};

const registry = (base2: FixturePackage['versions'][string]) => [
  { name: 'base', versions: { '1.0.0': {}, '2.0.0': base2 } },
  { name: 'broken', versions: { '1.0.0': { archive: twoBodies } } },
  // The archive is read when the package is installed, not when it resolves.
  {
    name: 'needs-broken',
    versions: { '1.0.0': { dependencies: { broken: '^1.0.0' } } },
  },
  { name: 'tool', versions: { '1.0.0': withBin } },
];

/** The archive refused when it is extracted. */
const UNEXTRACTABLE = /DUPLICATE_PATH/u;
/** The layout cannot make node_modules/.bin a directory. */
const BLOCKED = /ENOTDIR/u;
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

/** A layout project holding base@1.0.0, pinned. */
async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'opm-atomic-'));
  roots.push(root);
  await initProject({ root, name: 'atomic' });
  const paths = projectPaths(root);
  const manifest = await readManifestFile(paths.manifest);
  manifest.project.ecosystems = ['npm'];
  manifest.options.nativeProjection = 'layout';
  manifest.policy = permissive;
  await writeManifestFile(paths.manifest, manifest);
  await addPackage({
    root,
    spec: 'pkg:npm/base@1.0.0',
    registryOptions: { transport: new NpmRegistryFixture(registry({})) },
  });
  return root;
}

/** A file where the layout needs node_modules/.bin to be a directory. */
async function blockBin(root: string) {
  await rm(join(root, 'node_modules', '.bin'), {
    recursive: true,
    force: true,
  });
  await writeFile(join(root, 'node_modules', '.bin'), 'not a directory\n');
}

/** opm.toml requiring one more package, as a person edits it. */
async function requireToo(root: string, name: string) {
  const paths = projectPaths(root);
  const manifest = await readManifestFile(paths.manifest);
  manifest.packages[name] = { alias: name, purl: `pkg:npm/${name}` };
  await writeManifestFile(paths.manifest, manifest);
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

/** What a failed step must leave as it was, byte for byte. */
async function snapshot(root: string) {
  const read = (name: string) =>
    readFile(join(root, name), 'utf8').catch(() => '(absent)');
  return {
    manifest: await read('opm.toml'),
    lock: await read('opm.lock.json'),
    packageJson: await read('package.json'),
    state: await read('.opm/project.json'),
    nodeModules: [...(await tree(join(root, 'node_modules')))],
    opmBin: [...(await tree(join(root, '.opm', 'bin')))],
    leftovers: (await readdir(join(root, '.opm'))).filter((name) =>
      name.startsWith('.rollback-'),
    ),
  };
}

const transport = (base2: FixturePackage['versions'][string] = {}) => ({
  transport: new NpmRegistryFixture(registry(base2)),
});

async function expectUnchanged<T>(
  root: string,
  failure: RegExp,
  step: () => Promise<T>,
) {
  const before = await snapshot(root);
  await expect(step()).rejects.toThrow(failure);
  expect(await snapshot(root)).toEqual(before);
}

describe('opm sync that fails', () => {
  it('before linking leaves the lock and node_modules as they were', async () => {
    const root = await project();
    await requireToo(root, 'needs-broken');
    await expectUnchanged(root, UNEXTRACTABLE, () =>
      syncProject({ root, registryOptions: transport() }),
    );
  });

  it('while linking puts node_modules, the lock and the state back', async () => {
    const root = await project();
    await blockBin(root);
    await requireToo(root, 'tool');
    await expectUnchanged(root, BLOCKED, () =>
      syncProject({ root, registryOptions: transport() }),
    );
  });
});

describe('opm update that fails', () => {
  it('before linking leaves opm.toml, the lock and node_modules as they were', async () => {
    const root = await project();
    await expectUnchanged(root, UNEXTRACTABLE, () =>
      updateProject({
        root,
        aliases: ['base'],
        latest: true,
        registryOptions: transport({ dependencies: { broken: '^1.0.0' } }),
      }),
    );
  });

  it('while linking puts opm.toml, the lock and node_modules back', async () => {
    const root = await project();
    await blockBin(root);
    await expectUnchanged(root, BLOCKED, () =>
      updateProject({
        root,
        aliases: ['base'],
        latest: true,
        registryOptions: transport(withBin),
      }),
    );
  });
});

describe('opm add that fails while linking', () => {
  it('puts opm.toml, the lock and node_modules back', async () => {
    const root = await project();
    await blockBin(root);
    await expectUnchanged(root, BLOCKED, () =>
      addPackage({ root, spec: 'pkg:npm/tool', registryOptions: transport() }),
    );
  });
});

describe('a step that succeeds', () => {
  it('keeps no copy of the project behind', async () => {
    const root = await project();
    await requireToo(root, 'tool');
    await syncProject({ root, registryOptions: transport() });
    expect((await snapshot(root)).leftovers).toEqual([]);
    expect(
      await readFile(join(root, 'node_modules', 'tool', 'cli.js'), 'utf8'),
    ).toBe('#!/usr/bin/env node\n');
  });
});
