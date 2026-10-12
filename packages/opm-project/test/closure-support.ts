import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import type { PolicyInput } from '@openpacker/contracts';
import {
  initProject,
  installFromLock,
  projectNativeFormats,
  readManifestFile,
  resolveManifestToLock,
  type OpmLockfile,
  type OpmManifest,
} from '../src/index.js';
import {
  NpmRegistryFixture,
  type FixturePackage,
} from './npm-registry-fixture.js';

/** Shared by the closure tests: a project, a registry, a lock, an install. */

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

export const permissive: PolicyInput = {
  allowYanked: false,
  allowQuarantined: false,
  semanticLossMaximum: 'warning',
  requiredEvidence: [],
};

export async function project(
  packages: OpmManifest['packages'],
  policy: PolicyInput = permissive,
): Promise<{ root: string; manifest: OpmManifest }> {
  const root = await mkdtemp(join(tmpdir(), 'opm-alias-'));
  temps.push(root);
  await initProject({ root, name: 'aliases' });
  const manifest = await readManifestFile(join(root, 'opm.toml'));
  manifest.project.ecosystems = ['npm'];
  manifest.options.nativeProjection = 'layout';
  manifest.packages = packages;
  manifest.policy = policy;
  return { root, manifest };
}

export async function lockOf(
  registry: FixturePackage[],
  packages: OpmManifest['packages'],
  policy: PolicyInput = permissive,
  options: { serveFull?: boolean } = {},
) {
  const { root, manifest } = await project(packages, policy);
  const fixture = new NpmRegistryFixture(registry, options);
  const lock = await resolveManifestToLock({
    root,
    manifest,
    offline: false,
    registryOptions: { transport: fixture },
  });
  return { lock, root, manifest, fixture };
}

export const direct = (
  name: string,
  version?: string,
): OpmManifest['packages'] => ({
  [name]: {
    alias: name,
    purl: `pkg:npm/${name}`,
    ...(!(version === undefined) && { version }),
  },
});

/** What `opm install` does after resolving: the store, then the layout. */
export async function installAndLayout(input: {
  root: string;
  manifest: OpmManifest;
  lock: OpmLockfile;
}): Promise<void> {
  await installFromLock({
    root: input.root,
    lock: input.lock,
    offline: false,
    policy: input.manifest.policy!,
  });
  await projectNativeFormats({
    root: input.root,
    manifest: input.manifest,
    lock: input.lock,
  });
}
