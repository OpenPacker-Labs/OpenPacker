import { createHash } from 'node:crypto';
import {
  lstat,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
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
 * Archives as real packages are published, and an add that fails part
 * way. `@vercel/sdk@1.28.43` writes 36 paths longer than a ustar header holds
 * as pax records; `async-listen@3.0.0` (a dependency of `@vercel/cli-auth`)
 * lists `package/dist/index.js` twice. Both install; these pin it. An add that
 * fails after its requirement resolved leaves the project as it was.
 */

const pax = (path: string): Buffer => {
  // "<length> path=<path>\n", where the length counts its own digits.
  const tail = ` path=${path}\n`;
  let length = tail.length + 1;
  while (`${length}${tail}`.length !== length) length += 1;
  return Buffer.from(`${length}${tail}`);
};

const archive = (
  entries: readonly { path: string; body: string; longPath?: boolean }[],
): Uint8Array =>
  new Uint8Array(
    gzipSync(
      Buffer.concat([
        ...entries.flatMap(({ path, body, longPath }) =>
          longPath === true
            ? [
                tarEntry('PaxHeader/long', pax(path), 'x'),
                tarEntry(path.slice(0, 99), Buffer.from(body)),
              ]
            : [tarEntry(path, Buffer.from(body))],
        ),
        Buffer.alloc(1024),
      ]),
    ),
  );

const manifestOf = (name: string) => ({
  path: 'package/package.json',
  body: JSON.stringify({ name, version: '1.0.0', main: 'index.js' }),
});

const LONG = `dist/${'experimentationitemsbyitemid'.repeat(5)}/op.js`;

const published: FixturePackage[] = [
  { name: 'base', versions: { '1.0.0': {} } },
  {
    name: 'long-paths',
    versions: {
      '1.0.0': {
        archive: archive([
          manifestOf('long-paths'),
          { path: `package/${LONG}`, body: 'long\n', longPath: true },
        ]),
      },
    },
  },
  {
    name: 'listed-twice',
    versions: {
      '1.0.0': {
        archive: archive([
          { path: 'package/dist/index.js', body: 'same\n' },
          { path: 'package/dist/index.js', body: 'same\n' },
          manifestOf('listed-twice'),
        ]),
      },
    },
  },
  {
    name: 'two-bodies',
    versions: {
      '1.0.0': {
        archive: archive([
          { path: 'package/dist/index.js', body: 'one\n' },
          { path: 'package/dist/index.js', body: 'two\n' },
          manifestOf('two-bodies'),
        ]),
      },
    },
  },
  {
    name: 'needs-two-bodies',
    versions: { '1.0.0': { dependencies: { 'two-bodies': '^1.0.0' } } },
  },
  {
    name: 'needs-unreachable',
    versions: { '1.0.0': { dependencies: { unreachable: '^1.0.0' } } },
  },
  { name: 'unreachable', versions: { '1.0.0': { tarballFails: true } } },
  {
    name: 'needs-forged',
    versions: { '1.0.0': { dependencies: { forged: '^1.0.0' } } },
  },
  {
    name: 'forged',
    versions: { '1.0.0': { integrityOf: new Uint8Array([1, 2, 3]) } },
  },
];

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'opm-archives-'));
  roots.push(root);
  await initProject({ root, name: 'archives' });
  const paths = projectPaths(root);
  const manifest = await readManifestFile(paths.manifest);
  manifest.project.ecosystems = ['npm'];
  manifest.options.nativeProjection = 'layout';
  manifest.policy = permissive;
  await writeManifestFile(paths.manifest, manifest);
  return root;
}

const add = (root: string, name: string) =>
  addPackage({
    root,
    spec: `pkg:npm/${name}`,
    registryOptions: { transport: new NpmRegistryFixture(published) },
  });

/** Every entry under `dir`: its kind, and a file's bytes or a link's target. */
async function tree(dir: string, into = new Map<string, string>()) {
  for (const name of (await readdir(dir)).sort()) {
    const path = join(dir, name);
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) into.set(path, `link ${await readlink(path)}`);
    else if (stat.isDirectory()) {
      into.set(path, 'dir');
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

/** opm.toml, the lock, package.json and node_modules, byte for byte. */
async function snapshot(root: string) {
  const read = (name: string) =>
    readFile(join(root, name), 'utf8').catch(() => '(absent)');
  return {
    manifest: await read('opm.toml'),
    lock: await read('opm.lock.json'),
    packageJson: await read('package.json'),
    nodeModules: [...(await tree(join(root, 'node_modules')))],
  };
}

describe('archives as real packages are published', () => {
  it('installs a path longer than a ustar header, written as a pax record', async () => {
    const root = await project();
    await add(root, 'long-paths');
    expect(
      await readFile(join(root, 'node_modules', 'long-paths', LONG), 'utf8'),
    ).toBe('long\n');
  });

  it('installs a file listed twice with the same bytes once', async () => {
    const root = await project();
    await add(root, 'listed-twice');
    expect(
      await readFile(
        join(root, 'node_modules', 'listed-twice', 'dist', 'index.js'),
        'utf8',
      ),
    ).toBe('same\n');
  });
});

describe('an add that fails after its requirement resolved', () => {
  it.each([
    ['one path with two different bodies', 'two-bodies', 'DUPLICATE_PATH'],
    [
      'a dependency with one path and two different bodies',
      'needs-two-bodies',
      'DUPLICATE_PATH',
    ],
    ['a dependency whose download fails', 'needs-unreachable', undefined],
    [
      'a dependency whose bytes are not the ones published',
      'needs-forged',
      undefined,
    ],
  ])(
    'leaves opm.toml, the lock and node_modules as they were: %s',
    async (_case, name, code) => {
      const root = await project();
      await add(root, 'base');
      const before = await snapshot(root);
      expect(before.nodeModules.length).toBeGreaterThan(0);
      const failed = add(root, name);
      await expect(failed).rejects.toThrow();
      if (code !== undefined)
        await expect(failed).rejects.toMatchObject({
          message: expect.stringContaining(code),
        });
      expect(await snapshot(root)).toEqual(before);
    },
  );
});
