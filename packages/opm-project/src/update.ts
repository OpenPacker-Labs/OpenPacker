import { join } from 'node:path';
import type {
  OpmLockfile,
  OpmManifest,
  PackageRequirement,
  ProjectState,
} from './types.js';
import { OpmError } from './types.js';
import { projectStep, type StepOptions } from './project-step.js';
import { loadCatalogs } from './catalog.js';
import { digestOf, readProjectState } from './install.js';
import { readLockfile } from './lock.js';
import { projectNativeFormats, type NativeProjectionReport } from './native.js';
import {
  CATALOG_NAME,
  MANIFEST_NAME,
  parentDirs,
  projectPaths,
} from './paths.js';
import { readManifestFile, resolveManifestToLock } from './project.js';
import type { RegistryOptions } from './registry.js';
import { isPinnedVersion } from './registry-target.js';
import { ecosystemFromPurl, stripPurlVersion } from './spec.js';
import { serializeManifest } from './toml.js';
import { commitInstall } from './install-commit.js';
import { newestEligibleVersion } from './update-candidates.js';

export async function updateProject(input: {
  root: string;
  aliases?: readonly string[];
  latest?: boolean;
  offline?: boolean;
  catalogPaths?: readonly string[];
  /** Transport / endpoint overrides for hosts and tests. */
  registryOptions?: RegistryOptions;
  step?: StepOptions;
}): Promise<{
  manifest: OpmManifest;
  lock: OpmLockfile;
  state: ProjectState;
  native?: NativeProjectionReport;
  updated: readonly string[];
}> {
  return projectStep(input.root, input.step, () => updateInStep(input));
}

async function updateInStep(input: {
  root: string;
  aliases?: readonly string[];
  latest?: boolean;
  offline?: boolean;
  catalogPaths?: readonly string[];
  registryOptions?: RegistryOptions;
}) {
  const paths = projectPaths(input.root);
  const manifest = await readManifestFile(paths.manifest);
  const offline = input.offline ?? manifest.options.offline;
  const latest = input.latest === true;
  const catalogPaths = collectCatalogPaths(input.root, input.catalogPaths);
  const existing = await readLockfile(paths.lock);
  const startedWithLock = existing !== undefined;

  if (input.aliases !== undefined) {
    for (const alias of input.aliases) {
      if (manifest.packages[alias] === undefined)
        throw new OpmError(
          'NOT_FOUND',
          `Package "${alias}" is not in ${MANIFEST_NAME}`,
        );
    }
  }

  if (!startedWithLock) {
    const lock = await resolveManifestToLock({
      root: input.root,
      manifest,
      offline,
      ...(!(input.catalogPaths === undefined) && {
        catalogPaths: input.catalogPaths,
      }),
      ...(!(input.registryOptions === undefined) && {
        registryOptions: input.registryOptions,
      }),
    });
    return finish(
      input.root,
      manifest,
      lock,
      offline,
      Object.keys(manifest.packages),
      false,
    );
  }

  const { packages: catalog } = await loadCatalogs(catalogPaths);
  await assertLockStillPresent(paths.lock, startedWithLock);

  const requested =
    input.aliases !== undefined && input.aliases.length > 0
      ? [...input.aliases]
      : Object.keys(manifest.packages).filter(
          (alias) => !isExactPin(manifest.packages[alias]!),
        );

  const selected: string[] = [];
  for (const alias of requested) {
    const req = manifest.packages[alias];
    if (req === undefined)
      throw new OpmError(
        'NOT_FOUND',
        `Package "${alias}" is not in ${MANIFEST_NAME}`,
      );
    if (req.source !== undefined) continue;
    if (isExactPin(req) && !latest) {
      if (input.aliases !== undefined && input.aliases.length > 0)
        throw new OpmError(
          'UNRESOLVABLE',
          `Package "${alias}" is an exact pin; pass --latest to change the manifest`,
        );
      continue;
    }
    selected.push(alias);
  }

  if (selected.length === 0) return unchanged(input.root, manifest, existing);

  const picked: Record<string, string> = {};
  for (const alias of selected) {
    const req = manifest.packages[alias]!;
    const version = await newestEligibleVersion({
      req,
      catalog,
      manifest,
      offline,
      latest,
      previousLock: existing,
      ...(!(input.registryOptions === undefined) && {
        registryOptions: input.registryOptions,
      }),
    });
    if (version === undefined)
      throw new OpmError(
        'UNRESOLVABLE',
        `No eligible version found for "${alias}" (${req.purl}${req.version ? `@${req.version}` : ''})`,
      );
    picked[alias] = version;
  }

  const committed: OpmManifest = {
    ...manifest,
    packages: { ...manifest.packages },
  };
  if (latest) {
    for (const alias of selected) {
      const req = committed.packages[alias]!;
      const selectedVersion = picked[alias];
      if (selectedVersion === undefined) continue;
      committed.packages[alias] = {
        ...req,
        purl: stripPurlVersion(req.purl),
        version: selectedVersion,
      };
    }
    // Written with the lock, once the closure is installed (`commitInstall`):
    // an update that fails leaves opm.toml as it was.
  }

  const resolutionManifest: OpmManifest = {
    ...committed,
    packages: { ...committed.packages },
  };
  for (const [alias, req] of Object.entries(committed.packages)) {
    const pin =
      picked[alias] ?? existing.packages[alias]?.version ?? req.version;
    if (pin === undefined) continue;
    resolutionManifest.packages[alias] = {
      ...req,
      purl: stripPurlVersion(req.purl),
      version: pin,
    };
  }

  const lock = await resolveManifestToLock({
    root: input.root,
    manifest: resolutionManifest,
    offline,
    ...(!(input.catalogPaths === undefined) && {
      catalogPaths: input.catalogPaths,
    }),
    ...(!(input.registryOptions === undefined) && {
      registryOptions: input.registryOptions,
    }),
    previousLock: existing,
  });
  lock.manifestDigest = manifestDigest(committed);
  await assertLockStillPresent(paths.lock, startedWithLock);

  const updated = Object.keys(committed.packages)
    .filter((alias) => {
      const previous = existing.packages[alias]?.purl;
      const next = lock.packages[alias]?.purl;
      return next !== undefined && next !== previous;
    })
    .sort();

  return finish(input.root, committed, lock, offline, updated, latest);
}

async function unchanged(
  root: string,
  manifest: OpmManifest,
  lock: OpmLockfile,
): Promise<{
  manifest: OpmManifest;
  lock: OpmLockfile;
  state: ProjectState;
  native?: NativeProjectionReport;
  updated: readonly string[];
}> {
  const paths = projectPaths(root);
  const state = (await readProjectState(paths.projectState)) ?? {
    schemaVersion: 1 as const,
    packages: {},
  };
  const native = await projectNativeFormats({ root, manifest, lock });
  return {
    manifest,
    lock,
    state,
    updated: [],
    ...(!(native === undefined) && { native }),
  };
}

async function finish(
  root: string,
  manifest: OpmManifest,
  lock: OpmLockfile,
  offline: boolean,
  updated: readonly string[],
  writeManifest: boolean,
): Promise<{
  manifest: OpmManifest;
  lock: OpmLockfile;
  state: ProjectState;
  native?: NativeProjectionReport;
  updated: readonly string[];
}> {
  const { state, native } = await commitInstall({
    root,
    manifest,
    lock,
    offline,
    writeManifest,
  });
  return {
    manifest,
    lock,
    state,
    updated,
    ...(!(native === undefined) && { native }),
  };
}

function isExactPin(req: PackageRequirement): boolean {
  if (stripPurlVersion(req.purl) !== req.purl) return true;
  return (
    req.version !== undefined &&
    isPinnedVersion(ecosystemFromPurl(req.purl), req.version)
  );
}

function collectCatalogPaths(
  root: string,
  extra: readonly string[] | undefined,
): string[] {
  const paths = projectPaths(root);
  const catalogPaths = [
    ...(extra ?? []),
    paths.catalog,
    ...parentDirs(root).map((dir) =>
      join(dir, 'fixtures', 'opm', CATALOG_NAME),
    ),
    ...parentDirs(root).map((dir) => join(dir, CATALOG_NAME)),
  ];
  if (process.env.OPM_CATALOG) catalogPaths.unshift(process.env.OPM_CATALOG);
  return catalogPaths;
}

function manifestDigest(manifest: OpmManifest): string {
  return digestOf(new TextEncoder().encode(serializeManifest(manifest)));
}

async function assertLockStillPresent(
  lockPath: string,
  required: boolean,
): Promise<void> {
  if (!required) return;
  const current = await readLockfile(lockPath);
  if (current === undefined)
    throw new OpmError('INPUT_CHANGED', 'Lock file was removed during update');
}
