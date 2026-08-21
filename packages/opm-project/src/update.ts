import { join } from 'node:path';
import { parsePurl } from '@openpacker/adapter-core';
import type {
  OpmLockfile,
  OpmManifest,
  PackageRequirement,
  ProjectState,
} from './types.js';
import { OpmError } from './types.js';
import { loadCatalogs, canonicalCatalogPurl } from './catalog.js';
import { codecFor } from './codecs.js';
import {
  digestOf,
  installFromLock,
  readProjectState,
  uninstallPackages,
} from './install.js';
import { readLockfile, writeLockfile } from './lock.js';
import { projectNativeFormats, type NativeProjectionReport } from './native.js';
import {
  CATALOG_NAME,
  MANIFEST_NAME,
  parentDirs,
  projectPaths,
} from './paths.js';
import {
  readManifestFile,
  resolveManifestToLock,
  writeManifestFile,
} from './project.js';
import {
  listRegistryVersions,
  providerFor,
  registryOptionsForEcosystem,
  type RegistryOptions,
} from './registry.js';
import { ecosystemFromPurl, stripPurlVersion } from './spec.js';
import { serializeManifest } from './toml.js';

/** Exact pin test used by install's lock↔manifest binding. */
const EXACT_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/u;

export async function updateProject(input: {
  root: string;
  aliases?: readonly string[];
  latest?: boolean;
  offline?: boolean;
  catalogPaths?: readonly string[];
  /** Transport / endpoint overrides for hosts and tests. */
  registryOptions?: RegistryOptions;
}): Promise<{
  manifest: OpmManifest;
  lock: OpmLockfile;
  state: ProjectState;
  native?: NativeProjectionReport;
  updated: readonly string[];
}> {
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
    await writeManifestFile(paths.manifest, committed);
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

  return finish(input.root, committed, lock, offline, updated);
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
): Promise<{
  manifest: OpmManifest;
  lock: OpmLockfile;
  state: ProjectState;
  native?: NativeProjectionReport;
  updated: readonly string[];
}> {
  const paths = projectPaths(root);
  await writeLockfile(paths.lock, lock);
  const previous = await readProjectState(paths.projectState);
  if (previous) {
    const stale = Object.keys(previous.packages).filter(
      (alias) => !lock.packages[alias],
    );
    if (stale.length > 0) await uninstallPackages({ root, aliases: stale });
  }
  const state = await installFromLock({
    root,
    lock,
    offline,
    ...(!(manifest.policy === undefined) && { policy: manifest.policy }),
  });
  const native = await projectNativeFormats({ root, manifest, lock });
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
  return req.version !== undefined && EXACT_VERSION.test(req.version);
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

async function newestEligibleVersion(input: {
  req: PackageRequirement;
  catalog: Map<string, { purl: string; version: string }>;
  manifest: OpmManifest;
  offline: boolean;
  latest: boolean;
  registryOptions?: RegistryOptions;
}): Promise<string | undefined> {
  const ecosystem = ecosystemFromPurl(input.req.purl);
  const codec = codecFor(ecosystem);
  const candidates = new Map<string, string>();
  const base = canonicalCatalogPurl(stripPurlVersion(input.req.purl));
  for (const entry of input.catalog.values()) {
    if (canonicalCatalogPurl(stripPurlVersion(entry.purl)) !== base) continue;
    candidates.set(entry.version, entry.purl);
  }

  if (!input.offline) {
    try {
      const options = registryOptionsForEcosystem(
        ecosystem,
        input.manifest,
        input.registryOptions ?? {},
      );
      const listed = await listRegistryVersions(
        ecosystem,
        stripPurlVersion(input.req.purl),
        options,
      );
      for (const exact of listed) {
        const version = parsePurl(exact).version;
        if (version !== undefined) candidates.set(version, exact);
      }
    } catch (error) {
      if (
        !(error instanceof OpmError && error.code === 'OFFLINE') &&
        candidates.size === 0
      )
        throw error;
    }
  }

  if (candidates.size === 0) {
    if (input.offline)
      throw new OpmError(
        'UNRESOLVABLE',
        `Cannot update "${input.req.alias}" offline without catalog versions`,
      );
    return undefined;
  }

  const range = input.latest ? undefined : input.req.version;
  const ranked = [...candidates.keys()].sort((left, right) =>
    codec.compareNativeVersions(left, right),
  );
  for (let i = ranked.length - 1; i >= 0; i -= 1) {
    const version = ranked[i]!;
    if (range !== undefined && !versionSatisfies(codec, version, range))
      continue;
    const exact = candidates.get(version) ?? `${base}@${version}`;
    if (await isYankedOrIneligible(ecosystem, exact, input)) continue;
    return version;
  }
  return undefined;
}

function versionSatisfies(
  codec: ReturnType<typeof codecFor>,
  version: string,
  range: string,
): boolean {
  try {
    codec.parseNativeRange(range);
    return codec.satisfies(version, range);
  } catch {
    return false;
  }
}

async function isYankedOrIneligible(
  ecosystem: string,
  exactPurl: string,
  input: {
    manifest: OpmManifest;
    offline: boolean;
    registryOptions?: RegistryOptions;
  },
): Promise<boolean> {
  if (input.offline) return false;
  try {
    const options = registryOptionsForEcosystem(
      ecosystem,
      input.manifest,
      input.registryOptions ?? {},
    );
    const provider = await providerFor(ecosystem, options, [
      'prex.registry.package-metadata/1',
    ]);
    const inspection = await provider.inspect(exactPurl);
    const lifecycle = inspection.package.lifecycle;
    return lifecycle.status === 'yanked' || lifecycle.eligible === false;
  } catch {
    return false;
  }
}
