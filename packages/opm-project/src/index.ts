export type {
  ArchiveFormat,
  BinDeclaration,
  CatalogPackage,
  InstalledPackageRecord,
  LockPackage,
  OpmCatalog,
  OpmLockfile,
  NativeIntegrity,
  NativeProjectionLevel,
  OpmManifest,
  PackageRequirement,
  RegistrySource,
  ParsedPackageSpec,
  ProjectState,
  RequirementScope,
} from './types.js';
export { OpmError } from './types.js';

export { defaultManifest, parseManifest, serializeManifest } from './toml.js';

export {
  emptyLockfile,
  parseLockfile,
  readLockfile,
  serializeLockfile,
  writeLockfile,
} from './lock.js';

export {
  assertDigest,
  assertSafeSegment,
  assertStoreKey,
  CATALOG_NAME,
  LOCK_NAME,
  MANIFEST_NAME,
  OPM_DIR,
  projectPaths,
  resolveContained,
  storeKeyFromDigest,
  storePathForDigest,
} from './paths.js';

export {
  loadCatalogFile,
  loadCatalogs,
  resolveSource,
  toFileUrl,
} from './catalog.js';

export {
  ecosystemFromPurl,
  exactPurl,
  parsePackageSpec,
  stripPurlVersion,
} from './spec.js';

export {
  discoverBins,
  discoverDotnetBins,
  discoverNpmBins,
  discoverPythonBins,
  removeBinShims,
  resolveExecutable,
  writeBinShims,
} from './bins.js';

export {
  digestOf,
  fetchArtifactBytes,
  inferFormat,
  installFromLock,
  lockPackageFromSource,
  mediaTypeForEcosystem,
  nativeIntegrityOf,
  materializeLockPackage,
  readProjectState,
  uninstallAll,
  uninstallPackages,
  writeProjectState,
} from './install.js';

export {
  detectNpmLifecycleScripts,
  hasLifecycleScripts,
  lifecycleScriptsAllowed,
  runDeclaredLifecycleScripts,
  runLifecycleScript,
  sandboxPolicyFromProject,
} from './lifecycle.js';

export { runSandboxedPackageProcess } from './sandbox-run.js';

export {
  addPackage,
  findOpmRoot,
  initProject,
  installProject,
  listInstalled,
  readManifestFile,
  removePackage,
  requireOpmRoot,
  resolveManifestToLock,
  syncProject,
  uninstallProject,
  whyPackage,
  writeManifestFile,
} from './project.js';

export {
  GENERATIONS_DIR,
  ENVIRONMENT_STATE,
  STORE_REFERENCES,
  activateGeneration,
  collectGarbage,
  collectableStorePaths,
  environmentPaths,
  environmentScript,
  environmentVariables,
  shellQuote,
  generationDigest,
  listGenerations,
  mergeStoreReferences,
  readEnvironmentState,
  readGeneration,
  readStoreReferences,
  recordGeneration,
  rollbackTarget,
  switchGeneration,
  type EnvironmentState,
  type Generation,
  type GenerationMember,
  type StoreReferences,
} from './generations.js';

export {
  DEFAULT_REGISTRY_ENDPOINTS,
  REGISTRY_ECOSYSTEMS,
  allowedOriginsFor,
  listRegistryVersions,
  providerFor,
  registryEndpoint,
  resolveRegistryArtifact,
  searchRegistry,
  sourceForEcosystem,
  type RegistryArtifact,
  type RegistryOptions,
} from './registry.js';

export {
  fetchTool,
  selectToolBin,
  toolCacheRoot,
  type EphemeralTool,
} from './ephemeral.js';

export {
  buildPackageManifest,
  withPackedArtifact,
  type BuiltPackageManifest,
} from './manifest.js';

export {
  nativeName,
  packNativeProject,
  projectNativeFormats,
  projectionLevel,
  type NativeProjectionReport,
} from './native.js';

export { codecFor } from './codecs.js';
export {
  defaultHostEnvironment,
  evaluateEnvironmentMarker,
  nativeRange,
  requirementMarker,
  resolveGraph,
  shouldFollowRequirement,
  solveGraph,
  universeFrom,
  type HostEnvironment,
  type ResolutionBounds,
  type ResolvedGraph,
} from './resolve.js';

export {
  installSystemPackage,
  listSystemInstallers,
  planSystemInstall,
  systemInstallerIdFor,
  type SystemInstallerId,
} from './system.js';

export {
  AdapterRegistry,
  configureAdapters,
  ensureAdapterRegistry,
  getAdapterRegistry,
  requireAdapterRegistry,
  setAdapterRegistry,
  tryGetAdapterRegistry,
  type AdapterModule,
} from './adapters.js';
export { providerForWithDiscovery, registryEcosystems } from './registry.js';

export {
  assertSupplyChainAllowed,
  captureFactsFromCatalog,
  captureFactsFromInspection,
  captureFactsFromSourceUri,
  defaultSupplyChainPolicyInput,
  lockPackageSupplyChainFields,
  priorTrustFromLock,
  projectPolicyDocument,
  type PolicyDocument,
  type PolicyFacts,
  type PolicyResult,
  type SourceKind,
  type TrustTier,
} from './supply-chain.js';
