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

/** Streams that keep what `opmx` writes, readable while it runs. */
export function capture() {
  const seen = { out: '', err: '' };
  const text = (chunk: string | Uint8Array) =>
    typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
  return {
    seen,
    io: {
      stdout: {
        write: (chunk: string | Uint8Array) => (
          (seen.out += text(chunk)),
          true
        ),
      },
      stderr: {
        write: (chunk: string | Uint8Array) => (
          (seen.err += text(chunk)),
          true
        ),
      },
    },
  };
}
