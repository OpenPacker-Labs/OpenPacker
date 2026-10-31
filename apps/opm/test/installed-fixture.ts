/**
 * A project that installed npm packages from the npm fixture registry, for the
 * tests that run what it installed through `opmx`, and what `opmx` printed.
 */
import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
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
import {
  NpmRegistryFixture,
  type FixturePackage,
} from '../../../packages/opm-project/test/npm-registry-fixture.js';

configureDefaultAdapters();

/**
 * How long a test that installs a project may take, the install included: the
 * install alone, which does every step `opm install` does, has taken from a
 * fifth of a second to half a minute on a machine whose disk other builds kept
 * busy, and a test cannot wait for less. The figure the package's other tests
 * that install a project use.
 */
export const INSTALLED_TIMEOUT_MS = 60_000;

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

/**
 * A project with each of `registry`'s packages installed at its one version,
 * and `opmToml` (a `[sandbox]` section, say) added to its `opm.toml` once it
 * is installed.
 */
export async function installedProject(
  registry: FixturePackage[],
  opmToml = '',
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'opmx-installed-'));
  temps.push(root);
  await initProject({ root, name: 'installed' });
  const paths = projectPaths(root);
  const manifest = await readManifestFile(paths.manifest);
  manifest.project.ecosystems = ['npm'];
  manifest.packages = Object.fromEntries(
    registry.map(({ name, versions }) => [
      name,
      {
        alias: name,
        purl: `pkg:npm/${name}`,
        version: Object.keys(versions)[0]!,
      },
    ]),
  );
  const lock = await resolveManifestToLock({
    root,
    manifest,
    offline: false,
    registryOptions: { transport: new NpmRegistryFixture(registry) },
  });
  await writeManifestFile(paths.manifest, manifest);
  await writeLockfile(paths.lock, lock);
  await installFromLock({
    root,
    lock,
    offline: false,
    ...(!(manifest.policy === undefined) && { policy: manifest.policy }),
  });
  if (opmToml !== '') await appendFile(paths.manifest, `\n${opmToml}\n`);
  return root;
}

/** A package with one bin, `name`, whose file is `source`. */
export function binPackage(name: string, source: string): FixturePackage {
  return {
    name,
    versions: {
      '1.0.0': {
        bin: { [name]: 'cli.js' },
        files: { 'cli.js': `#!/usr/bin/env node\n${source}` },
      },
    },
  };
}

/**
 * Streams that keep what `opmx` writes, readable while it runs, and a wait for
 * it that ends on what it waits for: settled by the write that makes `test`
 * hold, and failed as soon as `run` ends without it.
 */
export function capture() {
  const seen = { out: '', err: '' };
  const waiting = new Set<{ test: () => boolean; settle: () => void }>();
  const text = (chunk: string | Uint8Array) =>
    typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
  const heard = (into: 'out' | 'err', chunk: string | Uint8Array) => {
    seen[into] += text(chunk);
    for (const wait of waiting)
      if (wait.test()) {
        waiting.delete(wait);
        wait.settle();
      }
    return true;
  };
  const until = (test: () => boolean, run: Promise<number>): Promise<void> =>
    test()
      ? Promise.resolve()
      : Promise.race([
          new Promise<void>((settle) => waiting.add({ test, settle })),
          run.then((code) => {
            throw new Error(
              `opmx ended first (${code}), having written ${JSON.stringify(seen)}`,
            );
          }),
        ]);
  return {
    seen,
    until,
    io: {
      stdout: { write: (chunk: string | Uint8Array) => heard('out', chunk) },
      stderr: { write: (chunk: string | Uint8Array) => heard('err', chunk) },
    },
  };
}
