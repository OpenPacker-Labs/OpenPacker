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
  PackProviderSource,
  PluginBinding,
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
  ensureStableDirectory,
  handlePathForPlatformFd,
  LOCK_NAME,
  MANIFEST_NAME,
  OPM_DIR,
  projectPaths,
  openChild,
  readDirChild,
  readDirChildWithTypes,
  readStableFile,
  readStableFileBytes,
  readStableFileBytesAt,
  removeChild,
  renameChild,
  removeStableFile,
  removeStableTree,
  resolveContained,
  stableHandlePath,
  storeKeyFromDigest,
  storePathForDigest,
  supportsStableProjectMetadata,
  writeStableFile,
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
  binDeclarationsFromExecutables,
  discoverBins,
  discoverDotnetBins,
  discoverNpmBins,
  discoverPythonBins,
  removeBinShims,
  resolveExecutable,
  resolveOpmxPath,
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
  observedSandboxForGeneration,
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
} from './project.js';
export {
  importNativeProject,
  type NativeImportResult,
} from './import-native.js';
export { updateProject } from './update.js';
export { uninstallProject, whyPackage, writeManifestFile } from './project.js';

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
  stableStoreTreeDigest,
  switchGeneration,
  type EnvironmentState,
  type Generation,
  type GenerationMember,
  type StoreReferences,
} from './generations.js';

export {
  enableDefaultSharedStore,
  isolateProjectStoreFromSharedLinks,
  materializeThroughSharedStore,
  sharedStoreRoot,
  usableSharedRoot,
} from './shared-store.js';
export {
  collectSharedStore,
  type SharedStoreCollection,
} from './shared-store-gc.js';
export { defaultSharedStoreHome } from './paths.js';

export {
  publishPackedArtifact,
  yankRegistryVersion,
} from './publish-client.js';

export {
  DEFAULT_REGISTRY_ENDPOINTS,
  MemoizingTransport,
  ProviderPool,
  REGISTRY_ECOSYSTEMS,
  allowedOriginsFor,
  listRegistryVersions,
  providerFor,
  registryDefinitionFor,
  registryEndpoint,
  registryOptionsForEcosystem,
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
  normalizeProjectPack,
  normalizedPackId,
  type NormalizedProjectPack,
} from './pack-normalize.js';

export { PACK_RECEIPT, packProject, packStandardProject } from './pack.js';
export {
  configurePackProviders,
  type ConfiguredPackProviders,
} from './pack-providers.js';

export {
  nativeName,
  packDelegatedProject,
  packNativeProject,
  projectNativeFormats,
  projectionLevel,
  type NativeProjectionReport,
} from './native.js';

export { codecFor } from './codecs.js';
export {
  detectLibc,
  detectNativeTarget,
  evaluateTargetPredicate,
  type NativeTarget,
} from './host-target.js';
export {
  CLOSURE_OBJECTIVES,
  defaultHostEnvironment,
  evaluateEnvironmentMarker,
  loadResolver,
  nativeRange,
  requirementMarker,
  resolveGraph,
  shouldFollowRequirement,
  solveGraph,
  universeFrom,
  type FollowDecision,
  type HostEnvironment,
  type ResolutionBounds,
  type ResolvedGraph,
} from './resolve.js';

export {
  hostSandboxFromPolicy,
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
  capturePublishTime,
  captureFactsFromCatalog,
  captureFactsFromInspection,
  captureFactsFromSourceUri,
  defaultSupplyChainPolicyInput,
  insideReleaseAge,
  lockPackageSupplyChainFields,
  priorTrustFromLock,
  projectPolicyDocument,
  type PolicyDocument,
  type PublishTimeEvidence,
  type PolicyFacts,
  type PolicyResult,
  type SourceKind,
  type TrustTier,
} from './supply-chain.js';

export {
  defaultAuthConfigPath,
  readAuthConfig,
  upsertAuthOrigin,
  removeAuthOrigin,
  tokenEnvNameForOrigin,
  parseAuthConfig,
  applyAuthConfigToEnvNames,
  hostFetchTokenEnvNamesFromAuth,
  type AuthConfig,
} from './auth-config.js';
