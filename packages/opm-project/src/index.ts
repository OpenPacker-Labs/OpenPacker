export type {
  ArchiveFormat,
  BinDeclaration,
  CatalogPackage,
  InstalledPackageRecord,
  LockPackage,
  LockAttestation,
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

export * from './workspace/index.js';

export { defaultManifest, parseManifest, serializeManifest } from './toml.js';

export {
  emptyLockfile,
  parseLockfile,
  readLockfile,
  serializeLockfile,
  writeLockfile,
} from './lock.js';
export { reproducibleLockForm } from './lock-reproducible.js';
export {
  environmentScript,
  environmentVariables,
  shellQuote,
} from './environment-script.js';
export { describeRecovery, type RecoveredStep } from './rollback-recovery.js';
export {
  abandonStep,
  type AbandonOptions,
  type AbandonedStep,
} from './step-abandon.js';
export {
  DEFAULT_STEP_WAIT_MS,
  MAX_STEP_WAIT_MS,
  parseStepWait,
  projectStep,
  recoverInterruptedSteps,
  type StepOptions,
} from './project-step.js';
export type { RemovedLock, StepLockHolder } from './step-lock.js';
export {
  currentOwner,
  describeProcessOwner,
  isOwnerAlive,
  makeCurrentOwner,
  ownerKey,
  ownerPlace,
  parseProcessOwner,
  placeDigest,
  systemProbe,
  type OwnerPlace,
  type OwnerProbe,
  type OwnerReads,
  type PlaceOptions,
  type ProcessOwner,
} from './process-owner.js';
export {
  OWNER_FILE,
  ownerFileProblem,
  readOwnerFile,
  writeOwnerFile,
  type OwnerFileProblem,
} from './owner-file.js';
export { printable } from './fs-reason.js';
export { snapshotProject } from './project-rollback.js';

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
// How opmx tells the sandbox that a signal it holds ended a run.
export { stoppedBySignal } from '@openpacker/sandbox';
export {
  ephemeralNodeRun,
  layOutTool,
  type NodeRun,
  type ToolLayout,
  type ToolPackage,
} from './ephemeral-layout.js';
export { installedClosure, installedNodeRun } from './installed-closure.js';

export {
  addPackage,
  findOpmRoot,
  initProject,
  installProject,
  listInstalled,
  readManifestFile,
  requireOpmRoot,
  resolveManifestToLock,
  syncProject,
} from './project.js';
export {
  importNativeProject,
  type NativeImportResult,
} from './import-native.js';
export { removePackage } from './remove.js';
export { updateProject } from './update.js';
export { uninstallProject, whyPackage, writeManifestFile } from './project.js';
export {
  findBinProviders,
  type BinProvider,
  type BinProviderReport,
} from './bin-providers.js';

export {
  GENERATIONS_DIR,
  ENVIRONMENT_STATE,
  STORE_REFERENCES,
  activateGeneration,
  collectGarbage,
  collectableStorePaths,
  environmentPaths,
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
  priorAttestationsFromLock,
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
  installFrozen,
  type FrozenInstallInput,
  type FrozenInstallResult,
} from './frozen-install.js';
export type { FrozenWorkspaceRequest } from './frozen-workspace.js';
export { MAXIMUM_ARCHIVE_BYTES } from './frozen-fetch.js';
export {
  checkIntegrity,
  integrityKey,
  strongestClaims,
  type IntegrityClaim,
} from './integrity.js';
export {
  detectLibc,
  detectNativeTarget,
  evaluateTargetPredicate,
  type NativeTarget,
} from './host-target.js';
export {
  defaultHostEnvironment,
  evaluateEnvironmentMarker,
  nativeRange,
  requirementMarker,
  resolveGraph,
  shouldFollowRequirement,
  type FollowDecision,
  type HostEnvironment,
  type ResolutionBounds,
  type ResolvedGraph,
} from './resolve.js';
export { loadResolver } from './resolver-load.js';
export { CLOSURE_OBJECTIVES, solveGraph } from './solve.js';
export { universeFrom } from './universe.js';

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
  applyAttestation,
  captureFactsFromCatalog,
  captureFactsFromInspection,
  captureFactsFromSourceUri,
  defaultSupplyChainPolicyInput,
  insideReleaseAge,
  lockAttestationFrom,
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
