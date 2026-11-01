import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { configureDefaultAdapters } from '@openpacker/adapters-default';
import {
  initProject,
  installFromLock,
  projectPaths,
  readManifestFile,
  resolveManifestToLock,
  writeLockfile,
  writeManifestFile,
} from '@openpacker/opm-project';
import { runOpmx } from '../src/opmx.js';
import {
  NpmRegistryFixture,
  type FixturePackage,
} from '../../../packages/opm-project/test/npm-registry-fixture.js';
import { canSandbox } from './signal-fixture.js';

configureDefaultAdapters();

/**
 * An npm bin a project installed requires its dependencies, as http-server
 * requires chalk. The store holds each package as its own tree with no
 * `node_modules` around it, so Node found nothing ("Cannot find module
 * 'chalk'"); the bin runs from a layout of its package's closure, as a tool
 * straight from a registry does.
 */

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

const says = (text: string) => ({
  files: { 'index.js': `module.exports = ${JSON.stringify(text)};\n` },
});

/**
 * `runner` requires `helper@^1`; the project asks for `helper@2.0.0` itself,
 * so a layout that went by name alone would give `runner` the wrong one.
 */
const registry = (): FixturePackage[] => [
  {
    name: 'runner',
    versions: {
      '1.0.0': {
        dependencies: { helper: '^1.0.0' },
        bin: { runner: 'cli.js' },
        files: {
          'cli.js':
            "#!/usr/bin/env node\nconsole.log('runner has', require('helper'));\n",
        },
      },
    },
  },
  {
    name: 'helper',
    versions: { '1.0.0': says('helper 1'), '2.0.0': says('helper 2') },
  },
];

async function installed(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'opmx-installed-deps-'));
  temps.push(root);
  await initProject({ root, name: 'installed-deps' });
  const paths = projectPaths(root);
  const manifest = await readManifestFile(paths.manifest);
  manifest.project.ecosystems = ['npm'];
  manifest.packages = {
    runner: { alias: 'runner', purl: 'pkg:npm/runner', version: '1.0.0' },
    helper: { alias: 'helper', purl: 'pkg:npm/helper', version: '2.0.0' },
  };
  const lock = await resolveManifestToLock({
    root,
    manifest,
    offline: false,
    registryOptions: { transport: new NpmRegistryFixture(registry()) },
  });
  await writeManifestFile(paths.manifest, manifest);
  await writeLockfile(paths.lock, lock);
  await installFromLock({
    root,
    lock,
    offline: false,
    ...(!(manifest.policy === undefined) && { policy: manifest.policy }),
  });
  return root;
}

function capture() {
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

describe.runIf(canSandbox)('opmx runs an installed npm bin', () => {
  it('with the dependencies its lock entry requires, at the versions it requires', async () => {
    const root = await installed();
    const cap = capture();
    expect(await runOpmx(['runner'], cap.io, root), cap.err).toBe(0);
    expect(cap.out).toBe('runner has helper 1\n');
    // The layout was the run's own, and went when it ended.
    expect(await readdir(join(root, '.opm', 'runs'))).toEqual([]);
  }, 60_000);
});

describe.skipIf(canSandbox)('opmx runs an installed npm bin', () => {
  it.skip('needs bwrap (/usr/bin/bwrap); not checked on this host', () => {});
});
