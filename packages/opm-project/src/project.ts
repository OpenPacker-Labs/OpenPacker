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
import { plainLine } from '@openpacker/canonical';
import { OpmError } from './types.js';
import {
  canonicalCatalogPurl,
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
import { resolveGraph, solveGraph } from './resolve.js';
import {
  emptyLockfile,
  readLockfile,
  serializeLockfile,
  writeLockfile,
} from './lock.js';
import {
  hostSandboxFromPolicy,
  installSystemPackage,
  planSystemInstall,
} from './system.js';
import {
  assertPackageIdentityMatchesRequest,
  echoed,
  type InstallOutcome,
  type InstallPlan,
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
  LOCK_NAME,
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
  stripPurlVersion,
} from './spec.js';
import {
  assertSupplyChainAllowed,
  capturePublishTime,
  captureFactsFromCatalog,
  captureFactsFromSourceUri,
  insideReleaseAge,
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
}): Promise<{
  manifest: OpmManifest;
  lock: OpmLockfile;
  state: ProjectState;
  alias: string;
  /** What was written into the ecosystem's own project files. */
  native?: NativeProjectionReport;
  /** When the adapter prefers host install, the plan/outcome is returned. */
  hostInstall?: {
    plan: InstallPlan;
    outcome?: InstallOutcome;
  };
}> {
  const paths = projectPaths(input.root);
  const manifest = await readManifestFile(paths.manifest);
  const parsed = parsePackageSpec(input.spec, {
    ...(input.ecosystem !== undefined && { ecosystem: input.ecosystem }),
    ...(input.source !== undefined && { source: input.source }),
    ...(input.alias !== undefined && { alias: input.alias }),
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

  const ecosystem = parsed.ecosystem ?? ecosystemFromPurl(parsed.purl);
  // Host/profile install is selected by Registry Definition capabilities, not
  // a separate CLI product. Project-store materialize remains the default for
  // artifact-advertising adapters.
  if (
    !input.source &&
    (await requireAdapterRegistry().prefersHostInstall(ecosystem))
  ) {
    const exact =
      parsed.version !== undefined
        ? `${stripPurlVersion(parsed.purl)}@${parsed.version}`
        : parsed.purl.startsWith('pkg:')
          ? parsed.purl
          : `pkg:${ecosystem}/${parsed.alias}`;
    const sandbox = hostSandboxFromPolicy(manifest.policy);
    const planOptions = {
      ...(input.offline !== undefined && { offline: input.offline }),
      ...(input.dryRun !== undefined && { dryRun: input.dryRun }),
      ...(input.allowElevation !== undefined && {
        allowElevation: input.allowElevation,
      }),
      sandbox,
    };
    const plan = await planSystemInstall(exact, planOptions);
    const outcome =
      input.dryRun === true
        ? undefined
        : await installSystemPackage(exact, {
            ...(input.offline !== undefined && { offline: input.offline }),
            ...(input.allowElevation !== undefined && {
              allowElevation: input.allowElevation,
            }),
            sandbox,
          });
    const alias = assertSafeSegment(parsed.alias, 'package alias');
    const state = (await readProjectState(paths.projectState)) ?? {
      schemaVersion: 1 as const,
      packages: {},
    };
    return {
      manifest,
      lock: emptyLockfile(),
      state,
      alias,
      hostInstall: {
        plan,
        ...(!(outcome === undefined) && { outcome }),
      },
    };
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

  const offline = input.offline ?? manifest.options.offline;
  const lock = await resolveManifestToLock({
    root: input.root,
    manifest,
    offline,
    ...(input.catalogPaths !== undefined && {
      catalogPaths: input.catalogPaths,
    }),
  });
  // Only once the requirement has resolved. A refused or unsatisfiable add
  // used to leave it in opm.toml, where every later install tripped over it.
  await writeManifestFile(paths.manifest, manifest);
  await writeLockfile(paths.lock, lock);

  // The whole lock, not just the alias that was named: a package is not
  // installed in any useful sense without the things it needs, and the lock now
  // carries them.
  const state = await installFromLock({
    root: input.root,
    lock,
    offline,
    ...(!(manifest.policy === undefined) && { policy: manifest.policy }),
  });

  // Last, and only after the store is real: a native manifest that names a
  // package the resolve never produced would send the native tool looking for
  // something opm does not have.
  const native = await projectNativeFormats({
    root: input.root,
    manifest,
    lock,
  });

  return { manifest, lock, state, alias, native };
}

export async function removePackage(input: {
  root: string;
  alias: string;
  offline?: boolean;
}): Promise<{
  manifest: OpmManifest;
  lock: OpmLockfile;
  state: ProjectState;
  native?: NativeProjectionReport;
}> {
  const paths = projectPaths(input.root);
  const manifest = await readManifestFile(paths.manifest);
  if (!manifest.packages[input.alias]) {
    throw new OpmError(
      'NOT_FOUND',
      `Package "${echoed(input.alias)}" is not in ${MANIFEST_NAME}`,
    );
  }
  delete manifest.packages[input.alias];
  await writeManifestFile(paths.manifest, manifest);

  const lock = (await readLockfile(paths.lock)) ?? emptyLockfile();
  const previousAliases = Object.keys(lock.packages);
  const removed = lock.packages[input.alias];
  if (removed) removed.reason = 'transitive';
  const reachable = new Set(Object.keys(manifest.packages));
  const queue = [...reachable];
  while (queue.length > 0) {
    const pkg = lock.packages[queue.shift()!];
    for (const dependency of pkg?.dependencies ?? [])
      if (!reachable.has(dependency)) {
        reachable.add(dependency);
        queue.push(dependency);
      }
  }
  for (const alias of previousAliases)
    if (!reachable.has(alias)) delete lock.packages[alias];
  lock.manifestDigest = manifestDigest(manifest);
  await writeLockfile(paths.lock, lock);

  const state = await uninstallPackages({
    root: input.root,
    aliases: previousAliases.filter((alias) => !lock.packages[alias]),
  });

  // Removing from opm.toml and leaving the entry in package.json would let the
  // native tool reinstall what opm just took out.
  const native = await projectNativeFormats({
    root: input.root,
    manifest,
    lock,
  });

  return { manifest, lock, state, native };
}

export async function syncProject(input: {
  root: string;
  offline?: boolean;
  catalogPaths?: readonly string[];
}): Promise<{
  manifest: OpmManifest;
  lock: OpmLockfile;
  state: ProjectState;
  native?: NativeProjectionReport;
}> {
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
    ...(!(manifest.policy === undefined) && { policy: manifest.policy }),
  });
  const native = await projectNativeFormats({
    root: input.root,
    manifest,
    lock,
  });
  return { manifest, lock, state, native };
}

export async function installProject(input: {
  root: string;
  offline?: boolean;
}): Promise<{
  lock: OpmLockfile;
  state: ProjectState;
  native?: NativeProjectionReport;
}> {
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
  });
  if (
    canonicalize(JSON.parse(serializeLockfile(lock))) !==
    canonicalize(JSON.parse(serializeLockfile(verifiedLock)))
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

function assertLockMatchesManifest(
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
    if (stripPurlVersion(pkg.purl) !== stripPurlVersion(requirement.purl))
      throw new OpmError(
        'INVALID_LOCK',
        `Lock package ${echoed(alias)} does not match manifest PURL ${echoed(requirement.purl)}`,
      );
    const exactRequirement =
      stripPurlVersion(requirement.purl) !== requirement.purl
        ? requirement.purl
        : requirement.version !== undefined &&
            /^[A-Za-z0-9][A-Za-z0-9._+-]*$/u.test(requirement.version)
          ? exactPurl(requirement.purl, requirement.version)
          : undefined;
    if (exactRequirement !== undefined && pkg.purl !== exactRequirement)
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
    for (const dependency of pkg.dependencies ?? []) {
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

function normalizedRequirementSource(source: string, root: string): string {
  const resolved = resolveSource(source, root);
  return resolved.startsWith('/') || /^[A-Za-z]:/u.test(resolved)
    ? toFileUrl(resolved)
    : resolved;
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
  throw new OpmError('NOT_FOUND', `Unknown package "${echoed(alias)}"`);
}

export async function resolveManifestToLock(input: {
  root: string;
  manifest: OpmManifest;
  offline: boolean;
  catalogPaths?: readonly string[];
  /** Transport / endpoint overrides for the transitive walk (tests, hosts). */
  registryOptions?: RegistryOptions;
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
    });
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
    });
    for (const [alias, pkg] of Object.entries(transitive.packages))
      if (!lock.packages[alias]) lock.packages[alias] = pkg;
    for (const [alias, dependencies] of Object.entries(
      transitive.dependencies,
    )) {
      const pkg = lock.packages[alias];
      if (pkg) pkg.dependencies = dependencies;
    }
  }
  for (const pkg of Object.values(lock.packages))
    sealVerifiedArtifactBinding(pkg);
  return lock;
}

/**
 * Lock entries for everything the direct set depends on.
 *
 * Failures here are deliberately not fatal at the install boundary. A registry
 * that omits a dependency, an ecosystem whose ranges this cannot yet match, a
 * graph past the bound — none of those should stop an install that previously
 * worked, so they degrade to the direct set. The walk itself no longer
 * pretends every ecosystem's range lives in a field named `range` (PyPI uses
 * `specifier`), and marker-gated edges are evaluated against the host rather
 * than dropped wholesale.
 */
/**
 * The manifest constraint for a package, when its ecosystem can read it.
 *
 * `version` in opm.toml is whatever the user wrote, and an exact pin is not
 * always a valid range: PyPI wants `==1.0.0`, so a bare `1.0.0` fails to parse
 * and the whole closure comes back empty. Probe the codec and drop a range it
 * cannot read — candidate enumeration is bounded either way, and the solver is
 * pinned to the locked version regardless.
 */
function nativeRangeFor(
  pkg: LockPackage,
  manifest: OpmManifest,
): string | undefined {
  const declared = manifest.packages[pkg.alias]?.version;
  if (declared === undefined) return undefined;
  try {
    codecFor(pkg.ecosystem).parseNativeRange(declared);
    return declared;
  } catch {
    return undefined;
  }
}

async function resolveTransitive(input: {
  direct: readonly LockPackage[];
  manifest: OpmManifest;
  registryOptions?: RegistryOptions | undefined;
  pool: ProviderPool;
}): Promise<{
  packages: Record<string, LockPackage>;
  dependencies: Record<string, string[]>;
}> {
  // Only what came from a registry is walked through that registry. A package
  // pinned to a file, a catalog entry or a URL is not the registry's package of
  // that name, so asking the registry what it depends on would answer for a
  // different package, and could pull its dependencies in by name.
  const resolvable = input.direct.filter(
    (pkg) =>
      pkg.sourceKind === 'registry' &&
      requireAdapterRegistry().has(pkg.ecosystem),
  );
  if (resolvable.length === 0) return { packages: {}, dependencies: {} };

  const policy = projectPolicyDocument(input.manifest);
  const evaluationTime = new Date().toISOString();
  const out: Record<string, LockPackage> = {};
  const dependencies: Record<string, string[]> = {};
  let unresolved: { purl: string; reason: string }[] = [];
  try {
    const graph = await resolveGraph({
      pool: input.pool,
      candidateGate: async (exact, provider) =>
        (await insideReleaseAge(policy, provider, exact, evaluationTime))
          ? `published inside the ${policy.minimumReleaseAgeMinutes}-minute minimum release age`
          : undefined,
      roots: resolvable.map((pkg) => ({
        purl: stripPurlVersion(pkg.purl),
        ...(!(nativeRangeFor(pkg, input.manifest) === undefined) && {
          range: nativeRangeFor(pkg, input.manifest)!,
        }),
      })),
    });
    unresolved = graph.unresolved;
    if (graph.packages.length === 0)
      throw new OpmError(
        'UNRESOLVABLE',
        'the registry returned nothing to resolve against',
      );

    const solved = await solveGraph({
      graph,
      policy: {
        allowYanked: policy.allowYanked,
        allowQuarantined: policy.allowQuarantined,
        requiredEvidence: policy.requiredEvidence,
        semanticLossMaximum: policy.semanticLossMaximum,
        acceptedOverlayAuthorities: input.manifest.policy
          ?.acceptedOverlayAuthorities ?? ['publisher'],
      },
      // Pin each root to the version the direct pass already locked. Left
      // unpinned, the closure can select a different release of a package the
      // lock has already decided, and that second copy lands as a transitive
      // entry beside the direct one.
      rootRequirements: resolvable.map((pkg) => ({
        purl: stripPurlVersion(pkg.purl),
        vers: `vers:${pkg.ecosystem}/${pkg.version}`,
      })),
    });

    const directPurls = new Set(input.direct.map((pkg) => pkg.purl));
    // Fetch every artifact at once (the pool's transport bounds how many are in
    // flight), then take the results in solve order, so what is locked and
    // which failure is reported do not depend on which download finished first.
    const artifacts = new Map<string, Promise<RegistryArtifact>>();
    for (const instance of solved.selected) {
      const exact = instance.identity.exactPurl;
      if (exact === undefined || directPurls.has(exact)) continue;
      const fetching = input.pool
        .optionsWithProvider(instance.identity.purlType)
        .then((options) =>
          resolveRegistryArtifact(instance.identity.purlType, exact, options),
        );
      // Reported where it is awaited below; this only keeps a later failure
      // from being an unhandled rejection while an earlier one is awaited.
      fetching.catch(() => undefined);
      artifacts.set(exact, fetching);
    }
    for (const instance of solved.selected) {
      const exact = instance.identity.exactPurl;
      if (exact === undefined || directPurls.has(exact)) continue;
      const alias = aliasForPurl(exact);
      if (out[alias] && out[alias].purl !== exact)
        throw new OpmError(
          'UNRESOLVABLE',
          `Selected packages collide on lock alias ${echoed(alias)}`,
        );
      if (out[alias]) continue;
      // `inspect` describes a package; the downloadable artifact and its
      // published digest come from the artifact record, which is what the
      // direct path uses too.
      const artifact = await artifacts.get(exact)!;
      // Same standard as the direct path: the digest that goes in the lock is
      // re-derived from the bytes in hand, not copied from what the provider
      // said about them.
      const actual = digestOf(artifact.bytes);
      if (actual !== artifact.digest)
        throw new OpmError(
          'DIGEST_MISMATCH',
          `Registry digest mismatch for ${echoed(artifact.exactPurl)}: ` +
            `the ${echoed(instance.identity.purlType)} provider reported ${echoed(artifact.digest)}, ` +
            `the bytes hash to ${actual}`,
        );
      if (artifact.size > 0 && artifact.bytes.byteLength !== artifact.size)
        throw new OpmError(
          'SIZE_MISMATCH',
          `Registry size mismatch for ${echoed(artifact.exactPurl)}: ` +
            `expected ${artifact.size} bytes, got ${artifact.bytes.byteLength}`,
        );

      // A dependency nobody asked for directly is the case blockExoticSources
      // exists for, so it is evaluated at its real depth rather than skipped.
      const facts = captureFactsFromSourceUri(
        artifact.exactPurl,
        artifact.uri,
        {
          evaluationTime,
          dependencyDepth: 1,
          fromRegistryArtifactRecord: true,
          lifecycleScriptsExecuted: false,
          lifecycle: instance.lifecycle,
          semanticLoss: instance.semanticLoss,
          sourceSnapshotDigests: instance.sourceSnapshots,
        },
      );
      facts.registryId = artifact.registryId;
      // The same publish-time evidence a direct package gets: a dependency
      // nobody asked for by name is the one a release-age window protects.
      await capturePublishTime(
        facts,
        await input.pool.provider(instance.identity.purlType),
        exact,
        { minimumReleaseAgeMinutes: policy.minimumReleaseAgeMinutes },
      );
      await assertSupplyChainAllowed(policy, facts);

      const transitiveIntegrity = nativeIntegrityOf(
        instance.identity.purlType,
        artifact.bytes,
      );
      const locked: LockPackage = {
        alias,
        purl: artifact.exactPurl,
        version: artifact.version || instance.nativeVersion || '0.0.0',
        digest: artifact.digest,
        size: artifact.bytes.byteLength,
        format: inferFormat(artifact.uri, artifact.mediaType),
        mediaType: artifact.mediaType,
        source: artifact.uri,
        storeKey: storeKeyFromDigest(artifact.digest),
        bins: binDeclarationsFromExecutables(artifact.bins),
        reason: 'transitive',
        ecosystem: instance.identity.purlType,
        ...(!(transitiveIntegrity === undefined) && {
          nativeIntegrity: transitiveIntegrity,
        }),
        ...lockPackageSupplyChainFields(facts),
      };
      bindVerifiedArtifactBytes(locked, artifact.bytes, 'registry', facts);
      out[alias] = locked;
    }

    const aliasByNodeId = new Map<string, string>();
    const directByPurl = new Map(
      input.direct.map((pkg) => [pkg.purl, pkg.alias]),
    );
    for (const instance of solved.selected) {
      const exact = instance.identity.exactPurl;
      if (exact === undefined) continue;
      const alias = directByPurl.get(exact) ?? aliasForPurl(exact);
      const pkg =
        input.direct.find((candidate) => candidate.alias === alias) ??
        out[alias];
      if (pkg === undefined || pkg.purl !== exact)
        throw new OpmError(
          'UNRESOLVABLE',
          `Selected package ${echoed(exact)} has no unique lock entry`,
        );
      aliasByNodeId.set(instance.nodeId, alias);
      dependencies[alias] ??= [];
    }
    for (const edge of solved.dependencyEdges) {
      const from = aliasByNodeId.get(edge.fromNodeId);
      const to = aliasByNodeId.get(edge.toNodeId);
      if (from === undefined || to === undefined)
        throw new OpmError(
          'UNRESOLVABLE',
          'Selected dependency edge has no lock entry',
        );
      dependencies[from]!.push(to);
    }
    for (const alias of Object.keys(dependencies))
      dependencies[alias] = [...new Set(dependencies[alias])].sort();
  } catch (error) {
    // A closure that cannot be computed is an error, not a smaller lock. This
    // used to fall back to the direct set, which turned every failure here
    // (a wasm build that was not there, a solve the engine refused, a
    // dependency written as a git URL) into "Added vitest" and a lock of one
    // package, and left the install to find out which of its dependencies were
    // missing. The policy, digest and size refusals already propagated as they
    // were; the rest now say what stopped the closure.
    if (error instanceof OpmError && isClosureRefusal(error)) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    throw new OpmError(
      error instanceof OpmError ? error.code : 'UNRESOLVABLE',
      `Cannot lock the dependency closure of ${resolvable.map((pkg) => echoed(pkg.purl)).join(', ')}: ${reason}${unresolvedNote(unresolved)}`,
    );
  }
  return { packages: out, dependencies };
}

/** Refusals that were always errors: a mitigation must never read as advice. */
function isClosureRefusal(error: OpmError): boolean {
  return (
    error.code === 'POLICY_DENIED' ||
    error.code === 'POLICY_INDETERMINATE' ||
    error.code === 'DIGEST_MISMATCH' ||
    error.code === 'SIZE_MISMATCH'
  );
}

/** The candidates the walk had to set aside, for an error that follows from it. */
function unresolvedNote(
  unresolved: readonly { purl: string; reason: string }[],
): string {
  if (unresolved.length === 0) return '';
  const shown = unresolved
    .slice(0, 5)
    .map((item) => `\n  - ${echoed(item.purl)}: ${plainLine(item.reason)}`)
    .join('');
  const more =
    unresolved.length > 5 ? `\n  - and ${unresolved.length - 5} more` : '';
  return `\nWhat the walk could not use:${shown}${more}`;
}

/** A filesystem-safe alias for a transitive package. */
function aliasForPurl(exactPurl: string): string {
  const withoutScheme = exactPurl.slice('pkg:'.length);
  const withoutVersion = withoutScheme.split('@')[0]!;
  const name = withoutVersion.split('/').slice(1).join('-');
  return (name || withoutVersion).replace(/[^A-Za-z0-9._-]/gu, '-');
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
}): Promise<LockPackage> {
  const requestedPurl = canonicalCatalogPurl(input.req.purl, 'manifest');
  const ecosystem = ecosystemFromPurl(requestedPurl);
  const versionHint = input.req.version;
  const candidateExact =
    versionHint && !versionHint.startsWith('^') && !versionHint.startsWith('~')
      ? exactPurl(stripPurlVersion(requestedPurl), versionHint)
      : requestedPurl.includes('@')
        ? requestedPurl
        : undefined;
  const policy = projectPolicyDocument(input.manifest);
  const evaluationTime = new Date().toISOString();
  const packageKey = candidateExact ?? stripPurlVersion(requestedPurl);

  // 1) Explicit source on requirement
  if (input.req.source) {
    const resolved = resolveSource(input.req.source, input.root);
    const offlineBytes = input.offline
      ? await fetchArtifactBytes(resolved, true)
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
      offlineBytes ?? (await fetchArtifactBytes(resolved, input.offline));
    const version =
      versionHint &&
      !versionHint.startsWith('^') &&
      !versionHint.startsWith('~')
        ? versionHint
        : (guessVersionFromBytes(bytes) ?? '0.0.0');
    const purl = exactPurl(stripPurlVersion(requestedPurl), version);
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
      ? exactPurl(stripPurlVersion(requestedPurl), versionHint)
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
    // Keep the manifest's equivalent spelling in user-facing state while the
    // catalog map and all comparisons remain canonical.
    const entryPurl = exactPurl(
      stripPurlVersion(input.req.purl),
      entry.version,
    );
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
          )
        : await input.pool.optionsWithProvider(ecosystem);
    const target =
      candidateExact ??
      (await (async () => {
        // No exact version given, so ask the registry what exists and take the
        // newest. `enumerate` returns oldest-first.
        const versions = await listRegistryVersions(
          ecosystem,
          stripPurlVersion(requestedPurl),
          registryOptions,
        );
        // Newest first, skipping a release the policy's minimum age rules out
        // so that "add foo" lands on the previous release instead of failing
        // on one published an hour ago. If every release is inside the window
        // the newest is kept and the policy refuses it by name.
        const provider = await providerFor(ecosystem, registryOptions);
        let newest = versions[versions.length - 1];
        for (let index = versions.length - 1; index >= 0; index -= 1)
          if (
            !(await insideReleaseAge(
              policy,
              provider,
              versions[index]!,
              evaluationTime,
            ))
          ) {
            newest = versions[index];
            break;
          }
        if (!newest)
          throw new OpmError(
            'UNRESOLVABLE',
            `The ${ecosystem} registry published no versions of ${echoed(input.req.purl)}.`,
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
