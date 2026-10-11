import { access, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type {
  LockPackage,
  OpmLockfile,
  OpmManifest,
  PackageRequirement,
  ParsedPackageSpec,
  ProjectState,
} from './types.js';
import { installArchiveLimits } from './install-limits.js';
import { OpmError } from './types.js';
import { projectStep, type StepOptions } from './project-step.js';
import {
  addHostPackage,
  assertEcosystemAllowed,
  type AddPackageResult,
} from './add-host.js';
import {
  canonicalCatalogPurl,
  canonicalPurlOrSelf,
  loadCatalogs,
  resolveSource,
  toFileUrl,
} from './catalog.js';
import { codecFor } from './codecs.js';
import { binDeclarationsFromExecutables } from './bins.js';
import {
  listRegistryVersions,
  registryOptionsForEcosystem,
  resolveRegistryArtifact,
  type RegistryArtifact,
  type RegistryOptions,
} from './registry.js';
import { requireAdapterRegistry } from './adapters.js';
import { resolveTransitive } from './closure-lock.js';
import { assertLabelIsFree } from './label-conflict.js';
import { lockEdgeKeys } from './lock-edges.js';
import { entriesNamed, explainEntry, installedAs } from './why.js';
import {
  isPinnedVersion,
  registryHintFor,
  registryTargetFor,
  targetAsWritten,
} from './registry-target.js';
import { defaultRelease } from './default-release.js';
import {
  emptyLockfile,
  readLockfile,
  serializeLockfile,
  writeLockfile,
} from './lock.js';
import { reproducibleLockForm } from './lock-reproducible.js';
import { commitInstall } from './install-commit.js';
import {
  assertPackageIdentityMatchesRequest,
  echoed,
} from '@openpacker/adapter-core';
import type { NativeProjectionReport } from './native.js';
import {
  bindManifestSourceAuthority,
  digestOf,
  bindVerifiedArtifactBytes,
  fetchArtifactBytes,
  nativeIntegrityOf,
  inferFormat,
  installFromLock,
  lockPackageFromSource,
  mediaTypeForEcosystem,
  readProjectState,
  sealVerifiedArtifactBinding,
  uninstallAll,
  uninstallPackages,
  writeProjectState,
} from './install.js';
import {
  assertStableProjectMetadataSupported,
  assertSafeSegment,
  CATALOG_NAME,
  ensureStableDirectory,
  MANIFEST_NAME,
  parentDirs,
  projectPaths,
  readStableFile,
  storeKeyFromDigest,
  writeStableFile,
} from './paths.js';
import {
  ecosystemFromPurl,
  exactPurl,
  parsePackageSpec,
  purlAtVersion,
  stripPurlVersion,
} from './spec.js';
import {
  applyAttestation,
  assertSupplyChainAllowed,
  capturePublishTime,
  captureFactsFromCatalog,
  captureFactsFromSourceUri,
  lockAttestationFrom,
  lockPackageSupplyChainFields,
  projectPolicyDocument,
  type PolicyFacts,
} from './supply-chain.js';
import { ProviderPool, providerFor } from './registry.js';
import { projectNativeFormats } from './native.js';
import { defaultManifest, parseManifest, serializeManifest } from './toml.js';
import { discoverNpmBins } from './bins.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { materialize } from '@openpacker/materializer';
import { canonicalize } from '@openpacker/canonical';
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
  step?: StepOptions;
}): Promise<{ manifestPath: string; created: boolean }> {
  return projectStep(input.root, input.step, () => initInStep(input));
}

async function initInStep(input: {
  root: string;
  name?: string;
  force?: boolean;
}): Promise<{ manifestPath: string; created: boolean }> {
  const paths = projectPaths(input.root);
  try {
    await access(paths.manifest);
    if (!input.force) {
      return { manifestPath: paths.manifest, created: false };
    }
  } catch {}

  const name = input.name ?? defaultName(input.root);
  const manifest = defaultManifest(name);
  await mkdir(paths.root, { recursive: true });
  await writeStableFile(paths.manifest, serializeManifest(manifest));
  await ensureStableDirectory(paths.opmDir);
  await ensureStableDirectory(paths.store);
  await ensureStableDirectory(paths.bin);
  await ensureStableDirectory(paths.links);
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
  return parseManifest(await readStableFile(path));
}

export async function writeManifestFile(
  path: string,
  manifest: OpmManifest,
): Promise<void> {
  await writeStableFile(path, serializeManifest(manifest));
}

export async function addPackage(input: {
  root: string;
  spec: string;
  ecosystem?: string;
  source?: string;
  alias?: string;
  offline?: boolean;
  catalogPaths?: readonly string[];
  /**
   * Consent for host installers that require elevation (apt/winget/choco).
   * Never implied by the PURL alone.
   */
  allowElevation?: boolean;
  dryRun?: boolean;
  /** Transport / endpoint overrides for the registry walk (tests, hosts). */
  registryOptions?: RegistryOptions;
  step?: StepOptions;
}): Promise<AddPackageResult> {
  const paths = projectPaths(input.root);
  const parsed = parsePackageSpec(input.spec, {
    ...(input.ecosystem !== undefined && { ecosystem: input.ecosystem }),
    ...(input.source !== undefined && { source: input.source }),
    ...(input.alias !== undefined && { alias: input.alias }),
  });
  const ecosystem = parsed.ecosystem ?? ecosystemFromPurl(parsed.purl);
  // Host/profile install is selected by Registry Definition capabilities, not
  // a separate CLI product. Project-store materialize remains the default for
  // artifact-advertising adapters.
  if (
    !input.source &&
    (await requireAdapterRegistry().prefersHostInstall(ecosystem))
  )
    return addHostPackage({
      ...input,
      manifest: await readManifestFile(paths.manifest),
      parsed,
      ecosystem,
    });
  return projectStep(input.root, input.step, async () => {
    const manifest = await readManifestFile(paths.manifest);
    assertEcosystemAllowed(manifest, parsed.ecosystem);
    const alias = assertSafeSegment(parsed.alias, 'package alias');
    const requirement: PackageRequirement = {
      alias,
      purl: stripPurlVersion(parsed.purl),
    };
    if (parsed.version !== undefined) requirement.version = parsed.version;
    if (parsed.installName !== undefined)
      requirement.installName = parsed.installName;
    if (parsed.source !== undefined) requirement.source = parsed.source;
    else if (input.source !== undefined) requirement.source = input.source;

    assertLabelIsFree(manifest, alias, requirement.purl);
    manifest.packages[alias] = requirement;

    const offline = input.offline ?? manifest.options.offline;
    const lock = await resolveManifestToLock({
      root: input.root,
      manifest,
      offline,
      ...(input.catalogPaths !== undefined && {
        catalogPaths: input.catalogPaths,
      }),
      ...(input.registryOptions !== undefined && {
        registryOptions: input.registryOptions,
      }),
      previousLock: await readPreviousLock(paths.lock),
    });
    // The whole lock, not just the alias that was named: a package is not
    // installed in any useful sense without the things it needs, and the lock
    // now carries them. A refused or unsatisfiable add used to leave its
    // requirement in opm.toml; one that fails installing it leaves the project
    // as it was.
    const { state, native } = await commitInstall({
      root: input.root,
      manifest,
      lock,
      offline,
      writeManifest: true,
    });
    return { manifest, lock, state, alias, native };
  });
}

export async function syncProject(input: {
  root: string;
  offline?: boolean;
  catalogPaths?: readonly string[];
  /** Transport / endpoint overrides for the registry walk (tests, hosts). */
  registryOptions?: RegistryOptions;
  step?: StepOptions;
}): Promise<{
  manifest: OpmManifest;
  lock: OpmLockfile;
  state: ProjectState;
  native?: NativeProjectionReport;
}> {
  return projectStep(input.root, input.step, () => syncInStep(input));
}

async function syncInStep(input: {
  root: string;
  offline?: boolean;
  catalogPaths?: readonly string[];
  registryOptions?: RegistryOptions;
}) {
  const paths = projectPaths(input.root);
  const manifest = await readManifestFile(paths.manifest);
  const offline = input.offline ?? manifest.options.offline;
  const lock = await resolveManifestToLock({
    root: input.root,
    manifest,
    offline,
    ...(input.catalogPaths !== undefined && {
      catalogPaths: input.catalogPaths,
    }),
    ...(input.registryOptions !== undefined && {
      registryOptions: input.registryOptions,
    }),
    previousLock: await readPreviousLock(paths.lock),
  });
  const { state, native } = await commitInstall({
    root: input.root,
    manifest,
    lock,
    offline,
    writeManifest: false,
  });
  return { manifest, lock, state, native };
}

export async function installProject(input: {
  root: string;
  offline?: boolean;
  step?: StepOptions;
}): Promise<{
  lock: OpmLockfile;
  state: ProjectState;
  native?: NativeProjectionReport;
}> {
  return projectStep(input.root, input.step, () => installInStep(input));
}

async function installInStep(input: { root: string; offline?: boolean }) {
  const paths = projectPaths(input.root);
  const manifest = await readManifestFile(paths.manifest);
  const lock = await readLockfile(paths.lock);
  if (!lock || Object.keys(lock.packages).length === 0) {
    // no lock → sync
    const synced = await syncProject({
      root: input.root,
      offline: input.offline ?? manifest.options.offline,
    });
    return {
      lock: synced.lock,
      state: synced.state,
      ...(!(synced.native === undefined) && { native: synced.native }),
    };
  }
  assertLockMatchesManifest(input.root, manifest, lock);
  const offline = input.offline ?? manifest.options.offline;
  if (offline) {
    for (const [alias, requirement] of Object.entries(manifest.packages)) {
      const pkg = lock.packages[alias];
      if (pkg !== undefined && requirement.source !== undefined)
        bindManifestSourceAuthority(pkg);
    }
    const state = await installFromLock({
      root: input.root,
      lock,
      offline: true,
      ...(!(manifest.policy === undefined) && { policy: manifest.policy }),
    });
    const native = await projectNativeFormats({
      root: input.root,
      manifest,
      lock,
    });
    return { lock, state, native };
  }
  const verifiedLock = await resolveManifestToLock({
    root: input.root,
    manifest,
    offline,
    previousLock: lock,
  });
  if (
    canonicalize(reproducibleLockForm(lock, verifiedLock)) !==
    canonicalize(reproducibleLockForm(verifiedLock, verifiedLock))
  )
    throw new OpmError(
      'INVALID_LOCK',
      'Lock claims do not match a fresh resolution of the committed manifest',
    );
  const state = await installFromLock({
    root: input.root,
    lock: verifiedLock,
    offline,
    ...(!(manifest.policy === undefined) && { policy: manifest.policy }),
  });
  const native = await projectNativeFormats({
    root: input.root,
    manifest,
    lock: verifiedLock,
  });
  return { lock: verifiedLock, state, native };
}

export function assertLockMatchesManifest(
  root: string,
  manifest: OpmManifest,
  lock: OpmLockfile,
): void {
  if (lock.manifestDigest !== manifestDigest(manifest))
    throw new OpmError(
      'INVALID_LOCK',
      'Lock was not produced from the current manifest and policy',
    );
  for (const [alias, requirement] of Object.entries(manifest.packages)) {
    const pkg = lock.packages[alias];
    if (!pkg || pkg.reason !== 'direct')
      throw new OpmError(
        'INVALID_LOCK',
        `Lock does not contain direct manifest requirement ${echoed(alias)}`,
      );
    if (
      canonicalPurlOrSelf(stripPurlVersion(pkg.purl)) !==
      canonicalPurlOrSelf(stripPurlVersion(requirement.purl))
    )
      throw new OpmError(
        'INVALID_LOCK',
        `Lock package ${echoed(alias)} does not match manifest PURL ${echoed(requirement.purl)}`,
      );
    const exactRequirement =
      stripPurlVersion(requirement.purl) !== requirement.purl
        ? requirement.purl
        : requirement.version !== undefined &&
            isPinnedVersion(
              ecosystemFromPurl(requirement.purl),
              requirement.version,
            )
          ? exactPurl(requirement.purl, requirement.version)
          : undefined;
    if (
      exactRequirement !== undefined &&
      canonicalPurlOrSelf(pkg.purl) !== canonicalPurlOrSelf(exactRequirement)
    )
      throw new OpmError(
        'INVALID_LOCK',
        `Lock package ${echoed(alias)} does not match manifest version ${echoed(String(requirement.version))}`,
      );
    if (
      requirement.source !== undefined &&
      pkg.source !== requirement.source &&
      pkg.source !== normalizedRequirementSource(requirement.source, root)
    )
      throw new OpmError(
        'INVALID_LOCK',
        `Lock package ${echoed(alias)} does not match its manifest source`,
      );
    if (pkg.installName !== requirement.installName)
      throw new OpmError(
        'INVALID_LOCK',
        `Lock package ${alias} is installed as ${pkg.installName ?? 'its own name'}, and the manifest says ${requirement.installName ?? 'its own name'}`,
      );
  }
  for (const [alias, pkg] of Object.entries(lock.packages))
    if (pkg.reason === 'direct' && manifest.packages[alias] === undefined)
      throw new OpmError(
        'INVALID_LOCK',
        `Lock contains undeclared direct package ${echoed(alias)}`,
      );

  const reachable = new Set(Object.keys(manifest.packages));
  const queue = [...reachable];
  while (queue.length > 0) {
    const alias = queue.shift()!;
    const pkg = lock.packages[alias];
    if (!pkg)
      throw new OpmError(
        'INVALID_LOCK',
        `Lock dependency ${echoed(alias)} is missing`,
      );
    for (const dependency of lockEdgeKeys(pkg)) {
      if (!lock.packages[dependency])
        throw new OpmError(
          'INVALID_LOCK',
          `Lock dependency ${echoed(alias)} -> ${echoed(dependency)} is missing`,
        );
      if (!reachable.has(dependency)) {
        reachable.add(dependency);
        queue.push(dependency);
      }
    }
  }
  for (const alias of Object.keys(lock.packages))
    if (!reachable.has(alias))
      throw new OpmError(
        'INVALID_LOCK',
        `Lock contains package ${echoed(alias)} outside the manifest dependency closure`,
      );
}

function manifestDigest(manifest: OpmManifest): string {
  return digestOf(new TextEncoder().encode(serializeManifest(manifest)));
}

/**
 * The lock about to be replaced, for the signature evidence it kept.
 *
 * A lock that is missing or unreadable is the same as no history: the lock is
 * a file anyone with write access can edit or delete, so it is never the thing
 * that decides who to trust (the manifest is), and a resolve that is about to
 * rewrite it must not be blocked by what it held.
 */
async function readPreviousLock(
  path: string,
): Promise<OpmLockfile | undefined> {
  try {
    return await readLockfile(path);
  } catch {
    // Damaged, oversized, a symlink, unreadable: each is "no history". The
    // lock is about to be rewritten, and it was never allowed to block that.
    return undefined;
  }
}

function normalizedRequirementSource(source: string, root: string): string {
  const resolved = resolveSource(source, root);
  return resolved.startsWith('/') || /^[A-Za-z]:/u.test(resolved)
    ? toFileUrl(resolved)
    : resolved;
}

export async function uninstallProject(input: {
  root: string;
  alias?: string;
  step?: StepOptions;
}): Promise<ProjectState> {
  return projectStep(input.root, input.step, async () => {
    if (input.alias)
      return uninstallPackages({ root: input.root, aliases: [input.alias] });
    await uninstallAll(input.root);
    return { schemaVersion: 1, packages: {} };
  });
}

export async function listInstalled(
  root: string,
  platform: NodeJS.Platform = process.platform,
): Promise<
  {
    alias: string;
    purl: string;
    digest: string;
    installed: boolean;
    bins: string[];
    /** Names the package is installed under that are not its own (aliases). */
    installedAs: string[];
  }[]
> {
  assertStableProjectMetadataSupported(platform);
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
      installedAs: installedAs(lock, alias),
    };
  });
}

export async function whyPackage(root: string, alias: string): Promise<string> {
  const paths = projectPaths(root);
  const manifest = await readManifestFile(paths.manifest);
  const lock = await readLockfile(paths.lock);
  const keys = entriesNamed(manifest, lock, alias);
  if (keys.length === 0)
    throw new OpmError('NOT_FOUND', `Unknown package "${echoed(alias)}"`);
  return keys.map((key) => explainEntry(manifest, lock, key)).join('\n\n');
}

export async function resolveManifestToLock(input: {
  root: string;
  manifest: OpmManifest;
  offline: boolean;
  catalogPaths?: readonly string[];
  /** Transport / endpoint overrides for the transitive walk (tests, hosts). */
  registryOptions?: RegistryOptions;
  /**
   * The lock this resolution replaces. Its attestations are how a provider
   * notices that a package's signer changed since it was last accepted; it is
   * evidence for drift detection, never an authority.
   */
  previousLock?: OpmLockfile | undefined;
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
  lock.manifestDigest = manifestDigest(input.manifest);
  // One provider per ecosystem for the whole resolve: the direct requirements,
  // the walk and the artifact steps then share what each has already read.
  const pool = new ProviderPool((ecosystem) =>
    registryOptionsForEcosystem(
      ecosystem,
      input.manifest,
      input.registryOptions ?? {},
      input.previousLock,
    ),
  );
  for (const [alias, req] of Object.entries(input.manifest.packages)) {
    const locked = await resolveRequirement({
      root: input.root,
      alias,
      req,
      offline: input.offline,
      catalog,
      manifest: input.manifest,
      pool,
      ...(!(input.registryOptions === undefined) && {
        registryOptions: input.registryOptions,
      }),
      previousLock: input.previousLock,
    });
    if (req.installName !== undefined) locked.installName = req.installName;
    lock.packages[alias] = locked;
  }

  // Everything the direct requirements need. Resolved through the PREX solver
  // rather than by taking the newest of each dependency, so the lock records a
  // set that was proved to satisfy every constraint together instead of one
  // that happens to look plausible.
  //
  // Offline keeps the old behaviour exactly: a transitive walk reads a
  // registry, so an offline resolve stays direct-only rather than failing a
  // build that used to work.
  if (!input.offline && Object.keys(lock.packages).length > 0) {
    const transitive = await resolveTransitive({
      direct: Object.values(lock.packages),
      manifest: input.manifest,
      pool,
      ...(!(input.registryOptions === undefined) && {
        registryOptions: input.registryOptions,
      }),
      previousLock: input.previousLock,
    });
    for (const [alias, pkg] of Object.entries(transitive.packages))
      if (!lock.packages[alias]) lock.packages[alias] = pkg;
    for (const [alias, dependencies] of Object.entries(
      transitive.dependencies,
    )) {
      const pkg = lock.packages[alias];
      if (pkg) pkg.dependencies = dependencies;
    }
    for (const [alias, edges] of Object.entries(transitive.aliases)) {
      const pkg = lock.packages[alias];
      if (pkg) pkg.aliases = edges;
    }
  }
  for (const pkg of Object.values(lock.packages))
    sealVerifiedArtifactBinding(pkg);
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
  manifest: OpmManifest;
  registryOptions?: RegistryOptions | undefined;
  /** The providers of this resolve, so a registry document is read once. */
  pool?: ProviderPool | undefined;
  previousLock?: OpmLockfile | undefined;
}): Promise<LockPackage> {
  const requestedPurl = canonicalCatalogPurl(input.req.purl, 'manifest');
  const ecosystem = ecosystemFromPurl(requestedPurl);
  const versionHint = input.req.version;
  const candidateExact =
    versionHint && !versionHint.startsWith('^') && !versionHint.startsWith('~')
      ? purlAtVersion(requestedPurl, versionHint)
      : requestedPurl.includes('@')
        ? requestedPurl
        : undefined;
  const policy = projectPolicyDocument(input.manifest);
  const evaluationTime = new Date().toISOString();
  const packageKey = candidateExact ?? stripPurlVersion(requestedPurl);

  // 1) Explicit source on requirement
  if (input.req.source) {
    const resolved = resolveSource(input.req.source, input.root);
    const written = { written: input.req.source };
    const offlineBytes = input.offline
      ? await fetchArtifactBytes(resolved, true, written)
      : undefined;
    const sourceUri =
      resolved.startsWith('/') || /^[A-Za-z]:/.test(resolved)
        ? toFileUrl(resolved)
        : resolved;
    const facts = captureFactsFromSourceUri(packageKey, sourceUri, {
      evaluationTime,
      dependencyDepth: 0,
      lifecycleScriptsExecuted: false,
    });
    await assertSupplyChainAllowed(policy, facts);
    const bytes =
      offlineBytes ??
      (await fetchArtifactBytes(resolved, input.offline, written));
    const version =
      versionHint &&
      !versionHint.startsWith('^') &&
      !versionHint.startsWith('~')
        ? versionHint
        : (guessVersionFromBytes(bytes) ?? '0.0.0');
    const purl = purlAtVersion(requestedPurl, version);
    const format = inferFormat(resolved, mediaTypeForEcosystem(ecosystem));
    const mediaType = mediaTypeForEcosystem(ecosystem);
    // discover bins via temp extract for npm
    let bins = input.req.bins ? [...input.req.bins] : [];
    if (bins.length === 0 && ecosystem === 'npm') {
      bins = await discoverBinsFromArchive(bytes, format);
    }
    const locked = lockPackageFromSource({
      alias: input.alias,
      purl,
      version,
      ecosystem,
      bytes,
      source: sourceUri,
      format,
      mediaType,
      bins,
      reason: 'direct',
    });
    const sourceIntegrity = nativeIntegrityOf(ecosystem, bytes);
    const result: LockPackage = {
      ...locked,
      ...(!(sourceIntegrity === undefined) && {
        nativeIntegrity: sourceIntegrity,
      }),
      ...lockPackageSupplyChainFields(facts),
    };
    bindVerifiedArtifactBytes(result, bytes, 'direct', facts);
    return result;
  }

  // 2) Catalog lookup by exact purl or base+version
  const keys = [
    candidateExact,
    versionHint && !/[~^<>*]/.test(versionHint)
      ? purlAtVersion(requestedPurl, versionHint)
      : undefined,
    requestedPurl,
    stripPurlVersion(requestedPurl),
  ]
    .filter((k): k is string => typeof k === 'string')
    .map((key) => canonicalCatalogPurl(key));

  // also try version-suffixed catalog keys for latest if only base purl
  for (const [key, entry] of input.catalog) {
    if (
      stripPurlVersion(entry.purl) === stripPurlVersion(requestedPurl) ||
      stripPurlVersion(key) === stripPurlVersion(requestedPurl)
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

  for (const key of new Set(keys)) {
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
    const sourceUri =
      source.startsWith('/') || /^[A-Za-z]:/.test(source)
        ? toFileUrl(source)
        : source;
    const selectedCatalogPurl = entry.purl;
    try {
      assertPackageIdentityMatchesRequest(
        candidateExact ?? stripPurlVersion(requestedPurl),
        { exactPurl: selectedCatalogPurl },
      );
      if (
        versionHint !== undefined &&
        (versionHint.startsWith('^') || versionHint.startsWith('~')) &&
        !codecFor(ecosystem).satisfies(entry.version, versionHint)
      )
        continue;
    } catch (error) {
      if (error instanceof OpmError) throw error;
      continue;
    }
    // The canonical spelling, whichever one opm.toml was typed with: a lock
    // holds one spelling of one identity (`lock-purl.ts`).
    const entryPurl = exactPurl(stripPurlVersion(requestedPurl), entry.version);
    const facts = captureFactsFromSourceUri(entryPurl, sourceUri, {
      evaluationTime,
      dependencyDepth: 0,
      lifecycleScriptsExecuted: false,
    });
    await assertSupplyChainAllowed(policy, facts);
    if (/^https?:/iu.test(sourceUri))
      throw new OpmError(
        'POLICY_DENIED',
        'Remote catalog artifacts are not authorized; use a configured registry or an explicit source',
      );
    const bytes = await fetchArtifactBytes(source, input.offline, {
      expectedBytes: entry.size,
      written: entry.source,
    });
    const actual = digestOf(bytes);
    if (actual !== entry.digest) {
      throw new OpmError(
        'DIGEST_MISMATCH',
        `Catalog digest mismatch for ${echoed(entry.purl)}: expected ${echoed(entry.digest)}, got ${actual}`,
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
    const catalogIntegrity = nativeIntegrityOf(ecosystem, bytes);
    const result: LockPackage = {
      alias: input.alias,
      purl: entryPurl,
      version: entry.version,
      digest: entry.digest,
      size: entry.size,
      format: entry.format,
      mediaType: entry.mediaType,
      source: sourceUri,
      storeKey: storeKeyFromDigest(entry.digest),
      bins,
      reason: 'direct',
      ecosystem,
      ...(!(catalogIntegrity === undefined) && {
        nativeIntegrity: catalogIntegrity,
      }),
      ...lockPackageSupplyChainFields(facts),
    };
    bindVerifiedArtifactBytes(result, bytes, 'direct', facts);
    return result;
  }

  // 4) The ecosystem's registry.
  //
  // Last, so an explicit source or a catalog entry always wins: a project that
  // has pinned where a package comes from does not start reaching the network
  // because a registry happens to publish the same name.
  if (!input.offline && requireAdapterRegistry().has(ecosystem)) {
    const registryOptions =
      input.pool === undefined
        ? registryOptionsForEcosystem(
            ecosystem,
            input.manifest,
            input.registryOptions ?? {},
            input.previousLock,
          )
        : await input.pool.optionsWithProvider(ecosystem);
    // A range or a dist-tag in the manifest is resolved here; a version is a
    // version. (`candidateExact` treats anything but ^ and ~ as a version.)
    // Without a codec any hint goes to the plugin as written
    // (`targetAsWritten`, asked first).
    const registryHint = registryHintFor(ecosystem, versionHint);
    const target =
      targetAsWritten(ecosystem, requestedPurl, versionHint) ??
      (registryHint === undefined
        ? candidateExact
        : await registryTargetFor({
            ecosystem,
            purl: requestedPurl,
            hint: registryHint,
            options: registryOptions,
            provider: await providerFor(ecosystem, registryOptions),
            policy,
            evaluationTime,
          })) ??
      (await (async () => {
        // No version given: the registry's `latest`, else its newest release
        // that is not a prerelease, passing over one the policy's minimum age
        // rules out (`default-release.ts`).
        const base = stripPurlVersion(requestedPurl);
        const newest = await defaultRelease({
          ecosystem,
          basePurl: base,
          published: await listRegistryVersions(
            ecosystem,
            base,
            registryOptions,
          ),
          provider: await providerFor(ecosystem, registryOptions),
          policy,
          evaluationTime,
        });
        if (!newest)
          throw new OpmError(
            'UNRESOLVABLE',
            `The ${echoed(ecosystem)} registry published no versions of ${echoed(input.req.purl)}.`,
          );
        return newest;
      })());

    const artifact = await resolveRegistryArtifact(
      ecosystem,
      target,
      registryOptions,
    );
    // The provider fetched these bytes and checked them against the registry's
    // own integrity claim; this re-derives the digest from the same bytes so
    // nothing enters the store on a provider's say-so.
    const bytes = artifact.bytes;
    const actual = digestOf(bytes);
    if (actual !== artifact.digest)
      throw new OpmError(
        'DIGEST_MISMATCH',
        `Registry digest mismatch for ${echoed(artifact.exactPurl)}: ` +
          `the ${ecosystem} provider reported ${echoed(artifact.digest)}, the bytes hash to ${actual}`,
      );
    if (artifact.size > 0 && bytes.byteLength !== artifact.size)
      throw new OpmError(
        'SIZE_MISMATCH',
        `Registry size mismatch for ${echoed(artifact.exactPurl)}: ` +
          `expected ${artifact.size} bytes, got ${bytes.byteLength}`,
      );

    const format = inferFormat(artifact.uri, artifact.mediaType);
    let bins = input.req.bins ? [...input.req.bins] : [];
    if (bins.length === 0 && artifact.bins.length > 0)
      bins = binDeclarationsFromExecutables(artifact.bins);
    if (bins.length === 0 && ecosystem === 'npm')
      bins = await discoverBinsFromArchive(bytes, format);

    // Capture supply-chain facts from the real inspect path when available.
    let supplyFields: ReturnType<typeof lockPackageSupplyChainFields> = {};
    let verifiedFacts: PolicyFacts | undefined;
    try {
      const catalog = await providerFor(ecosystem, {
        ...registryOptions,
        offline: input.offline,
      });
      const { facts } = await captureFactsFromCatalog(catalog, target, {
        evaluationTime,
        dependencyDepth: 0,
        registryId: artifact.registryId,
        minimumReleaseAgeMinutes: policy.minimumReleaseAgeMinutes,
      });
      // Prefer artifact URI for source kind when inspect did not set one.
      if (facts.sourceKind === undefined) {
        Object.assign(
          facts,
          captureFactsFromSourceUri(artifact.exactPurl, artifact.uri, {
            evaluationTime,
            dependencyDepth: 0,
            fromRegistryArtifactRecord: true,
          }),
        );
      }
      // What the artifact resolution verified is authoritative over a second
      // inspection, so the policy never sees less than was checked.
      if (artifact.attestation !== undefined)
        applyAttestation(facts, artifact.attestation);
      await assertSupplyChainAllowed(policy, facts);
      supplyFields = lockPackageSupplyChainFields(facts);
      verifiedFacts = facts;
    } catch (error) {
      if (
        error instanceof OpmError &&
        (error.code === 'POLICY_DENIED' ||
          error.code === 'POLICY_INDETERMINATE')
      )
        throw error;
      // Inspect capture failed — evaluate with honest partial facts from URI.
      const facts = captureFactsFromSourceUri(
        artifact.exactPurl,
        artifact.uri,
        {
          evaluationTime,
          dependencyDepth: 0,
          // The URI came out of the artifact record, whose origin
          // resolveRegistryArtifact already checked against this ecosystem's
          // allowlist — that, not the URI's shape, is what makes it a registry.
          fromRegistryArtifactRecord: true,
          lifecycleScriptsExecuted: false,
        },
      );
      facts.registryId = artifact.registryId;
      if (artifact.attestation !== undefined)
        applyAttestation(facts, artifact.attestation);
      await assertSupplyChainAllowed(policy, facts);
      supplyFields = lockPackageSupplyChainFields(facts);
      verifiedFacts = facts;
    }

    const nativeIntegrity = nativeIntegrityOf(ecosystem, bytes);
    const result: LockPackage = {
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
      ...(!(nativeIntegrity === undefined) && { nativeIntegrity }),
      ...supplyFields,
      ...(artifact.attestation !== undefined && {
        attestation: lockAttestationFrom(artifact.attestation),
      }),
    };
    bindVerifiedArtifactBytes(result, bytes, 'registry', verifiedFacts);
    return result;
  }

  throw new OpmError(
    'UNRESOLVABLE',
    `Cannot resolve "${echoed(input.alias)}" (${echoed(input.req.purl)}${versionHint ? `@${echoed(versionHint)}` : ''}). ` +
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
      // Only npm packages are looked into, and they are read the way `npm`
      // reads them and bounded the way their install is.
      limits: installArchiveLimits('npm'),
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
