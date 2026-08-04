export type {
  ArchiveFormat,
  BinDeclaration,
  CatalogPackage,
  InstalledPackageRecord,
  LockPackage,
  OpmCatalog,
  OpmLockfile,
  OpmManifest,
  PackageRequirement,
  ParsedPackageSpec,
  ProjectState,
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
  discoverNpmBins,
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
  materializeLockPackage,
  readProjectState,
  uninstallAll,
  uninstallPackages,
  writeProjectState,
} from './install.js';

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
  type RegistryArtifact,
  type RegistryOptions,
} from './registry.js';
