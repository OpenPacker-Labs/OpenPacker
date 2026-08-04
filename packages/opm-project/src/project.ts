import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type {
  LockPackage,
  OpmLockfile,
  OpmManifest,
  PackageRequirement,
  ParsedPackageSpec,
  ProjectState,
} from './types.js';
import { OpmError } from './types.js';
import { loadCatalogs, resolveSource, toFileUrl } from './catalog.js';
import {
  REGISTRY_ECOSYSTEMS,
  listRegistryVersions,
  resolveRegistryArtifact,
} from './registry.js';
import {
  emptyLockfile,
  readLockfile,
  serializeLockfile,
  writeLockfile,
} from './lock.js';
import {
  digestOf,
  fetchArtifactBytes,
  inferFormat,
  installFromLock,
  lockPackageFromSource,
  mediaTypeForEcosystem,
  readProjectState,
  uninstallAll,
  uninstallPackages,
  writeProjectState,
} from './install.js';
import {
  assertSafeSegment,
  CATALOG_NAME,
  LOCK_NAME,
  MANIFEST_NAME,
  parentDirs,
  projectPaths,
  storeKeyFromDigest,
} from './paths.js';
import {
  ecosystemFromPurl,
  exactPurl,
  parsePackageSpec,
  stripPurlVersion,
} from './spec.js';
import { defaultManifest, parseManifest, serializeManifest } from './toml.js';
import { discoverNpmBins } from './bins.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { materialize } from '@openpacker/materializer';
import {
  descriptorForBytes,
  streamFromBytes,
} from '@openpacker/artifact-model';

export async function findOpmRoot(cwd: string): Promise<string | undefined> {
  for (const dir of parentDirs(cwd)) {
    try {
      await access(join(dir, MANIFEST_NAME));
      return dir;
    } catch {
      // continue
    }
  }
  return undefined;
}

export async function requireOpmRoot(cwd: string): Promise<string> {
  const root = await findOpmRoot(cwd);
  if (!root) {
    throw new OpmError(
      'NO_PROJECT',
      `No ${MANIFEST_NAME} found from ${cwd}. Run: opm init`,
    );
  }
  return root;
}

export async function initProject(input: {
  root: string;
  name?: string;
  force?: boolean;
}): Promise<{ manifestPath: string; created: boolean }> {
  const paths = projectPaths(input.root);
  let created = false;
  try {
    await access(paths.manifest);
    if (!input.force) {
      return { manifestPath: paths.manifest, created: false };
    }
  } catch {
    created = true;
  }

  const name = input.name ?? defaultName(input.root);
  const manifest = defaultManifest(name);
  await mkdir(paths.root, { recursive: true });
  await writeFile(paths.manifest, serializeManifest(manifest), 'utf8');
  await mkdir(paths.opmDir, { recursive: true });
  await mkdir(paths.store, { recursive: true });
  await mkdir(paths.bin, { recursive: true });
  await mkdir(paths.links, { recursive: true });
  if (!(await fileExists(paths.lock))) {
    await writeLockfile(paths.lock, emptyLockfile());
  }
  if (!(await fileExists(paths.projectState))) {
    await writeProjectState(paths.projectState, {
      schemaVersion: 1,
      packages: {},
    });
  }
  return { manifestPath: paths.manifest, created: true };
}

function defaultName(root: string): string {
  const base = resolve(root).split(/[/\\]/).filter(Boolean).pop();
  return base && base.length > 0 ? base : 'project';
}

export async function readManifestFile(path: string): Promise<OpmManifest> {
  return parseManifest(await readFile(path, 'utf8'));
}

export async function writeManifestFile(
  path: string,
  manifest: OpmManifest,
): Promise<void> {
  await writeFile(path, serializeManifest(manifest), 'utf8');
}

export async function addPackage(input: {
  root: string;
  spec: string;
  ecosystem?: string;
  source?: string;
  alias?: string;
  offline?: boolean;
  catalogPaths?: readonly string[];
}): Promise<{
  manifest: OpmManifest;
  lock: OpmLockfile;
  state: ProjectState;
  alias: string;
}> {
  const paths = projectPaths(input.root);
  const manifest = await readManifestFile(paths.manifest);
  const parsed = parsePackageSpec(input.spec, {
    ...(input.ecosystem !== undefined ? { ecosystem: input.ecosystem } : {}),
    ...(input.source !== undefined ? { source: input.source } : {}),
    ...(input.alias !== undefined ? { alias: input.alias } : {}),
  });

  // Fail closed if ecosystem not allowed when project restricts
  if (
    parsed.ecosystem &&
    manifest.project.ecosystems.length > 0 &&
    !manifest.project.ecosystems.includes(parsed.ecosystem)
  ) {
    throw new OpmError(
      'ECOSYSTEM_DENIED',
      `Ecosystem "${parsed.ecosystem}" is not in project.ecosystems`,
    );
  }

  const alias = assertSafeSegment(parsed.alias, 'package alias');
  const requirement: PackageRequirement = {
    alias,
    purl: stripPurlVersion(parsed.purl),
  };
  if (parsed.version !== undefined) requirement.version = parsed.version;
  if (parsed.source !== undefined) requirement.source = parsed.source;
  else if (input.source !== undefined) requirement.source = input.source;

  manifest.packages[alias] = requirement;
  await writeManifestFile(paths.manifest, manifest);

  const offline = input.offline ?? manifest.options.offline;
  const lock = await resolveManifestToLock({
    root: input.root,
    manifest,
    offline,
    ...(input.catalogPaths !== undefined
      ? { catalogPaths: input.catalogPaths }
      : {}),
  });
  await writeLockfile(paths.lock, lock);

  const state = await installFromLock({
    root: input.root,
    lock,
    offline,
    only: [alias],
  });

  return { manifest, lock, state, alias };
}

export async function removePackage(input: {
  root: string;
  alias: string;
  offline?: boolean;
}): Promise<{ manifest: OpmManifest; lock: OpmLockfile; state: ProjectState }> {
  const paths = projectPaths(input.root);
  const manifest = await readManifestFile(paths.manifest);
  if (!manifest.packages[input.alias]) {
    throw new OpmError(
      'NOT_FOUND',
      `Package "${input.alias}" is not in ${MANIFEST_NAME}`,
    );
  }
  delete manifest.packages[input.alias];
  await writeManifestFile(paths.manifest, manifest);

  const lock = (await readLockfile(paths.lock)) ?? emptyLockfile();
  delete lock.packages[input.alias];
  await writeLockfile(paths.lock, lock);

  const state = await uninstallPackages({
    root: input.root,
    aliases: [input.alias],
  });

  return { manifest, lock, state };
}

export async function syncProject(input: {
  root: string;
  offline?: boolean;
  catalogPaths?: readonly string[];
}): Promise<{
  manifest: OpmManifest;
  lock: OpmLockfile;
  state: ProjectState;
}> {
  const paths = projectPaths(input.root);
  const manifest = await readManifestFile(paths.manifest);
  const offline = input.offline ?? manifest.options.offline;
  const lock = await resolveManifestToLock({
    root: input.root,
    manifest,
    offline,
    ...(input.catalogPaths !== undefined
      ? { catalogPaths: input.catalogPaths }
      : {}),
  });
  await writeLockfile(paths.lock, lock);

  // uninstall packages no longer in lock
  const previous = await readProjectState(paths.projectState);
  if (previous) {
    const stale = Object.keys(previous.packages).filter(
      (alias) => !lock.packages[alias],
    );
    if (stale.length > 0) {
      await uninstallPackages({ root: input.root, aliases: stale });
    }
  }

  const state = await installFromLock({
    root: input.root,
    lock,
    offline,
  });
  return { manifest, lock, state };
}

export async function installProject(input: {
  root: string;
  offline?: boolean;
}): Promise<{ lock: OpmLockfile; state: ProjectState }> {
  const paths = projectPaths(input.root);
  const manifest = await readManifestFile(paths.manifest);
  const lock = await readLockfile(paths.lock);
  if (!lock || Object.keys(lock.packages).length === 0) {
    // no lock → sync
    const synced = await syncProject({
      root: input.root,
      offline: input.offline ?? manifest.options.offline,
    });
    return { lock: synced.lock, state: synced.state };
  }
  const offline = input.offline ?? manifest.options.offline;
  const state = await installFromLock({
    root: input.root,
    lock,
    offline,
  });
  return { lock, state };
}

export async function uninstallProject(input: {
  root: string;
  alias?: string;
}): Promise<ProjectState> {
  if (input.alias) {
    return uninstallPackages({ root: input.root, aliases: [input.alias] });
  }
  await uninstallAll(input.root);
  return { schemaVersion: 1, packages: {} };
}

export async function listInstalled(root: string): Promise<
  {
    alias: string;
    purl: string;
    digest: string;
    installed: boolean;
    bins: string[];
  }[]
> {
  const paths = projectPaths(root);
  const lock = (await readLockfile(paths.lock)) ?? emptyLockfile();
  const state = (await readProjectState(paths.projectState)) ?? {
    schemaVersion: 1 as const,
    packages: {},
  };
  const aliases = new Set([
    ...Object.keys(lock.packages),
    ...Object.keys(state.packages),
  ]);
  return [...aliases].sort().map((alias) => {
    const locked = lock.packages[alias];
    const installed = state.packages[alias];
    return {
      alias,
      purl: locked?.purl ?? installed?.purl ?? '',
      digest: locked?.digest ?? installed?.digest ?? '',
      installed: installed !== undefined,
      bins: (installed?.bins ?? locked?.bins ?? []).map((b) => b.name),
    };
  });
}

export async function whyPackage(root: string, alias: string): Promise<string> {
  const paths = projectPaths(root);
  const manifest = await readManifestFile(paths.manifest);
  const lock = await readLockfile(paths.lock);
  if (manifest.packages[alias]) {
    const req = manifest.packages[alias]!;
    const locked = lock?.packages[alias];
    return [
      `"${alias}" is a direct dependency in ${MANIFEST_NAME}`,
      `  purl: ${req.purl}`,
      req.version ? `  version constraint: ${req.version}` : undefined,
      req.source ? `  source: ${req.source}` : undefined,
      locked
        ? `  locked: ${locked.purl} (${locked.digest})`
        : '  locked: (none)',
    ]
      .filter(Boolean)
      .join('\n');
  }
  if (lock?.packages[alias]) {
    const locked = lock.packages[alias]!;
    return `"${alias}" is in ${LOCK_NAME} as ${locked.reason} dependency\n  ${locked.purl}`;
  }
  throw new OpmError('NOT_FOUND', `Unknown package "${alias}"`);
}

export async function resolveManifestToLock(input: {
  root: string;
  manifest: OpmManifest;
  offline: boolean;
  catalogPaths?: readonly string[];
}): Promise<OpmLockfile> {
  const paths = projectPaths(input.root);
  const catalogPaths = [
    ...(input.catalogPaths ?? []),
    paths.catalog,
    // walk up for fixtures/opm/catalog.json style
    ...parentDirs(input.root).map((dir) =>
      join(dir, 'fixtures', 'opm', CATALOG_NAME),
    ),
    ...parentDirs(input.root).map((dir) => join(dir, CATALOG_NAME)),
  ];
  if (process.env.OPM_CATALOG) catalogPaths.unshift(process.env.OPM_CATALOG);

  const { packages: catalog } = await loadCatalogs(catalogPaths);
  const lock = emptyLockfile();

  for (const [alias, req] of Object.entries(input.manifest.packages)) {
    const locked = await resolveRequirement({
      root: input.root,
      alias,
      req,
      offline: input.offline,
      catalog,
    });
    lock.packages[alias] = locked;
  }
  return lock;
}

async function resolveRequirement(input: {
  root: string;
  alias: string;
  req: PackageRequirement;
  offline: boolean;
  catalog: Map<
    string,
    {
      purl: string;
      version: string;
      digest: string;
      size: number;
      format: 'tar' | 'tar+gzip' | 'zip';
      mediaType: string;
      source: string;
      resolvedSource: string;
      bins?: readonly { name: string; path: string }[];
    }
  >;
}): Promise<LockPackage> {
  const ecosystem = ecosystemFromPurl(input.req.purl);
  const versionHint = input.req.version;
  const candidateExact =
    versionHint && !versionHint.startsWith('^') && !versionHint.startsWith('~')
      ? exactPurl(stripPurlVersion(input.req.purl), versionHint)
      : input.req.purl.includes('@')
        ? input.req.purl
        : undefined;

  // 1) Explicit source on requirement
  if (input.req.source) {
    const resolved = resolveSource(input.req.source, input.root);
    const bytes = await fetchArtifactBytes(resolved, input.offline);
    const version =
      versionHint &&
      !versionHint.startsWith('^') &&
      !versionHint.startsWith('~')
        ? versionHint
        : (guessVersionFromBytes(bytes) ?? '0.0.0');
    const purl = exactPurl(stripPurlVersion(input.req.purl), version);
    const format = inferFormat(resolved, mediaTypeForEcosystem(ecosystem));
    const mediaType = mediaTypeForEcosystem(ecosystem);
    // discover bins via temp extract for npm
    let bins = input.req.bins ? [...input.req.bins] : [];
    if (bins.length === 0 && ecosystem === 'npm') {
      bins = await discoverBinsFromArchive(bytes, format);
    }
    return lockPackageFromSource({
      alias: input.alias,
      purl,
      version,
      ecosystem,
      bytes,
      source:
        resolved.startsWith('/') || /^[A-Za-z]:/.test(resolved)
          ? toFileUrl(resolved)
          : resolved,
      format,
      mediaType,
      bins,
      reason: 'direct',
    });
  }

  // 2) Catalog lookup by exact purl or base+version
  const keys = [
    candidateExact,
    versionHint && !/[~^<>*]/.test(versionHint)
      ? exactPurl(stripPurlVersion(input.req.purl), versionHint)
      : undefined,
    input.req.purl,
    stripPurlVersion(input.req.purl),
  ].filter((k): k is string => typeof k === 'string');

  // also try version-suffixed catalog keys for latest if only base purl
  for (const [key, entry] of input.catalog) {
    if (
      stripPurlVersion(entry.purl) === stripPurlVersion(input.req.purl) ||
      stripPurlVersion(key) === stripPurlVersion(input.req.purl)
    ) {
      if (
        !versionHint ||
        versionHint === entry.version ||
        versionHint.startsWith('^') ||
        versionHint.startsWith('~') ||
        candidateExact === entry.purl
      ) {
        keys.push(key, entry.purl);
      }
    }
  }

  for (const key of keys) {
    const entry = input.catalog.get(key);
    if (!entry) continue;
    if (
      versionHint &&
      !versionHint.startsWith('^') &&
      !versionHint.startsWith('~') &&
      versionHint !== entry.version &&
      candidateExact &&
      candidateExact !== entry.purl
    ) {
      continue;
    }
    const source = entry.resolvedSource;
    // verify digest if we can read offline
    const bytes = await fetchArtifactBytes(source, input.offline);
    const actual = digestOf(bytes);
    if (actual !== entry.digest) {
      throw new OpmError(
        'DIGEST_MISMATCH',
        `Catalog digest mismatch for ${entry.purl}: expected ${entry.digest}, got ${actual}`,
      );
    }
    let bins = input.req.bins
      ? [...input.req.bins]
      : entry.bins
        ? [...entry.bins]
        : [];
    if (bins.length === 0 && ecosystem === 'npm') {
      bins = await discoverBinsFromArchive(bytes, entry.format);
    }
    return {
      alias: input.alias,
      purl: entry.purl.includes('@')
        ? entry.purl
        : exactPurl(entry.purl, entry.version),
      version: entry.version,
      digest: entry.digest,
      size: entry.size,
      format: entry.format,
      mediaType: entry.mediaType,
      source:
        source.startsWith('/') || /^[A-Za-z]:/.test(source)
          ? toFileUrl(source)
          : source,
      storeKey: storeKeyFromDigest(entry.digest),
      bins,
      reason: 'direct',
      ecosystem,
    };
  }

  // 4) The ecosystem's registry.
  //
  // Last, so an explicit source or a catalog entry always wins: a project that
  // has pinned where a package comes from does not start reaching the network
  // because a registry happens to publish the same name.
  if (!input.offline && REGISTRY_ECOSYSTEMS.includes(ecosystem)) {
    const target =
      candidateExact ??
      (await (async () => {
        // No exact version given, so ask the registry what exists and take the
        // newest. `enumerate` returns oldest-first.
        const versions = await listRegistryVersions(
          ecosystem,
          stripPurlVersion(input.req.purl),
        );
        const newest = versions[versions.length - 1];
        if (!newest)
          throw new OpmError(
            'UNRESOLVABLE',
            `The ${ecosystem} registry published no versions of ${input.req.purl}.`,
          );
        return newest;
      })());

    const artifact = await resolveRegistryArtifact(ecosystem, target);
    // The provider fetched these bytes and checked them against the registry's
    // own integrity claim; this re-derives the digest from the same bytes so
    // nothing enters the store on a provider's say-so.
    const bytes = artifact.bytes;
    const actual = digestOf(bytes);
    if (actual !== artifact.digest)
      throw new OpmError(
        'DIGEST_MISMATCH',
        `Registry digest mismatch for ${artifact.exactPurl}: ` +
          `the ${ecosystem} provider reported ${artifact.digest}, the bytes hash to ${actual}`,
      );
    if (artifact.size > 0 && bytes.byteLength !== artifact.size)
      throw new OpmError(
        'SIZE_MISMATCH',
        `Registry size mismatch for ${artifact.exactPurl}: ` +
          `expected ${artifact.size} bytes, got ${bytes.byteLength}`,
      );

    const format = inferFormat(artifact.uri, artifact.mediaType);
    let bins = input.req.bins ? [...input.req.bins] : [];
    if (bins.length === 0 && ecosystem === 'npm')
      bins = await discoverBinsFromArchive(bytes, format);

    return {
      alias: input.alias,
      purl: artifact.exactPurl,
      version: artifact.version || (versionHint ?? '0.0.0'),
      digest: artifact.digest,
      size: bytes.byteLength,
      format,
      mediaType: artifact.mediaType,
      source: artifact.uri,
      storeKey: storeKeyFromDigest(artifact.digest),
      bins,
      reason: 'direct',
      ecosystem,
    };
  }

  throw new OpmError(
    'UNRESOLVABLE',
    `Cannot resolve "${input.alias}" (${input.req.purl}${versionHint ? `@${versionHint}` : ''}). ` +
      `Provide source = "file:..." in ${MANIFEST_NAME}, pass --source, or add a catalog entry ` +
      `(${CATALOG_NAME} / OPM_CATALOG). Offline catalogs are required when offline.`,
  );
}

async function discoverBinsFromArchive(
  bytes: Uint8Array,
  format: 'tar' | 'tar+gzip' | 'zip',
): Promise<{ name: string; path: string }[]> {
  const dir = await mkdtemp(join(tmpdir(), 'opm-bins-'));
  try {
    const descriptor = await descriptorForBytes({
      bytes,
      descriptorId: 'tmp',
      mediaType: 'application/octet-stream',
      artifactType: 'package',
      nativeRole: 'native-package',
    });
    await materialize({
      source: {
        async stat(d) {
          return { descriptor: d, rangeSupported: false };
        },
        async open() {
          return streamFromBytes(bytes);
        },
        async listReferrers() {
          return [];
        },
      },
      descriptor,
      destination: dir,
      format,
      managedDestination: true,
    });
    return discoverNpmBins(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function guessVersionFromBytes(bytes: Uint8Array): string | undefined {
  // best-effort: look for "version":"x" in utf8
  try {
    const text = new TextDecoder().decode(bytes);
    const match = text.match(/"version"\s*:\s*"([^"]+)"/);
    return match?.[1];
  } catch {
    return undefined;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export { serializeLockfile, parsePackageSpec };
export type { ParsedPackageSpec };
