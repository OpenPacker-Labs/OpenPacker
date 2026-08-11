// Generated from spec/prex/v1/schemas by scripts/generate.mjs. Do not edit.
export type JsonPrimitive = null | boolean | number | string;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

export type AmendmentOperation =
  | {
      op: 'supersedeRequirement';
      requirementId: string;
      replacement: Requirement;
    }
  | { op: 'retractRequirement'; requirementId: string; justification: string }
  | {
      op: 'redirectPackage';
      match: RequirementExpression;
      to: RequirementExpression;
    };
export type ArtifactDescriptor = {
  descriptorId: string;
  digest: Digest;
  size: number;
  mediaType: string;
  artifactType: string;
  fileName?: string;
  targetPredicate?: TargetPredicate;
  nativeRole: string;
  locations: Array<ArtifactLocation>;
  oci?: { [key: string]: CanonicalJsonValue };
  ocm?: { [key: string]: CanonicalJsonValue };
  chunkIndexRef?: ExternalRef;
  treeDigest?: Digest;
  treeManifestRef?: ExternalRef;
  producedBy?: { recipeDigest: Digest; outputName: OutputName };
  runtimeReferences?: Array<ArtifactReference>;
  referrers: Array<ExternalRef>;
  externalRefs: Array<ExternalRef>;
  extensions?: Extensions;
};
export type ArtifactLocation = {
  transport: 'https' | 'oci' | 'file' | 'cas' | 'provider';
  uri: string;
  priority: number;
  rangeSupported: boolean;
  credentialRef?: string;
  expiresAt?: string;
  annotations?: { [key: string]: string };
  extensions?: Extensions;
};
export type ArtifactPackedData = {
  schemaVersion: '1';
  descriptor: ArtifactDescriptor;
};
export type ArtifactPackedEvent = CloudEventCommon & {
  type: 'org.openpacker.artifact.packed';
  dataschema: 'https://openpacker.dev/spec/prex/v1/events/data.schema.json#/$defs/org.openpacker.artifact.packed';
  data: ArtifactPackedData;
};
export type ArtifactReference = JsonValue | JsonValue | JsonValue;
export type ArtifactVerifiedData = {
  schemaVersion: '1';
  descriptor: ArtifactDescriptor;
};
export type ArtifactVerifiedEvent = CloudEventCommon & {
  type: 'org.openpacker.artifact.verified';
  dataschema: 'https://openpacker.dev/spec/prex/v1/events/data.schema.json#/$defs/org.openpacker.artifact.verified';
  data: ArtifactVerifiedData;
};
export type BuildRecipe = {
  recipeVersion: '1';
  captureProfile: 'derivation-capture-v1';
  kind: 'derivation' | 'image-build' | 'source-build' | 'repackage' | 'unknown';
  builder: { kind: string; ref?: ExternalRef };
  system?: string;
  platforms?: PlatformContexts;
  inputs: Array<BuildRecipeInput>;
  outputs: Array<BuildRecipeOutput>;
  provenance: 'captured' | 'attested' | 'declared';
  planRef?: ExternalRef;
  nativeRecipe?: { version: string; data: CanonicalJsonValue };
  sourceRefs?: Array<SourceRef>;
  attestations?: Array<ExternalRef>;
  evidenceRefs?: Array<ExternalRef>;
  semanticLoss: Array<SemanticLoss>;
  extensions?: Extensions;
};
export type BuildRecipeInput =
  | JsonValue
  | JsonValue
  | JsonValue
  | JsonValue
  | JsonValue;
export type BuildRecipeOutput = {
  name: OutputName;
  hashMode: 'input-addressed' | 'content-addressed' | 'fixed-output';
  inputAddress?: string;
  expectedDigest?: Digest;
  expectedTreeDigest?: Digest;
  nodeId?: string;
};
export type CanonicalJsonValue =
  | null
  | boolean
  | SafeInteger
  | string
  | Array<CanonicalJsonValue>
  | { [key: string]: CanonicalJsonValue };
export type Capabilities = {
  meta: ProtocolMeta;
  protocolVersions: Array<string>;
  operations: Array<
    | 'normalize'
    | 'identify'
    | 'enumerate'
    | 'inspect'
    | 'solve'
    | 'materialize'
    | 'verify'
    | 'explain'
    | 'receipt.get'
    | 'snapshot.get'
    | 'events.get'
  >;
  conformanceLevels: Array<ConformanceLevel>;
  purlTypes: StringSet;
  versSchemes: StringSet;
  semanticsProfiles: StringSet;
  targetDimensions: StringSet;
  evidenceTypes: StringSet;
  artifactTransports: StringSet;
  contentEncodings: StringSet;
  eventBindings: StringSet;
  limits: ResourceLimits;
  pagination: { supported: boolean; maximumPageSize: PositiveLimit };
  streaming: { supported: boolean; bindings: StringSet };
  authenticationSchemes: Array<{
    type:
      | 'none'
      | 'bearer'
      | 'oauth2'
      | 'mtls'
      | 'api-key'
      | 'provider-specific';
    description?: string;
  }>;
  extensionSchemaRefs: Array<string>;
};
export type Capability = {
  name: string;
  version?: string;
  attributes?: { [key: string]: string | boolean | number };
  providerNodeId: string;
  targetPredicate?: TargetPredicate;
  source: SourceRef;
};
export type CardinalityConstraint = {
  id: string;
  selector: RequirementExpression;
  minimum: number;
  maximum: number;
  scope: 'solution' | 'package' | 'target';
  source: SourceRef;
};
export type CatalogImportRequest = SourceSnapshot;
export type CatalogImportResponse = {
  snapshot: SourceSnapshot;
  digest: string;
};
export type CatalogPackageObservedData = {
  schemaVersion: '1';
  package: PackageInstance;
};
export type CatalogPackageObservedEvent = CloudEventCommon & {
  type: 'org.openpacker.catalog.package.observed';
  dataschema: 'https://openpacker.dev/spec/prex/v1/events/data.schema.json#/$defs/org.openpacker.catalog.package.observed';
  data: CatalogPackageObservedData;
};
export type CatalogSnapshotCreatedData = {
  schemaVersion: '1';
  snapshot: SourceSnapshot;
};
export type CatalogSnapshotCreatedEvent = CloudEventCommon & {
  type: 'org.openpacker.catalog.snapshot.created';
  dataschema: 'https://openpacker.dev/spec/prex/v1/events/data.schema.json#/$defs/org.openpacker.catalog.snapshot.created';
  data: CatalogSnapshotCreatedData;
};
export type CatalogSnapshotRequest = { providerId?: string };
export type CatalogSnapshotResponse = { snapshots: Array<SourceSnapshot> };
export type ClosureEdge = {
  fromNodeId: string;
  toNodeId: string;
  provenance: 'declared' | 'scanned' | 'both';
  evidenceRefs?: Array<ExternalRef>;
};
export type ClosureMember = {
  nodeId: string;
  exactPurl?: string;
  artifactDigest: Digest;
  treeDigest?: Digest;
  outputName?: OutputName;
};
export type CloudEventCommon = {
  specversion: '1.0';
  id: string;
  source: string;
  subject: string;
  time: string;
  datacontenttype: 'application/json';
  datadigest: DigestString;
  correlationid: string;
  causationid?: string;
  externalrefs: Array<ExternalRef>;
  extensions?: Extensions;
};
export type Conflict = {
  id: string;
  expression: RequirementExpression;
  scope: 'solution' | 'package' | 'target';
  source: SourceRef;
};
export type ConformanceLevel =
  | 'PREX-N'
  | 'PREX-I'
  | 'PREX-E'
  | 'PREX-D'
  | 'PREX-S'
  | 'PREX-M'
  | 'PREX-V'
  | 'PREX-X'
  | 'PREX-R'
  | 'PREX-C';
export type Cursor = string;
export type DependencyEdge = {
  requirementId: string;
  fromNodeId: string;
  toNodeId: string;
  witnessType: 'package' | 'capability' | 'replacement' | 'optional';
  toOutputs?: Array<OutputName>;
};
export type Digest = { algorithm: 'sha256'; value: string };
export type DigestProjection = {
  id:
    | 'request-v1'
    | 'universe-v1'
    | 'package-node-v1'
    | 'metadata-record-v1'
    | 'solution-v1'
    | 'proof-v1'
    | 'explanation-v1'
    | 'artifact-set-v1'
    | 'receipt-v1'
    | 'event-data-v1'
    | 'tree-manifest-v1'
    | 'build-recipe-v1'
    | 'recipe-output-v1'
    | 'substitute-v1'
    | 'environment-manifest-v1'
    | 'environment-generation-v1'
    | 'closure-v1';
  algorithm: 'sha256';
  canonicalization: 'prex-jcs-safe-integer-v1';
  includePaths: Array<string>;
  excludePaths: Array<string>;
  orderedSetPaths: Array<string>;
};
export type DigestString = string;
export type Distribution = {
  purlType: PurlType;
  identifier: string;
  version: string;
  exactPurl?: string;
  registryId?: RegistryId;
  registryBaseUrl?: string;
  digest?: Digest;
  nativeIntegrity?: NativeIntegrity;
  size?: number;
  mediaType?: string;
  locations?: Array<string>;
  runtimeHint?: string;
  requirements?: Array<DistributionRequirement>;
  extensions?: Extensions;
};
export type DistributionRequirement = {
  identifier: string;
  purl?: string;
  range?: string;
  scope: 'runtime' | 'development' | 'optional' | 'peer' | 'build';
};
export type EnumerateRequest = {
  canonicalPurl: string;
  vers?: string;
  target: TargetContext;
  lifecyclePolicy: { includeYanked: boolean; includeDelisted: boolean };
  page: { cursor?: string; size: number };
  context?: RequestContext;
};
export type EnumerateResponse = {
  meta: ProtocolMeta;
  versions: Array<EnumeratedVersion>;
  nextCursor?: string;
};
export type EnumeratedVersion = {
  exactPurl: string;
  originalVersion: string;
  normalizedVersion: string;
  sortKey: string;
  publishedAt?: string;
  lifecycle: LifecycleState;
  artifacts: Array<ArtifactDescriptor>;
  sourceSnapshot: Digest;
  metadataDigest: Digest;
  warnings: Array<Warning>;
};
export type EnvironmentGeneration = {
  generationVersion: '1';
  environmentName: EnvironmentName;
  sequence: number;
  createdAt: string;
  parentGenerationDigest?: Digest;
  manifestDigest: Digest;
  lockfileDigest?: Digest;
  solutionDigest?: Digest;
  receiptDigest?: Digest;
  artifactSet: Array<EnvironmentMember>;
  semanticLoss?: Array<SemanticLoss>;
  generationDigest: Digest;
  extensions?: Extensions;
};
export type EnvironmentManifest = {
  manifestVersion: '1';
  name: EnvironmentName;
  description?: string;
  requirements: Array<Requirement>;
  target: TargetContext;
  platforms?: PlatformContexts;
  policy?: PolicyInput;
  extensions?: Extensions;
};
export type EnvironmentMember = {
  nodeId?: string;
  exactPurl?: string;
  artifactDigest: Digest;
  treeDigest?: Digest;
  outputs?: Array<OutputName>;
};
export type EnvironmentName = string;
export type EnvironmentState = {
  stateVersion: '1';
  environmentName: EnvironmentName;
  currentGenerationDigest: Digest;
  retainedGenerationDigests: Array<Digest>;
  extensions?: Extensions;
};
export type ErrorCode =
  | 'INVALID_REQUEST'
  | 'INVALID_PURL'
  | 'INVALID_VERS'
  | 'INVALID_NATIVE_COORDINATE'
  | 'UNSUPPORTED_ECOSYSTEM'
  | 'UNSUPPORTED_SEMANTICS_PROFILE'
  | 'AMBIGUOUS_IDENTITY'
  | 'PROVIDER_CAPABILITY_MISSING'
  | 'PACKAGE_NOT_FOUND'
  | 'VERSION_NOT_FOUND'
  | 'SNAPSHOT_NOT_FOUND'
  | 'SNAPSHOT_MISMATCH'
  | 'UNSATISFIABLE'
  | 'SEMANTIC_LOSS_REJECTED'
  | 'POLICY_DENIED'
  | 'ARTIFACT_NOT_FOUND'
  | 'DIGEST_MISMATCH'
  | 'SIZE_MISMATCH'
  | 'STALE_METADATA'
  | 'INVALID_SIGNATURE'
  | 'PROVENANCE_MISMATCH'
  | 'LIFECYCLE_DENIED'
  | 'RATE_LIMITED'
  | 'UPSTREAM_UNAVAILABLE'
  | 'CANCELLED'
  | 'INTERNAL_ERROR';
export type EventData =
  | CatalogSnapshotCreatedData
  | CatalogPackageObservedData
  | LifecycleChangedData
  | ResolutionCompletedData
  | ResolutionUnsatisfiableData
  | ReceiptCreatedData
  | ArtifactPackedData
  | ArtifactVerifiedData
  | PolicyEvaluatedData;
export type EventType =
  | 'org.openpacker.catalog.snapshot.created'
  | 'org.openpacker.catalog.package.observed'
  | 'org.openpacker.lifecycle.changed'
  | 'org.openpacker.resolution.completed'
  | 'org.openpacker.resolution.unsatisfiable'
  | 'org.openpacker.receipt.created'
  | 'org.openpacker.artifact.packed'
  | 'org.openpacker.artifact.verified'
  | 'org.openpacker.policy.evaluated';
export type EvidenceResult = {
  type: string;
  subjectDigest: Digest;
  evidenceRef?: ExternalRef;
  evidenceDescriptorDigest?: Digest;
  status: EvidenceStatus;
  verifier: { implementation: string; version: string; buildDigest?: Digest };
  evaluationTime: string;
  policyRelevant: boolean;
  diagnostics: Array<Warning>;
};
export type EvidenceStatus =
  | 'valid'
  | 'invalid'
  | 'not-provided'
  | 'unknown'
  | 'not-applicable'
  | 'policy-denied';
export type ExplainRequest = {
  solutionDigest: Digest;
  format?: 'graph' | 'text' | 'both';
  context?: RequestContext;
};
export type ExplainResponse = {
  meta: ProtocolMeta;
  graph: ExplanationGraph;
  text?: string;
};
export type ExplanationGraph = {
  nodes: Array<{
    id: string;
    kind:
      | 'candidate'
      | 'requirement'
      | 'capability'
      | 'conflict'
      | 'cardinality'
      | 'target'
      | 'predicate'
      | 'lifecycle'
      | 'policy'
      | 'objective'
      | 'semantic-loss'
      | 'proof'
      | 'amendment-applied'
      | 'amendment-ignored'
      | 'requirement-suppressed';
    label: string;
    data: { [key: string]: CanonicalJsonValue };
  }>;
  edges: Array<{
    from: string;
    to: string;
    kind:
      | 'requires'
      | 'satisfied-by'
      | 'rejected-by'
      | 'conflicts-with'
      | 'conditioned-by'
      | 'preferred-over'
      | 'derived-from'
      | 'checked-by';
  }>;
  roots: Array<string>;
  unsatCore: Array<string>;
  renderHints?: { [key: string]: string };
};
export type Extensions = { [key: string]: CanonicalJsonValue };
export type ExternalRef = {
  type: string;
  locator: string;
  digest?: Digest;
  mediaType?: string;
  annotations?: { [key: string]: string };
  extensions?: Extensions;
};
export type HolderId = string;
export type IdentifyRequest = {
  query: {
    purl?: string;
    nativeCoordinate?: string;
    ecosystem?: string;
    sourceRef?: SourceRef;
    alias?: string;
    externalRef?: ExternalRef;
  };
  context?: RequestContext;
};
export type IdentifyResponse = {
  meta: ProtocolMeta;
  status: 'identified' | 'ambiguous' | 'not-found';
  candidates: Array<IdentityCandidate>;
};
export type IdentityCandidate = {
  identity: PackageIdentity;
  confidence: number;
  provenance: Array<SourceRef>;
  warnings: Array<Warning>;
};
export type IdentityRef = {
  type: 'uri' | 'key' | 'oidc' | 'spiffe' | 'did' | 'provider-specific';
  value: string;
  issuer?: string;
  subject?: string;
  evidenceRefs?: Array<ExternalRef>;
  extensions?: Extensions;
};
export type InspectRequest = {
  exact: { exactPurl: string } | { ecosystem: string; coordinate: string };
  includeRawMetadata?: boolean;
  context?: RequestContext;
};
export type InspectResponse = { meta: ProtocolMeta; package: PackageInstance };
export type InstallSideEffects =
  | 'none'
  | 'project-store'
  | 'user-profile'
  | 'system'
  | 'unknown';
export type KeyRotation = {
  previousKeyId: string;
  nextKeyId: string;
  nextPublicKey: {
    kty: 'OKP';
    crv: 'Ed25519';
    x: string;
    [key: string]: JsonValue;
  };
  rotatedAt: string;
  signature: string;
};
export type LifecycleApplyRequest = LifecycleEvent;
export type LifecycleApplyResponse = { applied: LifecycleEvent };
export type LifecycleChangedData = {
  schemaVersion: '1';
  lifecycleEvent: LifecycleEvent;
};
export type LifecycleChangedEvent = CloudEventCommon & {
  type: 'org.openpacker.lifecycle.changed';
  dataschema: 'https://openpacker.dev/spec/prex/v1/events/data.schema.json#/$defs/org.openpacker.lifecycle.changed';
  data: LifecycleChangedData;
};
export type LifecycleEvent = {
  eventVersion: '1';
  eventId: string;
  subject: PackageIdentity | Digest;
  action:
    | 'published'
    | 'yanked'
    | 'deprecated'
    | 'quarantined'
    | 'revoked'
    | 'delisted'
    | 'restored'
    | 'promoted'
    | 'removed-from-channel'
    | 'ownership-transferred';
  effectiveAt: string;
  issuedAt: string;
  actor: IdentityRef;
  authority:
    | 'publisher'
    | 'registry'
    | 'organization'
    | 'user'
    | 'test-fixture';
  reasonCode: string;
  reason?: string;
  replacementRefs: Array<ExternalRef>;
  expiresAt?: string;
  sourceSnapshot: Digest;
  evidenceRefs: Array<ExternalRef>;
  externalRefs: Array<ExternalRef>;
  extensions?: Extensions;
};
export type LifecycleState = {
  status:
    | 'published'
    | 'yanked'
    | 'deprecated'
    | 'quarantined'
    | 'revoked'
    | 'delisted'
    | 'restored'
    | 'promoted'
    | 'removed-from-channel'
    | 'ownership-transferred'
    | 'unknown';
  eligible: boolean;
  warnings: Array<Warning>;
  derivationEventIds?: Array<string>;
};
export type LockImportRequest = {
  lockfile: string;
  format?:
    | 'auto'
    | 'package-lock'
    | 'cargo-lock'
    | 'nuget-assets'
    | 'nuget-packages-lock'
    | 'uv-lock'
    | 'go-sum'
    | 'gradle-lockfile';
  ecosystem?: 'npm' | 'cargo' | 'nuget' | 'pypi' | 'golang' | 'maven';
  evaluationTime?: string;
  target?: TargetContext;
  policy?: PolicyInput;
  objectives?: Array<string>;
};
export type LockImportResponse = {
  lockCapture: {
    format: string;
    formatVersion: string;
    sourceDigest?: string;
    packages: Array<{
      exactPurl: string;
      nativeCoordinate: string;
      resolved?: string;
      artifactDigest?: string;
      dependencies: { [key: string]: string };
      native: JsonValue;
    }>;
    semanticLoss: Array<SemanticLoss>;
  };
  solveResponse: SolveResponse;
  lockfile: {
    schemaVersion: '1';
    protocolVersion: '1.0-draft';
    rootRequirements: Array<Requirement>;
    target: TargetContext;
    semanticsProfile:
      | 'native-capture-v1'
      | 'native-validated-v1'
      | 'prex-calculus-subset-v1';
    objectiveOrdering: Array<
      | 'satisfy-hard-constraints'
      | 'preserve-locks'
      | 'minimize-changes'
      | 'minimize-package-count'
      | 'exclude-lifecycle-denied'
      | 'prefer-stable'
      | 'prefer-highest-native-version'
      | 'canonical-lexical-tie-break'
    >;
    selectedExactPurls: Array<string>;
    dependencyEdges: Array<DependencyEdge>;
    artifactDescriptors: Array<ArtifactDescriptor>;
    ocmReferences: Array<ExternalRef>;
    sourceSnapshotDigests: Array<Digest>;
    lifecycleRoot: Digest;
    policyDigest: Digest;
    solutionDigest: Digest;
    receiptDigest: Digest;
    externalRefs: Array<ExternalRef>;
    platforms?: PlatformContexts;
    selectedOutputs?: Array<{ exactPurl: string; outputs: Array<OutputName> }>;
    recipeDigests?: Array<Digest>;
    substitutes?: Array<SubstituteDescriptor>;
    environment?: { name: EnvironmentName; baseGenerationDigest?: Digest };
    extensions?: Extensions;
  };
  semanticLoss: Array<SemanticLoss>;
};
export type ManifestSignature = {
  algorithm: 'ed25519';
  keyId: string;
  signature: string;
  identity?: string;
  role?: 'publisher' | 'registry';
};
export type MaterializeRequest = {
  subject:
    | { type: 'purl'; exactPurl: string }
    | { type: 'solution-node'; nodeId: string }
    | { type: 'artifact'; descriptor: ArtifactDescriptor }
    | { type: 'digest'; digest: Digest }
    | {
        type: 'ocm';
        component: string;
        version: string;
        resourceName?: string;
        descriptorDigest?: Digest;
      };
  forensic?: boolean;
  outputs?: Array<OutputName>;
  target?: TargetContext;
  policy?: PolicyInput;
  resourceLimits?: ResourceLimits;
  context?: RequestContext;
};
export type MaterializeResponse = {
  meta: ProtocolMeta;
  descriptor: ArtifactDescriptor;
  sources?: Array<ArtifactLocation>;
  credentialRequirements?: Array<{
    credentialRef: string;
    transport: string;
    sourceUri?: string;
  }>;
  rangeSupported?: boolean;
  chunkIndexRef?: ExternalRef;
  ociReferrers?: Array<ExternalRef>;
  ocmReference?: ExternalRef;
  tufTargetMetadataRef?: ExternalRef;
  restrictions: Array<string>;
};
export type NamespaceHolder = {
  holderId: HolderId;
  namespaces: Array<{
    namespace: string;
    method: 'dns-txt' | 'https-well-known' | 'registry-configured';
    keyIds?: Array<string>;
    verifiedAt?: string;
    packageCount?: number;
  }>;
  firstSeen?: string;
  quota?: PublishQuota;
};
export type NamespaceProof = {
  namespace: string;
  method: 'dns-txt' | 'https-well-known' | 'registry-configured';
  keyId: string;
  evidence?: string;
  verifiedAt?: string;
};
export type NativeIntegrity = {
  algorithm: string;
  value: string;
  encoding: 'hex' | 'base64' | 'sri';
};
export type NormalizeInput =
  | { type: 'purl'; value: string }
  | { type: 'vers'; value: string }
  | {
      type: 'native-coordinate' | 'native-version' | 'native-range';
      ecosystem: string;
      value: string;
    }
  | { type: 'digest'; value: DigestString }
  | { type: 'target'; value: TargetContext };
export type NormalizeRequest = {
  items: Array<NormalizeInput>;
  context?: RequestContext;
};
export type NormalizeResponse = {
  meta: ProtocolMeta;
  results: Array<NormalizeResult>;
};
export type NormalizeResult = {
  type: string;
  original: CanonicalJsonValue;
  canonical: CanonicalJsonValue;
  parsed: { [key: string]: CanonicalJsonValue };
  ecosystem?: string;
  scheme?: string;
  reversibility: 'exact' | 'lossy' | 'not-applicable';
  warnings: Array<Warning>;
  semanticLoss: Array<SemanticLoss>;
};
export type OciDescriptor = {
  mediaType: string;
  digest: string;
  size: number;
  artifactType?: string;
  annotations?: { [key: string]: string };
};
export type OpenPackerCloudEvent =
  | CatalogSnapshotCreatedEvent
  | CatalogPackageObservedEvent
  | LifecycleChangedEvent
  | ResolutionCompletedEvent
  | ResolutionUnsatisfiableEvent
  | ReceiptCreatedEvent
  | ArtifactPackedEvent
  | ArtifactVerifiedEvent
  | PolicyEvaluatedEvent;
export type OpenPackerLockfile = {
  schemaVersion: '1';
  protocolVersion: '1.0-draft';
  rootRequirements: Array<Requirement>;
  target: TargetContext;
  semanticsProfile:
    | 'native-capture-v1'
    | 'native-validated-v1'
    | 'prex-calculus-subset-v1';
  objectiveOrdering: Array<
    | 'satisfy-hard-constraints'
    | 'preserve-locks'
    | 'minimize-changes'
    | 'minimize-package-count'
    | 'exclude-lifecycle-denied'
    | 'prefer-stable'
    | 'prefer-highest-native-version'
    | 'canonical-lexical-tie-break'
  >;
  selectedExactPurls: Array<string>;
  dependencyEdges: Array<DependencyEdge>;
  artifactDescriptors: Array<ArtifactDescriptor>;
  ocmReferences: Array<ExternalRef>;
  sourceSnapshotDigests: Array<Digest>;
  lifecycleRoot: Digest;
  policyDigest: Digest;
  solutionDigest: Digest;
  receiptDigest: Digest;
  externalRefs: Array<ExternalRef>;
  platforms?: PlatformContexts;
  selectedOutputs?: Array<{ exactPurl: string; outputs: Array<OutputName> }>;
  recipeDigests?: Array<Digest>;
  substitutes?: Array<SubstituteDescriptor>;
  environment?: { name: EnvironmentName; baseGenerationDigest?: Digest };
  extensions?: Extensions;
};
export type OpenPackerOverlay = {
  overlayVersion: '1';
  subject: PackageIdentity;
  appliesToMetadataDigest?: Digest;
  requirements: Array<Requirement>;
  capabilities: Array<Capability>;
  conflicts: Array<Conflict>;
  cardinalityConstraints: Array<CardinalityConstraint>;
  artifactAnnotations: Array<{
    descriptorId: string;
    annotations: { [key: string]: string };
  }>;
  sourceRefs: Array<SourceRef>;
  authority:
    | 'publisher'
    | 'registry'
    | 'organization'
    | 'user'
    | 'test-fixture';
  evidenceRefs: Array<ExternalRef>;
  externalRefs: Array<ExternalRef>;
  extensions?: Extensions;
};
export type OutputName = string;
export type PackRequest = {
  exactPurl: string;
  artifact: ArtifactDescriptor;
  reference?: string;
};
export type PackResponse = {
  manifest: OciDescriptor;
  nativeBlob: OciDescriptor;
  artifact: ArtifactDescriptor;
};
export type PackageIdentity = {
  canonicalPurl: string;
  exactPurl?: string;
  purlType: string;
  namespace?: string;
  name: string;
  version?: string;
  qualifiers: { [key: string]: string };
  subpath?: string;
  nativeCoordinates: Array<{
    ecosystem: string;
    coordinate: string;
    version?: string;
  }>;
  aliases: Array<string>;
  sourceRefs: Array<SourceRef>;
  publisherRefs: Array<IdentityRef>;
  externalRefs: Array<ExternalRef>;
  extensions?: Extensions;
};
export type PackageInstance = {
  nodeId: string;
  identity: PackageIdentity;
  nativeVersion: string;
  normalizedVersion: string;
  versionSortKey: string;
  requirements: Array<Requirement>;
  capabilities: Array<Capability>;
  conflicts: Array<Conflict>;
  cardinalityConstraints: Array<CardinalityConstraint>;
  artifacts: Array<ArtifactDescriptor>;
  outputs?: Array<PackageOutput>;
  lifecycle: LifecycleState;
  sourceSnapshots: Array<Digest>;
  metadataDigest: Digest;
  rawMetadataRef?: ExternalRef;
  nativeSemantics: { version: string; data: CanonicalJsonValue };
  semanticLoss: Array<SemanticLoss>;
  extensions?: Extensions;
};
export type PackageManifest = {
  packageManifestVersion: PackageManifestVersion;
  name: string;
  title?: string;
  description?: string;
  version: string;
  websiteUrl?: string;
  licenses?: Array<string>;
  repository?: RepositoryRef;
  registries?: Array<RegistryRef>;
  distributions: Array<Distribution>;
  provenance?: Provenance;
  semanticLoss?: Array<SemanticLoss>;
  extensions?: Extensions;
};
export type PackageManifestVersion = '1';
export type PackageOutput = {
  name: OutputName;
  default?: boolean;
  description?: string;
  artifactDescriptorIds?: Array<string>;
  recipeOutputId?: Digest;
};
export type PackagePage = {
  packages: Array<RegistryEntry>;
  metadata: PageMetadata;
};
export type PackageRedirect = {
  redirectVersion: '1';
  from: string;
  to: string;
  effectiveAt: string;
  reason: 'rename' | 'transfer';
  previousHolder?: HolderId;
  nextHolder?: HolderId;
};
export type PageMetadata = {
  count: number;
  nextCursor?: Cursor | null;
  unavailable?: Array<{ sourceId: string; reason: string }>;
  searchMode?: 'indexed' | 'scan';
};
export type PlatformContexts = {
  build?: TargetContext;
  host?: TargetContext;
  target?: TargetContext;
};
export type PolicyEvaluatedData = {
  schemaVersion: '1';
  subjectDigest: Digest;
  decision: 'allow' | 'deny' | 'indeterminate';
  policyDigest?: Digest;
};
export type PolicyEvaluatedEvent = CloudEventCommon & {
  type: 'org.openpacker.policy.evaluated';
  dataschema: 'https://openpacker.dev/spec/prex/v1/events/data.schema.json#/$defs/org.openpacker.policy.evaluated';
  data: PolicyEvaluatedData;
};
export type PolicyInput = {
  allowYanked: boolean;
  allowQuarantined: boolean;
  semanticLossMaximum: 'info' | 'warning' | 'error';
  requiredEvidence: Array<string>;
  acceptedOverlayAuthorities?: Array<
    'publisher' | 'registry' | 'organization' | 'user' | 'test-fixture'
  >;
  allowDeprecated?: boolean;
  allowDelisted?: boolean;
  allowRevoked?: boolean;
  requireFreshTufMetadata?: boolean;
  acceptedSignerIdentityPatterns?: Array<string>;
  sigstore?: {
    required?: boolean;
    issuerPatterns?: Array<string>;
    identityPatterns?: Array<string>;
    requireTransparencyEvidence?: boolean;
  };
  slsa?: {
    required?: boolean;
    predicateTypes?: Array<string>;
    builderIds?: Array<string>;
    buildTypes?: Array<string>;
  };
  licenses?: {
    allowed?: Array<string>;
    denied?: Array<string>;
    allowUnknown?: boolean;
    allowMissing?: boolean;
  };
  allowedProviderIds?: Array<string>;
  allowedArtifactSourceSchemes?: Array<string>;
  allowedTargets?: Array<TargetPredicate>;
  maximumArtifactSize?: number;
  maximumExpandedMaterializationSize?: number;
  deniedSemanticLossCodes?: Array<string>;
  requiredSourceSnapshotDigests?: Array<Digest>;
  permitForensicDigestMaterialization?: boolean;
  minimumReleaseAgeMinutes?: number;
  minimumReleaseAgeExclude?: Array<string>;
  minimumReleaseAgeStrict?: boolean;
  trustPolicy?: 'none' | 'no-downgrade';
  trustPolicyExclude?: Array<string>;
  blockExoticSources?: { direct?: boolean; transitive?: boolean };
  allowLifecycleScripts?: boolean;
  allowedLifecycleScriptPackages?: Array<string>;
  expectedRegistryId?: string;
  extensions?: Extensions;
  acceptedAmendmentAuthorities?: Array<
    'publisher' | 'registry' | 'organization' | 'user' | 'test-fixture'
  >;
};
export type PositiveLimit = number;
export type Problem = {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  code: ErrorCode;
  retryable: boolean;
  correlationId?: string;
  violations?: Array<{ path: string; code: string; message: string }>;
  explanationRef?: string;
  provider?: string;
  upstreamStatus?: number;
  normalizedRequest?: SolveRequest;
  requestDigest?: Digest;
  universeDigest?: Digest;
  unsatCore?: Array<string>;
  constraintSources?: Array<{ constraintId: string; source: SourceRef }>;
  candidateRejections?: Array<{ nodeId: string; reasonRefs: Array<string> }>;
  suggestions?: Array<{ code: string; derivation: string }>;
  extensions?: Extensions;
};
export type ProofChecks = Array<{
  id: string;
  valid: boolean;
  evidence: CanonicalJsonValue;
}>;
export type ProtocolMeta = {
  protocolVersion: '1.0-draft';
  provider: {
    id: string;
    implementation: string;
    version: string;
    buildDigest?: Digest;
  };
  warnings?: Array<Warning>;
  extensions?: Extensions;
};
export type Provenance = {
  producedBy?: { id: string; version: string };
  producedAt?: string;
  sourceRefs?: Array<SourceRef>;
  snapshotDigest?: Digest;
  receiptDigest?: Digest;
  policyDigest?: Digest;
  trustLevel?:
    | 'trusted-publisher'
    | 'provenance'
    | 'registry-attested'
    | 'unsigned'
    | 'unknown';
  evidence?: Array<ExternalRef>;
  verified?: Array<
    | 'artifact-digest'
    | 'native-integrity'
    | 'registry-identity'
    | 'receipt-signature'
    | 'supply-chain-policy'
  >;
};
export type PublishQuota = {
  limit: number;
  windowSeconds: number;
  remaining: number;
  resetAt?: string;
};
export type PublishRequest = {
  descriptor: ArtifactDescriptor;
  location: ArtifactLocation;
};
export type PublishResponse = PublishRequest;
export type PurlType = string;
export type ReceiptCreatedData = { schemaVersion: '1'; receiptDigest: Digest };
export type ReceiptCreatedEvent = CloudEventCommon & {
  type: 'org.openpacker.receipt.created';
  dataschema: 'https://openpacker.dev/spec/prex/v1/events/data.schema.json#/$defs/org.openpacker.receipt.created';
  data: ReceiptCreatedData;
};
export type RegistryDefinition = {
  registryDefinitionVersion: RegistryDefinitionVersion;
  registryId: RegistryId;
  displayName?: string;
  purlTypes: Array<PurlType>;
  protocol?: RegistryProtocol;
  resources: Array<RegistryResource>;
  features?: RegistryFeatures;
  limits?: RegistryLimits;
  semanticLossDefaults?: Array<SemanticLoss>;
  extensions?: Extensions;
};
export type RegistryDefinitionVersion = '1';
export type RegistryEntry = {
  manifest: PackageManifest;
  registryMetadata: RegistryMetadata;
  signatures?: Array<ManifestSignature>;
};
export type RegistryFeatures = {
  offlineReplay?: boolean;
  signedMetadata?: boolean;
  installSideEffects?: InstallSideEffects;
  reversibility?: Reversibility;
  requiresElevation?: 'never' | 'sometimes' | 'always' | 'unknown';
};
export type RegistryId = string;
export type RegistryLimits = {
  maxEnumerate?: number;
  maxSearchResults?: number;
  maxArtifactBytes?: number;
};
export type RegistryMetadata = {
  registryId: RegistryId;
  sourceId?: string;
  status: 'active' | 'deprecated' | 'deleted';
  publishedAt: string;
  updatedAt?: string;
  isLatest: boolean;
  manifestDigest?: Digest;
  serviceability?: Serviceability;
};
export type RegistryProtocol = {
  native?: string;
  transport?: Array<Transport>;
};
export type RegistryPublishRequest = {
  manifest: PackageManifest;
  manifestDigest: Digest;
  signatures?: Array<ManifestSignature>;
  namespaceProof?: NamespaceProof;
};
export type RegistryPublishResponse = { entry: RegistryEntry };
export type RegistryRef = {
  registryId: RegistryId;
  displayName?: string;
  purlTypes?: Array<PurlType>;
  serviceIndex?: string;
  definitionDigest?: Digest;
};
export type RegistryResource = {
  '@id': ResourceId;
  '@type': ResourceTypeName | Array<ResourceTypeName>;
  comment?: string;
  mediaTypes?: Array<string>;
  clientVersion?: string;
  extensions?: Extensions;
};
export type RepositoryRef = {
  url: string;
  source?: string;
  revision?: string;
  subfolder?: string;
};
export type RequestContext = {
  correlationId?: string;
  traceparent?: string;
  tracestate?: string;
  idempotencyKey?: string;
  timeoutMilliseconds?: number;
  providerIds?: StringSet;
  semanticsProfile?:
    | 'native-capture-v1'
    | 'native-validated-v1'
    | 'prex-calculus-subset-v1';
  evaluationTime?: string;
  extensions?: Extensions;
};
export type Requirement = {
  id: string;
  dependerNodeId?: string;
  expression: RequirementExpression;
  kind: RequirementKind;
  optional: boolean;
  source: SourceRef;
  authority: string;
  raw?: CanonicalJsonValue;
  nativeSemantics?: { version: string; data: CanonicalJsonValue };
  semanticLoss: Array<SemanticLoss>;
};
export type RequirementExpression =
  | {
      type: 'package';
      purl: string;
      vers?: string;
      qualifiers?: { [key: string]: string };
      outputs?: Array<OutputName>;
    }
  | {
      type: 'capability';
      name: string;
      vers?: string;
      attributes?: { [key: string]: string | boolean | number };
    }
  | { type: 'allOf' | 'anyOf'; expressions: Array<RequirementExpression> }
  | { type: 'not'; expression: RequirementExpression }
  | {
      type: 'conditional';
      when: TargetPredicate;
      then: RequirementExpression;
      else?: RequirementExpression;
    };
export type RequirementKind =
  | 'runtime'
  | 'build'
  | 'development'
  | 'peer'
  | 'optional'
  | 'feature'
  | 'tool'
  | 'platform'
  | 'replacement'
  | 'conflict'
  | 'unknown-native';
export type ResolutionCompletedData = {
  schemaVersion: '1';
  solutionDigest: Digest;
  requestDigest: Digest;
  universeDigest: Digest;
};
export type ResolutionCompletedEvent = CloudEventCommon & {
  type: 'org.openpacker.resolution.completed';
  dataschema: 'https://openpacker.dev/spec/prex/v1/events/data.schema.json#/$defs/org.openpacker.resolution.completed';
  data: ResolutionCompletedData;
};
export type ResolutionProof = {
  proofVersion: '1';
  universeDigest: Digest;
  requestDigest: Digest;
  selectedAssignments: Array<{
    nodeId: string;
    selected: boolean;
    nodeDigest: Digest;
  }>;
  requirementWitnesses: Array<{
    requirementId: string;
    status: 'satisfied' | 'optional-omitted' | 'inactive';
    witnessNodeIds: Array<string>;
  }>;
  conflictChecks: ProofChecks;
  cardinalityChecks: ProofChecks;
  targetChecks: ProofChecks;
  objectiveEvidence: ProofChecks;
  appliedAmendmentDigests?: Array<Digest>;
};
export type ResolutionReceipt = {
  receiptVersion: '1';
  protocolVersion: '1.0-draft';
  requestDigest: Digest;
  normalizedRequest: SolveRequest;
  universeDigest: Digest;
  sourceSnapshots: Array<SourceSnapshot>;
  targetDigest: Digest;
  policyDigest: Digest;
  lifecycleRoot: Digest;
  semanticsProfile:
    | 'native-capture-v1'
    | 'native-validated-v1'
    | 'prex-calculus-subset-v1';
  objectiveOrdering: Array<
    | 'satisfy-hard-constraints'
    | 'preserve-locks'
    | 'minimize-changes'
    | 'minimize-package-count'
    | 'exclude-lifecycle-denied'
    | 'prefer-stable'
    | 'prefer-highest-native-version'
    | 'canonical-lexical-tie-break'
  >;
  solutionDigest: Digest;
  proofDigest: Digest;
  explanationDigest: Digest;
  artifactSetDigest: Digest;
  resolver: {
    providerId: string;
    implementation: string;
    version: string;
    buildDigest: Digest;
  };
  evaluationTime: string;
  evidenceRefs: Array<ExternalRef>;
  externalRefs: Array<ExternalRef>;
  extensions?: Extensions;
  amendmentDigests?: Array<Digest>;
};
export type ResolutionSolution = {
  selectedNodeIds: Array<string>;
  selectedCapabilityProviders: Array<{
    capability: string;
    providerNodeId: string;
  }>;
  satisfiedRequirementIds: Array<string>;
  dependencyEdges: Array<DependencyEdge>;
  excludedCandidates: Array<{ nodeId: string; reasonRefs: Array<string> }>;
  objectiveTuple: Array<string | number | boolean>;
  semanticLoss: Array<SemanticLoss>;
  sourceSnapshotDigests: Array<Digest>;
  solutionDigest: Digest;
};
export type ResolutionUniverse = {
  universeVersion: '1';
  packages: Array<PackageInstance>;
  overlays: Array<OpenPackerOverlay>;
  sourceSnapshots: Array<SourceSnapshot>;
  recipes?: Array<BuildRecipe>;
  lifecycleRoot: Digest;
  targetVocabularyVersion: string;
  canonicalDigest: Digest;
  extensions?: Extensions;
  amendments?: Array<UniverseAmendment>;
};
export type ResolutionUnsatisfiableData = {
  schemaVersion: '1';
  requestDigest: Digest;
  universeDigest: Digest;
  explanationDigest: Digest;
};
export type ResolutionUnsatisfiableEvent = CloudEventCommon & {
  type: 'org.openpacker.resolution.unsatisfiable';
  dataschema: 'https://openpacker.dev/spec/prex/v1/events/data.schema.json#/$defs/org.openpacker.resolution.unsatisfiable';
  data: ResolutionUnsatisfiableData;
};
export type ResourceId = string;
export type ResourceLimits = {
  requestBytes: PositiveLimit;
  batchItems: PositiveLimit;
  universeNodes: PositiveLimit;
  graphNodes: PositiveLimit;
  artifactMetadataBytes: PositiveLimit;
  requirements?: PositiveLimit;
  alternativesPerRequirement?: PositiveLimit;
  predicateDepth?: PositiveLimit;
  requirementDepth?: PositiveLimit;
  overlays?: PositiveLimit;
  metadataBytes?: PositiveLimit;
  solveWallTimeMilliseconds?: PositiveLimit;
  solverMemoryBytes?: PositiveLimit;
  explanationEdges?: PositiveLimit;
};
export type ResourceTypeName = string;
export type Reversibility =
  | 'none'
  | 'uninstall'
  | 'project-generation'
  | 'native-generation'
  | 'unknown';
export type RevocationEntry = {
  keyId: string;
  revokedAt: string;
  effective: 'from-now' | 'retroactive';
  reason?: 'rotated' | 'compromised' | 'retired' | 'unspecified';
  detail?: string;
  replacedBy?: string;
};
export type RevocationList = {
  revocationListVersion: '1';
  registryId: RegistryId;
  serial: number;
  issuedAt: string;
  expiresAt?: string;
  revoked: Array<RevocationEntry>;
};
export type RuntimeClosure = {
  closureVersion: '1';
  rootNodeIds: Array<string>;
  members: Array<ClosureMember>;
  edges: Array<ClosureEdge>;
  completeness: 'declared' | 'scanned' | 'reconciled';
  semanticLoss?: Array<SemanticLoss>;
  extensions?: Extensions;
};
export type SafeInteger = number;
export type SemanticLoss = {
  code: string;
  severity: 'info' | 'warning' | 'error';
  sourceEcosystem: string;
  sourcePath: string;
  originalMeaning: string;
  representedMeaning?: string;
  omittedMeaning?: string;
  mitigation?: string;
  blocksProfile: Array<
    | 'native-capture-v1'
    | 'native-validated-v1'
    | 'prex-calculus-subset-v1'
    | 'derivation-capture-v1'
  >;
};
export type SemanticsInput = {
  profile:
    | 'native-capture-v1'
    | 'native-validated-v1'
    | 'prex-calculus-subset-v1';
  nativeCompatibility: Array<string>;
  extensions?: Extensions;
};
export type Serviceability = {
  state: 'verified' | 'gated' | 'unreachable' | 'unchecked';
  checkedAt: string;
  method: 'digest-match' | 'head' | 'status' | 'none';
  detail?: string;
};
export type SignedPackageManifest = {
  manifest: PackageManifest;
  manifestDigest: Digest;
  signatures: Array<ManifestSignature>;
};
export type SignedPackageRedirect = {
  redirect: PackageRedirect;
  redirectDigest: Digest;
  signatures: Array<ManifestSignature>;
};
export type SignedReceipt = {
  receipt: ResolutionReceipt;
  receiptDigest: Digest;
  signatures: Array<{
    algorithm: 'ed25519';
    keyId: string;
    signature: string;
    identity?: IdentityRef;
  }>;
};
export type SignedRevocationList = {
  list: RevocationList;
  listDigest: Digest;
  signatures: Array<ManifestSignature>;
};
export type SolveRequest = {
  requirements: Array<Requirement>;
  target: TargetContext;
  platforms?: PlatformContexts;
  requirementKindPolicy?: {
    buildPlatformKinds?: Array<RequirementKind>;
    inactiveKinds?: Array<RequirementKind>;
  };
  environment: {
    installed: Array<string>;
    locked: Array<string>;
    generationDigest?: Digest;
  };
  policy: PolicyInput;
  semantics: SemanticsInput;
  objectives: Array<
    | 'satisfy-hard-constraints'
    | 'preserve-locks'
    | 'minimize-changes'
    | 'minimize-package-count'
    | 'exclude-lifecycle-denied'
    | 'prefer-stable'
    | 'prefer-highest-native-version'
    | 'canonical-lexical-tie-break'
  >;
  mode: 'closure' | 'direct' | 'validate-native';
  evaluationTime: string;
  providerPolicy?: { providerIds?: Array<string> };
  timeoutMilliseconds?: number;
  resourceLimits?: ResourceLimits;
  context?: RequestContext;
  extensions?: Extensions;
};
export type SolveResponse = {
  meta: ProtocolMeta;
  normalizedRequest: SolveRequest;
  requestDigest: Digest;
  universeDigest: Digest;
  selected: Array<PackageInstance>;
  solution: ResolutionSolution;
  proof: ResolutionProof;
  explanation: ExplanationGraph;
  unsignedReceipt: ResolutionReceipt;
  signedReceipt?: SignedReceipt;
};
export type SourceRef = {
  type: 'repository' | 'registry' | 'metadata' | 'overlay' | 'lockfile' | 'api';
  uri: string;
  revision?: string;
  digest?: Digest;
  path?: string;
  extensions?: Extensions;
};
export type SourceSnapshot = {
  snapshotId: string;
  providerId: string;
  providerType: string;
  endpointIdentity: string;
  retrievedAt: string;
  evaluationTime: string;
  revision?: string;
  etag?: string;
  rootDigest: Digest;
  recordsDigest: Digest;
  authenticationScopeRef?: string;
  evidenceRefs: Array<ExternalRef>;
  extensions?: Extensions;
};
export type StatusUpdate = {
  status: 'active' | 'deprecated' | 'deleted';
  reason?: string;
};
export type StringSet = Array<string>;
export type SubstituteDescriptor = {
  substituteVersion: '1';
  subject: { artifactDigest: Digest; recipeOutputId?: Digest; nodeId?: string };
  treeDigest: Digest;
  size: number;
  runtimeReferences: Array<ArtifactReference>;
  deriver?: Digest;
  chunkIndexRef?: ExternalRef;
  locations: Array<ArtifactLocation>;
  evidenceRefs?: Array<ExternalRef>;
  extensions?: Extensions;
};
export type TargetContext = {
  os?: string;
  architecture?: string;
  libc?: string;
  kernel?: string;
  runtimes?: { [key: string]: string };
  abi?: { [key: string]: string };
  capabilities?: Array<{
    name: string;
    version?: string;
    attributes?: { [key: string]: string | boolean | number };
  }>;
  variables?: { [key: string]: string | boolean | number };
  extensions?: Extensions;
};
export type TargetPredicate =
  | { type: 'true' | 'false' }
  | {
      type: 'equals' | 'notEquals';
      path: string;
      value: string | boolean | number;
    }
  | {
      type: 'in' | 'notIn';
      path: string;
      values: Array<string | boolean | number>;
    }
  | { type: 'versionSatisfies'; path: string; constraint: VersionConstraint }
  | { type: 'capabilityPresent'; name: string; constraint?: VersionConstraint }
  | { type: 'allOf' | 'anyOf'; predicates: Array<TargetPredicate> }
  | { type: 'not'; predicate: TargetPredicate };
export type Transport =
  | 'https'
  | 'http'
  | 'file'
  | 'exec'
  | 'git'
  | 'oci'
  | 'nix'
  | 'other';
export type TreeManifest = {
  manifestVersion: '1';
  entries: Array<TreeManifestEntry>;
  semanticLoss?: Array<SemanticLoss>;
  extensions?: Extensions;
};
export type TreeManifestEntry = {
  path: string;
  kind: 'file' | 'executable' | 'directory' | 'symlink';
  digest?: Digest;
  size?: number;
  target?: string;
};
export type UniverseAmendment = {
  amendmentVersion: '1';
  subject: PackageIdentity;
  appliesToMetadataDigest: Digest;
  operations: Array<AmendmentOperation>;
  authority:
    | 'publisher'
    | 'registry'
    | 'organization'
    | 'user'
    | 'test-fixture';
  justification?: string;
  sourceRefs: Array<SourceRef>;
  evidenceRefs: Array<ExternalRef>;
  externalRefs?: Array<ExternalRef>;
  extensions?: Extensions;
};
export type VerificationCheck =
  | (
      | 'artifact-digest'
      | 'artifact-size'
      | 'oci-descriptors'
      | 'ocm-integrity'
      | 'receipt-signature'
      | 'receipt-bindings'
      | 'tuf-metadata'
      | 'sigstore-bundle'
      | 'slsa-subject'
      | 'cyclonedx-sbom'
      | 'lifecycle-eligibility'
      | 'policy'
    )
  | string;
export type VerifyRequest = {
  subject: ArtifactDescriptor | SignedReceipt | ExternalRef;
  checks: Array<VerificationCheck>;
  evidenceRefs?: Array<ExternalRef>;
  policy?: PolicyInput;
  resourceLimits?: ResourceLimits;
  evaluationTime: string;
  context?: RequestContext;
};
export type VerifyResponse = {
  meta: ProtocolMeta;
  decision: 'allow' | 'deny' | 'indeterminate';
  policyDigest?: Digest;
  evidence: Array<EvidenceResult>;
  diagnostics?: Array<Warning>;
};
export type VersionConstraint = {
  vers?: string;
  scheme: string;
  original: string;
  normalized: string;
  ast: VersionConstraintAst;
  reversible: boolean;
  semanticLoss: Array<SemanticLoss>;
};
export type VersionConstraintAst =
  | {
      type: 'comparison';
      operator: '=' | '!=' | '>' | '>=' | '<' | '<=';
      version: string;
    }
  | { type: 'and' | 'or'; items: Array<VersionConstraintAst> }
  | { type: 'not'; item: VersionConstraintAst }
  | { type: 'any' };
export type VersionList = {
  name: string;
  versions: Array<{
    version: string;
    status: 'active' | 'deprecated' | 'deleted';
    isLatest: boolean;
    publishedAt?: string;
  }>;
  redirectedFrom?: string;
  redirects?: Array<PackageRedirect>;
};
export type Warning = {
  code: string;
  message: string;
  path?: string;
  extensions?: Extensions;
};

export const DIGEST_PROJECTIONS = {
  projectionVersion: '1',
  projections: [
    {
      id: 'request-v1',
      algorithm: 'sha256',
      canonicalization: 'prex-jcs-safe-integer-v1',
      includePaths: [],
      excludePaths: ['/context'],
      orderedSetPaths: [
        '/environment/installed',
        '/environment/locked',
        '/policy/requiredEvidence',
        '/requirements',
      ],
    },
    {
      id: 'universe-v1',
      algorithm: 'sha256',
      canonicalization: 'prex-jcs-safe-integer-v1',
      includePaths: [],
      excludePaths: ['/canonicalDigest'],
      orderedSetPaths: [
        '/amendments',
        '/overlays',
        '/packages',
        '/recipes',
        '/sourceSnapshots',
      ],
    },
    {
      id: 'package-node-v1',
      algorithm: 'sha256',
      canonicalization: 'prex-jcs-safe-integer-v1',
      includePaths: [
        '/identity/exactPurl',
        '/identity/qualifiers',
        '/nativeSemantics/version',
      ],
      excludePaths: [],
      orderedSetPaths: [],
    },
    {
      id: 'metadata-record-v1',
      algorithm: 'sha256',
      canonicalization: 'prex-jcs-safe-integer-v1',
      includePaths: [],
      excludePaths: [],
      orderedSetPaths: [],
    },
    {
      id: 'solution-v1',
      algorithm: 'sha256',
      canonicalization: 'prex-jcs-safe-integer-v1',
      includePaths: [],
      excludePaths: ['/solutionDigest'],
      orderedSetPaths: [
        '/dependencyEdges',
        '/excludedCandidates',
        '/satisfiedRequirementIds',
        '/selectedCapabilityProviders',
        '/selectedNodeIds',
        '/semanticLoss',
        '/sourceSnapshotDigests',
      ],
    },
    {
      id: 'proof-v1',
      algorithm: 'sha256',
      canonicalization: 'prex-jcs-safe-integer-v1',
      includePaths: [],
      excludePaths: [],
      orderedSetPaths: [
        '/appliedAmendmentDigests',
        '/cardinalityChecks',
        '/conflictChecks',
        '/objectiveEvidence',
        '/requirementWitnesses',
        '/selectedAssignments',
        '/targetChecks',
      ],
    },
    {
      id: 'explanation-v1',
      algorithm: 'sha256',
      canonicalization: 'prex-jcs-safe-integer-v1',
      includePaths: [],
      excludePaths: ['/renderHints'],
      orderedSetPaths: ['/edges', '/nodes', '/roots', '/unsatCore'],
    },
    {
      id: 'artifact-set-v1',
      algorithm: 'sha256',
      canonicalization: 'prex-jcs-safe-integer-v1',
      includePaths: [],
      excludePaths: ['/items/*/locations'],
      orderedSetPaths: ['/items'],
    },
    {
      id: 'receipt-v1',
      algorithm: 'sha256',
      canonicalization: 'prex-jcs-safe-integer-v1',
      includePaths: [],
      excludePaths: [],
      orderedSetPaths: [
        '/amendmentDigests',
        '/evidenceRefs',
        '/externalRefs',
        '/sourceSnapshots',
      ],
    },
    {
      id: 'event-data-v1',
      algorithm: 'sha256',
      canonicalization: 'prex-jcs-safe-integer-v1',
      includePaths: [],
      excludePaths: [],
      orderedSetPaths: [],
    },
    {
      id: 'tree-manifest-v1',
      algorithm: 'sha256',
      canonicalization: 'prex-jcs-safe-integer-v1',
      includePaths: [],
      excludePaths: [],
      orderedSetPaths: ['/entries', '/semanticLoss'],
    },
    {
      id: 'build-recipe-v1',
      algorithm: 'sha256',
      canonicalization: 'prex-jcs-safe-integer-v1',
      includePaths: [],
      excludePaths: [],
      orderedSetPaths: [
        '/attestations',
        '/evidenceRefs',
        '/inputs',
        '/outputs',
        '/semanticLoss',
        '/sourceRefs',
      ],
    },
    {
      id: 'recipe-output-v1',
      algorithm: 'sha256',
      canonicalization: 'prex-jcs-safe-integer-v1',
      includePaths: [],
      excludePaths: [],
      orderedSetPaths: [],
    },
    {
      id: 'substitute-v1',
      algorithm: 'sha256',
      canonicalization: 'prex-jcs-safe-integer-v1',
      includePaths: [],
      excludePaths: ['/locations'],
      orderedSetPaths: ['/evidenceRefs', '/runtimeReferences'],
    },
    {
      id: 'environment-manifest-v1',
      algorithm: 'sha256',
      canonicalization: 'prex-jcs-safe-integer-v1',
      includePaths: [],
      excludePaths: [],
      orderedSetPaths: ['/requirements'],
    },
    {
      id: 'environment-generation-v1',
      algorithm: 'sha256',
      canonicalization: 'prex-jcs-safe-integer-v1',
      includePaths: [],
      excludePaths: ['/generationDigest'],
      orderedSetPaths: ['/artifactSet', '/semanticLoss'],
    },
    {
      id: 'closure-v1',
      algorithm: 'sha256',
      canonicalization: 'prex-jcs-safe-integer-v1',
      includePaths: [],
      excludePaths: [],
      orderedSetPaths: ['/edges', '/members', '/rootNodeIds', '/semanticLoss'],
    },
  ],
} as const;

export const schemaCatalog: Record<string, JsonValue> = {
  'https://openpacker.dev/spec/prex/v1/schemas/common.schema.json': {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://openpacker.dev/spec/prex/v1/schemas/common.schema.json',
    title: 'PREX common types',
    $defs: {
      SafeInteger: {
        type: 'integer',
        minimum: -9007199254740991,
        maximum: 9007199254740991,
      },
      CanonicalJsonValue: {
        $comment:
          'PREX validators additionally enforce a maximum nesting depth of 64 and at most 1000000 total values per protocol document.',
        oneOf: [
          {
            type: 'null',
          },
          {
            type: 'boolean',
          },
          {
            $ref: '#/$defs/SafeInteger',
          },
          {
            type: 'string',
            maxLength: 1048576,
          },
          {
            type: 'array',
            maxItems: 100000,
            items: {
              $ref: '#/$defs/CanonicalJsonValue',
            },
          },
          {
            type: 'object',
            maxProperties: 100000,
            propertyNames: {
              maxLength: 4096,
            },
            additionalProperties: {
              $ref: '#/$defs/CanonicalJsonValue',
            },
          },
        ],
      },
      Extensions: {
        type: 'object',
        maxProperties: 64,
        propertyNames: {
          pattern: '^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$',
        },
        additionalProperties: {
          $ref: '#/$defs/CanonicalJsonValue',
        },
      },
      DigestProjection: {
        type: 'object',
        required: [
          'id',
          'algorithm',
          'canonicalization',
          'includePaths',
          'excludePaths',
          'orderedSetPaths',
        ],
        properties: {
          id: {
            enum: [
              'request-v1',
              'universe-v1',
              'package-node-v1',
              'metadata-record-v1',
              'solution-v1',
              'proof-v1',
              'explanation-v1',
              'artifact-set-v1',
              'receipt-v1',
              'event-data-v1',
              'tree-manifest-v1',
              'build-recipe-v1',
              'recipe-output-v1',
              'substitute-v1',
              'environment-manifest-v1',
              'environment-generation-v1',
              'closure-v1',
            ],
          },
          algorithm: {
            const: 'sha256',
          },
          canonicalization: {
            const: 'prex-jcs-safe-integer-v1',
          },
          includePaths: {
            type: 'array',
            maxItems: 128,
            uniqueItems: true,
            items: {
              type: 'string',
              pattern: '^(?:|/.*)$',
              maxLength: 4096,
            },
          },
          excludePaths: {
            type: 'array',
            maxItems: 128,
            uniqueItems: true,
            items: {
              type: 'string',
              pattern: '^/.*',
              maxLength: 4096,
            },
          },
          orderedSetPaths: {
            type: 'array',
            maxItems: 128,
            uniqueItems: true,
            items: {
              type: 'string',
              pattern: '^/.*',
              maxLength: 4096,
            },
          },
        },
        additionalProperties: false,
      },
      Digest: {
        type: 'object',
        required: ['algorithm', 'value'],
        properties: {
          algorithm: {
            const: 'sha256',
          },
          value: {
            type: 'string',
            pattern: '^[0-9a-f]{64}$',
          },
        },
        additionalProperties: false,
        examples: [
          {
            algorithm: 'sha256',
            value:
              'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          },
        ],
      },
      DigestString: {
        type: 'string',
        pattern: '^sha256:[0-9a-f]{64}$',
        examples: [
          'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        ],
      },
      IdentityRef: {
        type: 'object',
        required: ['type', 'value'],
        properties: {
          type: {
            enum: ['uri', 'key', 'oidc', 'spiffe', 'did', 'provider-specific'],
          },
          value: {
            type: 'string',
            minLength: 1,
            maxLength: 4096,
          },
          issuer: {
            type: 'string',
            maxLength: 2048,
          },
          subject: {
            type: 'string',
            maxLength: 2048,
          },
          evidenceRefs: {
            type: 'array',
            maxItems: 128,
            items: {
              $ref: '#/$defs/ExternalRef',
            },
          },
          extensions: {
            $ref: '#/$defs/Extensions',
          },
        },
        additionalProperties: false,
      },
      ExternalRef: {
        type: 'object',
        required: ['type', 'locator'],
        properties: {
          type: {
            type: 'string',
            minLength: 1,
            maxLength: 128,
          },
          locator: {
            type: 'string',
            minLength: 1,
            maxLength: 8192,
          },
          digest: {
            $ref: '#/$defs/Digest',
          },
          mediaType: {
            type: 'string',
            maxLength: 255,
          },
          annotations: {
            type: 'object',
            maxProperties: 64,
            additionalProperties: {
              type: 'string',
              maxLength: 4096,
            },
          },
          extensions: {
            $ref: '#/$defs/Extensions',
          },
        },
        additionalProperties: false,
      },
      SourceRef: {
        type: 'object',
        required: ['type', 'uri'],
        properties: {
          type: {
            enum: [
              'repository',
              'registry',
              'metadata',
              'overlay',
              'lockfile',
              'api',
            ],
          },
          uri: {
            type: 'string',
            format: 'uri',
            maxLength: 8192,
          },
          revision: {
            type: 'string',
            maxLength: 1024,
          },
          digest: {
            $ref: '#/$defs/Digest',
          },
          path: {
            type: 'string',
            maxLength: 4096,
          },
          extensions: {
            $ref: '#/$defs/Extensions',
          },
        },
        additionalProperties: false,
      },
      SemanticLoss: {
        type: 'object',
        required: [
          'code',
          'severity',
          'sourceEcosystem',
          'sourcePath',
          'originalMeaning',
          'blocksProfile',
        ],
        properties: {
          code: {
            type: 'string',
            pattern: '^[A-Z][A-Z0-9_]{2,127}$',
          },
          severity: {
            enum: ['info', 'warning', 'error'],
          },
          sourceEcosystem: {
            type: 'string',
            minLength: 1,
            maxLength: 64,
          },
          sourcePath: {
            type: 'string',
            maxLength: 4096,
          },
          originalMeaning: {
            type: 'string',
            minLength: 1,
            maxLength: 16384,
          },
          representedMeaning: {
            type: 'string',
            maxLength: 16384,
          },
          omittedMeaning: {
            type: 'string',
            maxLength: 16384,
          },
          mitigation: {
            type: 'string',
            maxLength: 16384,
          },
          blocksProfile: {
            type: 'array',
            maxItems: 16,
            uniqueItems: true,
            items: {
              enum: [
                'native-capture-v1',
                'native-validated-v1',
                'prex-calculus-subset-v1',
                'derivation-capture-v1',
              ],
            },
          },
        },
        additionalProperties: false,
      },
      Warning: {
        type: 'object',
        required: ['code', 'message'],
        properties: {
          code: {
            type: 'string',
            pattern: '^[A-Z][A-Z0-9_]{2,127}$',
          },
          message: {
            type: 'string',
            minLength: 1,
            maxLength: 8192,
          },
          path: {
            type: 'string',
            maxLength: 4096,
          },
          extensions: {
            $ref: '#/$defs/Extensions',
          },
        },
        additionalProperties: false,
      },
      ProtocolMeta: {
        type: 'object',
        required: ['protocolVersion', 'provider'],
        properties: {
          protocolVersion: {
            const: '1.0-draft',
          },
          provider: {
            type: 'object',
            required: ['id', 'implementation', 'version'],
            properties: {
              id: {
                type: 'string',
                minLength: 1,
                maxLength: 255,
              },
              implementation: {
                type: 'string',
                minLength: 1,
                maxLength: 255,
              },
              version: {
                type: 'string',
                minLength: 1,
                maxLength: 128,
              },
              buildDigest: {
                $ref: '#/$defs/Digest',
              },
            },
            additionalProperties: false,
          },
          warnings: {
            type: 'array',
            maxItems: 256,
            items: {
              $ref: '#/$defs/Warning',
            },
          },
          extensions: {
            $ref: '#/$defs/Extensions',
          },
        },
        additionalProperties: false,
      },
    },
  },
  'https://openpacker.dev/spec/prex/v1/schemas/environment.schema.json': {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://openpacker.dev/spec/prex/v1/schemas/environment.schema.json',
    title: 'PREX environment manifests, generations, and state',
    $defs: {
      EnvironmentName: {
        type: 'string',
        pattern: '^[a-z0-9][a-z0-9._-]{0,63}$',
      },
      EnvironmentManifest: {
        $comment:
          'The declarative input to an environment: what it should contain, for which platforms, under which policy. environment-manifest-v1 projection digest identifies it.',
        type: 'object',
        required: ['manifestVersion', 'name', 'requirements', 'target'],
        properties: {
          manifestVersion: {
            const: '1',
          },
          name: {
            $ref: '#/$defs/EnvironmentName',
          },
          description: {
            type: 'string',
            maxLength: 1024,
          },
          requirements: {
            type: 'array',
            maxItems: 10000,
            items: {
              $ref: 'model.schema.json#/$defs/Requirement',
            },
          },
          target: {
            $ref: 'model.schema.json#/$defs/TargetContext',
          },
          platforms: {
            $ref: 'model.schema.json#/$defs/PlatformContexts',
          },
          policy: {
            $ref: 'resolution.schema.json#/$defs/PolicyInput',
          },
          extensions: {
            $ref: 'common.schema.json#/$defs/Extensions',
          },
        },
        additionalProperties: false,
      },
      EnvironmentMember: {
        type: 'object',
        required: ['artifactDigest'],
        properties: {
          nodeId: {
            type: 'string',
            pattern: '^sha256:[0-9a-f]{64}$',
          },
          exactPurl: {
            type: 'string',
            pattern: '^pkg:[a-z0-9.+-]+/',
            maxLength: 8192,
          },
          artifactDigest: {
            $ref: 'common.schema.json#/$defs/Digest',
          },
          treeDigest: {
            $ref: 'common.schema.json#/$defs/Digest',
          },
          outputs: {
            type: 'array',
            maxItems: 64,
            uniqueItems: true,
            items: {
              $ref: 'model.schema.json#/$defs/OutputName',
            },
          },
        },
        additionalProperties: false,
      },
      EnvironmentGeneration: {
        $comment:
          'An immutable record of one environment state. Generations are append-only and hash-linked through parentGenerationDigest; generationDigest is the environment-generation-v1 projection digest, which excludes itself.',
        type: 'object',
        required: [
          'generationVersion',
          'environmentName',
          'sequence',
          'createdAt',
          'manifestDigest',
          'artifactSet',
          'generationDigest',
        ],
        properties: {
          generationVersion: {
            const: '1',
          },
          environmentName: {
            $ref: '#/$defs/EnvironmentName',
          },
          sequence: {
            type: 'integer',
            minimum: 1,
            maximum: 9007199254740991,
          },
          createdAt: {
            type: 'string',
            format: 'date-time',
          },
          parentGenerationDigest: {
            $comment: 'Absent only for the first generation of an environment.',
            $ref: 'common.schema.json#/$defs/Digest',
          },
          manifestDigest: {
            $ref: 'common.schema.json#/$defs/Digest',
          },
          lockfileDigest: {
            $ref: 'common.schema.json#/$defs/Digest',
          },
          solutionDigest: {
            $ref: 'common.schema.json#/$defs/Digest',
          },
          receiptDigest: {
            $ref: 'common.schema.json#/$defs/Digest',
          },
          artifactSet: {
            type: 'array',
            maxItems: 100000,
            items: {
              $ref: '#/$defs/EnvironmentMember',
            },
          },
          semanticLoss: {
            type: 'array',
            maxItems: 128,
            items: {
              $ref: 'common.schema.json#/$defs/SemanticLoss',
            },
          },
          generationDigest: {
            $ref: 'common.schema.json#/$defs/Digest',
          },
          extensions: {
            $ref: 'common.schema.json#/$defs/Extensions',
          },
        },
        additionalProperties: false,
      },
      EnvironmentState: {
        $comment:
          'The single mutable pointer for an environment. Switching and rolling back replace this record atomically; generation records themselves are never rewritten. Retained generations are the reachability roots for collection.',
        type: 'object',
        required: [
          'stateVersion',
          'environmentName',
          'currentGenerationDigest',
          'retainedGenerationDigests',
        ],
        properties: {
          stateVersion: {
            const: '1',
          },
          environmentName: {
            $ref: '#/$defs/EnvironmentName',
          },
          currentGenerationDigest: {
            $ref: 'common.schema.json#/$defs/Digest',
          },
          retainedGenerationDigests: {
            $comment: 'MUST contain currentGenerationDigest.',
            type: 'array',
            minItems: 1,
            maxItems: 10000,
            items: {
              $ref: 'common.schema.json#/$defs/Digest',
            },
          },
          extensions: {
            $ref: 'common.schema.json#/$defs/Extensions',
          },
        },
        additionalProperties: false,
      },
    },
  },
  'https://openpacker.dev/spec/prex/v1/schemas/events.schema.json': {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://openpacker.dev/spec/prex/v1/schemas/events.schema.json',
    title: 'PREX lifecycle and OpenPacker CloudEvents data contracts',
    $defs: {
      LifecycleEvent: {
        type: 'object',
        required: [
          'eventVersion',
          'eventId',
          'subject',
          'action',
          'effectiveAt',
          'issuedAt',
          'actor',
          'authority',
          'reasonCode',
          'replacementRefs',
          'sourceSnapshot',
          'evidenceRefs',
          'externalRefs',
        ],
        properties: {
          eventVersion: {
            const: '1',
          },
          eventId: {
            type: 'string',
            maxLength: 255,
          },
          subject: {
            oneOf: [
              {
                $ref: 'model.schema.json#/$defs/PackageIdentity',
              },
              {
                $ref: 'common.schema.json#/$defs/Digest',
              },
            ],
          },
          action: {
            enum: [
              'published',
              'yanked',
              'deprecated',
              'quarantined',
              'revoked',
              'delisted',
              'restored',
              'promoted',
              'removed-from-channel',
              'ownership-transferred',
            ],
          },
          effectiveAt: {
            type: 'string',
            format: 'date-time',
          },
          issuedAt: {
            type: 'string',
            format: 'date-time',
          },
          actor: {
            $ref: 'common.schema.json#/$defs/IdentityRef',
          },
          authority: {
            enum: [
              'publisher',
              'registry',
              'organization',
              'user',
              'test-fixture',
            ],
          },
          reasonCode: {
            type: 'string',
            pattern: '^[A-Z][A-Z0-9_]{2,127}$',
          },
          reason: {
            type: 'string',
            maxLength: 8192,
          },
          replacementRefs: {
            type: 'array',
            maxItems: 128,
            items: {
              $ref: 'common.schema.json#/$defs/ExternalRef',
            },
          },
          expiresAt: {
            type: 'string',
            format: 'date-time',
          },
          sourceSnapshot: {
            $ref: 'common.schema.json#/$defs/Digest',
          },
          evidenceRefs: {
            type: 'array',
            maxItems: 128,
            items: {
              $ref: 'common.schema.json#/$defs/ExternalRef',
            },
          },
          externalRefs: {
            type: 'array',
            maxItems: 128,
            items: {
              $ref: 'common.schema.json#/$defs/ExternalRef',
            },
          },
          extensions: {
            $ref: 'common.schema.json#/$defs/Extensions',
          },
        },
        additionalProperties: false,
      },
      CloudEventCommon: {
        type: 'object',
        required: [
          'specversion',
          'id',
          'source',
          'subject',
          'time',
          'datacontenttype',
          'datadigest',
          'correlationid',
          'externalrefs',
        ],
        properties: {
          specversion: {
            const: '1.0',
          },
          id: {
            type: 'string',
            minLength: 1,
            maxLength: 255,
          },
          source: {
            type: 'string',
            format: 'uri-reference',
            maxLength: 8192,
          },
          subject: {
            type: 'string',
            minLength: 1,
            maxLength: 8192,
          },
          time: {
            type: 'string',
            format: 'date-time',
          },
          datacontenttype: {
            const: 'application/json',
          },
          datadigest: {
            $ref: 'common.schema.json#/$defs/DigestString',
          },
          correlationid: {
            type: 'string',
            maxLength: 255,
          },
          causationid: {
            type: 'string',
            maxLength: 255,
          },
          externalrefs: {
            type: 'array',
            maxItems: 128,
            items: {
              $ref: 'common.schema.json#/$defs/ExternalRef',
            },
          },
          extensions: {
            $ref: 'common.schema.json#/$defs/Extensions',
          },
        },
      },
      CatalogSnapshotCreatedData: {
        type: 'object',
        required: ['schemaVersion', 'snapshot'],
        properties: {
          schemaVersion: {
            const: '1',
          },
          snapshot: {
            $ref: 'model.schema.json#/$defs/SourceSnapshot',
          },
        },
        additionalProperties: false,
      },
      CatalogPackageObservedData: {
        type: 'object',
        required: ['schemaVersion', 'package'],
        properties: {
          schemaVersion: {
            const: '1',
          },
          package: {
            $ref: 'model.schema.json#/$defs/PackageInstance',
          },
        },
        additionalProperties: false,
      },
      LifecycleChangedData: {
        type: 'object',
        required: ['schemaVersion', 'lifecycleEvent'],
        properties: {
          schemaVersion: {
            const: '1',
          },
          lifecycleEvent: {
            $ref: '#/$defs/LifecycleEvent',
          },
        },
        additionalProperties: false,
      },
      ResolutionCompletedData: {
        type: 'object',
        required: [
          'schemaVersion',
          'solutionDigest',
          'requestDigest',
          'universeDigest',
        ],
        properties: {
          schemaVersion: {
            const: '1',
          },
          solutionDigest: {
            $ref: 'common.schema.json#/$defs/Digest',
          },
          requestDigest: {
            $ref: 'common.schema.json#/$defs/Digest',
          },
          universeDigest: {
            $ref: 'common.schema.json#/$defs/Digest',
          },
        },
        additionalProperties: false,
      },
      ResolutionUnsatisfiableData: {
        type: 'object',
        required: [
          'schemaVersion',
          'requestDigest',
          'universeDigest',
          'explanationDigest',
        ],
        properties: {
          schemaVersion: {
            const: '1',
          },
          requestDigest: {
            $ref: 'common.schema.json#/$defs/Digest',
          },
          universeDigest: {
            $ref: 'common.schema.json#/$defs/Digest',
          },
          explanationDigest: {
            $ref: 'common.schema.json#/$defs/Digest',
          },
        },
        additionalProperties: false,
      },
      ReceiptCreatedData: {
        type: 'object',
        required: ['schemaVersion', 'receiptDigest'],
        properties: {
          schemaVersion: {
            const: '1',
          },
          receiptDigest: {
            $ref: 'common.schema.json#/$defs/Digest',
          },
        },
        additionalProperties: false,
      },
      ArtifactPackedData: {
        type: 'object',
        required: ['schemaVersion', 'descriptor'],
        properties: {
          schemaVersion: {
            const: '1',
          },
          descriptor: {
            $ref: 'model.schema.json#/$defs/ArtifactDescriptor',
          },
        },
        additionalProperties: false,
      },
      ArtifactVerifiedData: {
        type: 'object',
        required: ['schemaVersion', 'descriptor'],
        properties: {
          schemaVersion: {
            const: '1',
          },
          descriptor: {
            $ref: 'model.schema.json#/$defs/ArtifactDescriptor',
          },
        },
        additionalProperties: false,
      },
      PolicyEvaluatedData: {
        type: 'object',
        required: ['schemaVersion', 'subjectDigest', 'decision'],
        properties: {
          schemaVersion: {
            const: '1',
          },
          subjectDigest: {
            $ref: 'common.schema.json#/$defs/Digest',
          },
          decision: {
            enum: ['allow', 'deny', 'indeterminate'],
          },
          policyDigest: {
            $ref: 'common.schema.json#/$defs/Digest',
          },
        },
        additionalProperties: false,
      },
      CatalogSnapshotCreatedEvent: {
        type: 'object',
        allOf: [
          {
            $ref: '#/$defs/CloudEventCommon',
          },
          {
            type: 'object',
            required: ['type', 'dataschema', 'data'],
            properties: {
              type: {
                const: 'org.openpacker.catalog.snapshot.created',
              },
              dataschema: {
                const:
                  'https://openpacker.dev/spec/prex/v1/events/data.schema.json#/$defs/org.openpacker.catalog.snapshot.created',
              },
              data: {
                $ref: '#/$defs/CatalogSnapshotCreatedData',
              },
            },
          },
        ],
        unevaluatedProperties: false,
      },
      CatalogPackageObservedEvent: {
        type: 'object',
        allOf: [
          {
            $ref: '#/$defs/CloudEventCommon',
          },
          {
            type: 'object',
            required: ['type', 'dataschema', 'data'],
            properties: {
              type: {
                const: 'org.openpacker.catalog.package.observed',
              },
              dataschema: {
                const:
                  'https://openpacker.dev/spec/prex/v1/events/data.schema.json#/$defs/org.openpacker.catalog.package.observed',
              },
              data: {
                $ref: '#/$defs/CatalogPackageObservedData',
              },
            },
          },
        ],
        unevaluatedProperties: false,
      },
      LifecycleChangedEvent: {
        type: 'object',
        allOf: [
          {
            $ref: '#/$defs/CloudEventCommon',
          },
          {
            type: 'object',
            required: ['type', 'dataschema', 'data'],
            properties: {
              type: {
                const: 'org.openpacker.lifecycle.changed',
              },
              dataschema: {
                const:
                  'https://openpacker.dev/spec/prex/v1/events/data.schema.json#/$defs/org.openpacker.lifecycle.changed',
              },
              data: {
                $ref: '#/$defs/LifecycleChangedData',
              },
            },
          },
        ],
        unevaluatedProperties: false,
      },
      ResolutionCompletedEvent: {
        type: 'object',
        allOf: [
          {
            $ref: '#/$defs/CloudEventCommon',
          },
          {
            type: 'object',
            required: ['type', 'dataschema', 'data'],
            properties: {
              type: {
                const: 'org.openpacker.resolution.completed',
              },
              dataschema: {
                const:
                  'https://openpacker.dev/spec/prex/v1/events/data.schema.json#/$defs/org.openpacker.resolution.completed',
              },
              data: {
                $ref: '#/$defs/ResolutionCompletedData',
              },
            },
          },
        ],
        unevaluatedProperties: false,
      },
      ResolutionUnsatisfiableEvent: {
        type: 'object',
        allOf: [
          {
            $ref: '#/$defs/CloudEventCommon',
          },
          {
            type: 'object',
            required: ['type', 'dataschema', 'data'],
            properties: {
              type: {
                const: 'org.openpacker.resolution.unsatisfiable',
              },
              dataschema: {
                const:
                  'https://openpacker.dev/spec/prex/v1/events/data.schema.json#/$defs/org.openpacker.resolution.unsatisfiable',
              },
              data: {
                $ref: '#/$defs/ResolutionUnsatisfiableData',
              },
            },
          },
        ],
        unevaluatedProperties: false,
      },
      ReceiptCreatedEvent: {
        type: 'object',
        allOf: [
          {
            $ref: '#/$defs/CloudEventCommon',
          },
          {
            type: 'object',
            required: ['type', 'dataschema', 'data'],
            properties: {
              type: {
                const: 'org.openpacker.receipt.created',
              },
              dataschema: {
                const:
                  'https://openpacker.dev/spec/prex/v1/events/data.schema.json#/$defs/org.openpacker.receipt.created',
              },
              data: {
                $ref: '#/$defs/ReceiptCreatedData',
              },
            },
          },
        ],
        unevaluatedProperties: false,
      },
      ArtifactPackedEvent: {
        type: 'object',
        allOf: [
          {
            $ref: '#/$defs/CloudEventCommon',
          },
          {
            type: 'object',
            required: ['type', 'dataschema', 'data'],
            properties: {
              type: {
                const: 'org.openpacker.artifact.packed',
              },
              dataschema: {
                const:
                  'https://openpacker.dev/spec/prex/v1/events/data.schema.json#/$defs/org.openpacker.artifact.packed',
              },
              data: {
                $ref: '#/$defs/ArtifactPackedData',
              },
            },
          },
        ],
        unevaluatedProperties: false,
      },
      ArtifactVerifiedEvent: {
        type: 'object',
        allOf: [
          {
            $ref: '#/$defs/CloudEventCommon',
          },
          {
            type: 'object',
            required: ['type', 'dataschema', 'data'],
            properties: {
              type: {
                const: 'org.openpacker.artifact.verified',
              },
              dataschema: {
                const:
                  'https://openpacker.dev/spec/prex/v1/events/data.schema.json#/$defs/org.openpacker.artifact.verified',
              },
              data: {
                $ref: '#/$defs/ArtifactVerifiedData',
              },
            },
          },
        ],
        unevaluatedProperties: false,
      },
      PolicyEvaluatedEvent: {
        type: 'object',
        allOf: [
          {
            $ref: '#/$defs/CloudEventCommon',
          },
          {
            type: 'object',
            required: ['type', 'dataschema', 'data'],
            properties: {
              type: {
                const: 'org.openpacker.policy.evaluated',
              },
              dataschema: {
                const:
                  'https://openpacker.dev/spec/prex/v1/events/data.schema.json#/$defs/org.openpacker.policy.evaluated',
              },
              data: {
                $ref: '#/$defs/PolicyEvaluatedData',
              },
            },
          },
        ],
        unevaluatedProperties: false,
      },
      EventType: {
        enum: [
          'org.openpacker.catalog.snapshot.created',
          'org.openpacker.catalog.package.observed',
          'org.openpacker.lifecycle.changed',
          'org.openpacker.resolution.completed',
          'org.openpacker.resolution.unsatisfiable',
          'org.openpacker.receipt.created',
          'org.openpacker.artifact.packed',
          'org.openpacker.artifact.verified',
          'org.openpacker.policy.evaluated',
        ],
      },
      EventData: {
        oneOf: [
          {
            $ref: '#/$defs/CatalogSnapshotCreatedData',
          },
          {
            $ref: '#/$defs/CatalogPackageObservedData',
          },
          {
            $ref: '#/$defs/LifecycleChangedData',
          },
          {
            $ref: '#/$defs/ResolutionCompletedData',
          },
          {
            $ref: '#/$defs/ResolutionUnsatisfiableData',
          },
          {
            $ref: '#/$defs/ReceiptCreatedData',
          },
          {
            $ref: '#/$defs/ArtifactPackedData',
          },
          {
            $ref: '#/$defs/ArtifactVerifiedData',
          },
          {
            $ref: '#/$defs/PolicyEvaluatedData',
          },
        ],
      },
      OpenPackerCloudEvent: {
        oneOf: [
          {
            $ref: '#/$defs/CatalogSnapshotCreatedEvent',
          },
          {
            $ref: '#/$defs/CatalogPackageObservedEvent',
          },
          {
            $ref: '#/$defs/LifecycleChangedEvent',
          },
          {
            $ref: '#/$defs/ResolutionCompletedEvent',
          },
          {
            $ref: '#/$defs/ResolutionUnsatisfiableEvent',
          },
          {
            $ref: '#/$defs/ReceiptCreatedEvent',
          },
          {
            $ref: '#/$defs/ArtifactPackedEvent',
          },
          {
            $ref: '#/$defs/ArtifactVerifiedEvent',
          },
          {
            $ref: '#/$defs/PolicyEvaluatedEvent',
          },
        ],
      },
    },
  },
  'https://openpacker.dev/spec/prex/v1/schemas/extensions.schema.json': {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://openpacker.dev/spec/prex/v1/schemas/extensions.schema.json',
    title: 'OpenPacker extension operation contracts',
    $defs: {
      CatalogImportRequest: {
        $ref: 'model.schema.json#/$defs/SourceSnapshot',
      },
      CatalogImportResponse: {
        type: 'object',
        required: ['snapshot', 'digest'],
        properties: {
          snapshot: {
            $ref: 'model.schema.json#/$defs/SourceSnapshot',
          },
          digest: {
            type: 'string',
            pattern: '^sha256:[0-9a-f]{64}$',
          },
        },
        additionalProperties: false,
      },
      CatalogSnapshotRequest: {
        type: 'object',
        properties: {
          providerId: {
            type: 'string',
            minLength: 1,
            maxLength: 255,
          },
        },
        additionalProperties: false,
      },
      CatalogSnapshotResponse: {
        type: 'object',
        required: ['snapshots'],
        properties: {
          snapshots: {
            type: 'array',
            maxItems: 10000,
            items: {
              $ref: 'model.schema.json#/$defs/SourceSnapshot',
            },
          },
        },
        additionalProperties: false,
      },
      LifecycleApplyRequest: {
        $ref: 'events.schema.json#/$defs/LifecycleEvent',
      },
      LifecycleApplyResponse: {
        type: 'object',
        required: ['applied'],
        properties: {
          applied: {
            $ref: 'events.schema.json#/$defs/LifecycleEvent',
          },
        },
        additionalProperties: false,
      },
      PackRequest: {
        type: 'object',
        required: ['exactPurl', 'artifact'],
        properties: {
          exactPurl: {
            type: 'string',
            pattern: '^pkg:.*@',
            maxLength: 8192,
          },
          artifact: {
            $ref: 'model.schema.json#/$defs/ArtifactDescriptor',
          },
          reference: {
            type: 'string',
            minLength: 1,
            maxLength: 8192,
          },
        },
        additionalProperties: false,
      },
      PackResponse: {
        type: 'object',
        required: ['manifest', 'nativeBlob', 'artifact'],
        properties: {
          manifest: {
            $ref: '#/$defs/OciDescriptor',
          },
          nativeBlob: {
            $ref: '#/$defs/OciDescriptor',
          },
          artifact: {
            $ref: 'model.schema.json#/$defs/ArtifactDescriptor',
          },
        },
        additionalProperties: false,
      },
      OciDescriptor: {
        type: 'object',
        required: ['mediaType', 'digest', 'size'],
        properties: {
          mediaType: {
            type: 'string',
            minLength: 1,
            maxLength: 255,
          },
          digest: {
            type: 'string',
            pattern: '^sha256:[0-9a-f]{64}$',
          },
          size: {
            type: 'integer',
            minimum: 0,
            maximum: 9007199254740991,
          },
          artifactType: {
            type: 'string',
            minLength: 1,
            maxLength: 255,
          },
          annotations: {
            type: 'object',
            maxProperties: 128,
            propertyNames: {
              maxLength: 4096,
            },
            additionalProperties: {
              type: 'string',
              maxLength: 8192,
            },
          },
        },
        additionalProperties: false,
      },
      PublishRequest: {
        type: 'object',
        required: ['descriptor', 'location'],
        properties: {
          descriptor: {
            $ref: 'model.schema.json#/$defs/ArtifactDescriptor',
          },
          location: {
            $ref: 'model.schema.json#/$defs/ArtifactLocation',
          },
        },
        additionalProperties: false,
      },
      PublishResponse: {
        $ref: '#/$defs/PublishRequest',
      },
      LockImportRequest: {
        type: 'object',
        required: ['lockfile'],
        properties: {
          lockfile: {
            type: 'string',
            minLength: 1,
            maxLength: 16777216,
          },
          format: {
            type: 'string',
            enum: [
              'auto',
              'package-lock',
              'cargo-lock',
              'nuget-assets',
              'nuget-packages-lock',
              'uv-lock',
              'go-sum',
              'gradle-lockfile',
            ],
          },
          ecosystem: {
            type: 'string',
            enum: ['npm', 'cargo', 'nuget', 'pypi', 'golang', 'maven'],
          },
          evaluationTime: {
            type: 'string',
            format: 'date-time',
          },
          target: {
            $ref: 'model.schema.json#/$defs/TargetContext',
          },
          policy: {
            $ref: 'resolution.schema.json#/$defs/PolicyInput',
          },
          objectives: {
            type: 'array',
            maxItems: 32,
            items: {
              type: 'string',
              minLength: 1,
              maxLength: 128,
            },
          },
        },
        additionalProperties: false,
      },
      LockImportResponse: {
        type: 'object',
        required: ['lockCapture', 'solveResponse', 'lockfile', 'semanticLoss'],
        properties: {
          lockCapture: {
            type: 'object',
            required: ['format', 'formatVersion', 'packages', 'semanticLoss'],
            properties: {
              format: {
                type: 'string',
                minLength: 1,
                maxLength: 128,
              },
              formatVersion: {
                type: 'string',
                minLength: 1,
                maxLength: 64,
              },
              sourceDigest: {
                type: 'string',
                minLength: 1,
                maxLength: 256,
              },
              packages: {
                type: 'array',
                maxItems: 100000,
                items: {
                  type: 'object',
                  required: [
                    'exactPurl',
                    'nativeCoordinate',
                    'dependencies',
                    'native',
                  ],
                  properties: {
                    exactPurl: {
                      type: 'string',
                      pattern: '^pkg:.*@',
                      maxLength: 8192,
                    },
                    nativeCoordinate: {
                      type: 'string',
                      minLength: 1,
                      maxLength: 8192,
                    },
                    resolved: {
                      type: 'string',
                      minLength: 1,
                      maxLength: 8192,
                    },
                    artifactDigest: {
                      type: 'string',
                      minLength: 1,
                      maxLength: 512,
                    },
                    dependencies: {
                      type: 'object',
                      maxProperties: 10000,
                      additionalProperties: {
                        type: 'string',
                        maxLength: 4096,
                      },
                    },
                    native: true,
                  },
                  additionalProperties: false,
                },
              },
              semanticLoss: {
                type: 'array',
                maxItems: 10000,
                items: {
                  $ref: 'common.schema.json#/$defs/SemanticLoss',
                },
              },
            },
            additionalProperties: false,
          },
          solveResponse: {
            $ref: 'resolution.schema.json#/$defs/SolveResponse',
          },
          lockfile: {
            $ref: 'lockfile.schema.json',
          },
          semanticLoss: {
            type: 'array',
            maxItems: 10000,
            items: {
              $ref: 'common.schema.json#/$defs/SemanticLoss',
            },
          },
        },
        additionalProperties: false,
      },
    },
  },
  'https://openpacker.dev/spec/prex/v1/schemas/lockfile.schema.json': {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://openpacker.dev/spec/prex/v1/schemas/lockfile.schema.json',
    title: 'openpacker.lock.json',
    type: 'object',
    required: [
      'schemaVersion',
      'protocolVersion',
      'rootRequirements',
      'target',
      'semanticsProfile',
      'objectiveOrdering',
      'selectedExactPurls',
      'dependencyEdges',
      'artifactDescriptors',
      'ocmReferences',
      'sourceSnapshotDigests',
      'lifecycleRoot',
      'policyDigest',
      'solutionDigest',
      'receiptDigest',
      'externalRefs',
    ],
    properties: {
      schemaVersion: {
        const: '1',
      },
      protocolVersion: {
        const: '1.0-draft',
      },
      rootRequirements: {
        type: 'array',
        minItems: 0,
        maxItems: 10000,
        items: {
          $ref: 'model.schema.json#/$defs/Requirement',
        },
      },
      target: {
        $ref: 'model.schema.json#/$defs/TargetContext',
      },
      semanticsProfile: {
        enum: [
          'native-capture-v1',
          'native-validated-v1',
          'prex-calculus-subset-v1',
        ],
      },
      objectiveOrdering: {
        $ref: 'resolution.schema.json#/$defs/SolveRequest/properties/objectives',
      },
      selectedExactPurls: {
        type: 'array',
        maxItems: 100000,
        uniqueItems: true,
        items: {
          type: 'string',
          pattern: '^pkg:.*@',
          maxLength: 8192,
        },
      },
      dependencyEdges: {
        type: 'array',
        maxItems: 1000000,
        items: {
          $ref: 'resolution.schema.json#/$defs/DependencyEdge',
        },
      },
      artifactDescriptors: {
        type: 'array',
        maxItems: 100000,
        items: {
          $ref: 'model.schema.json#/$defs/ArtifactDescriptor',
        },
      },
      ocmReferences: {
        type: 'array',
        maxItems: 100000,
        items: {
          $ref: 'common.schema.json#/$defs/ExternalRef',
        },
      },
      sourceSnapshotDigests: {
        type: 'array',
        maxItems: 10000,
        items: {
          $ref: 'common.schema.json#/$defs/Digest',
        },
      },
      lifecycleRoot: {
        $ref: 'common.schema.json#/$defs/Digest',
      },
      policyDigest: {
        $ref: 'common.schema.json#/$defs/Digest',
      },
      solutionDigest: {
        $ref: 'common.schema.json#/$defs/Digest',
      },
      receiptDigest: {
        $ref: 'common.schema.json#/$defs/Digest',
      },
      externalRefs: {
        type: 'array',
        maxItems: 128,
        items: {
          $ref: 'common.schema.json#/$defs/ExternalRef',
        },
      },
      platforms: {
        $ref: 'model.schema.json#/$defs/PlatformContexts',
      },
      selectedOutputs: {
        $comment:
          'Outputs pinned per selected package. Absent entries mean the default output.',
        type: 'array',
        maxItems: 100000,
        items: {
          type: 'object',
          required: ['exactPurl', 'outputs'],
          properties: {
            exactPurl: {
              type: 'string',
              pattern: '^pkg:.*@',
            },
            outputs: {
              type: 'array',
              minItems: 1,
              maxItems: 64,
              uniqueItems: true,
              items: {
                $ref: 'model.schema.json#/$defs/OutputName',
              },
            },
          },
          additionalProperties: false,
        },
      },
      recipeDigests: {
        $comment:
          'build-recipe-v1 digests of the captured plans behind this lock.',
        type: 'array',
        maxItems: 100000,
        uniqueItems: true,
        items: {
          $ref: 'common.schema.json#/$defs/Digest',
        },
      },
      substitutes: {
        type: 'array',
        maxItems: 100000,
        items: {
          $ref: 'model.schema.json#/$defs/SubstituteDescriptor',
        },
      },
      environment: {
        $comment:
          'The environment generation this lock was produced for, when it belongs to one.',
        type: 'object',
        required: ['name'],
        properties: {
          name: {
            $ref: 'environment.schema.json#/$defs/EnvironmentName',
          },
          baseGenerationDigest: {
            $ref: 'common.schema.json#/$defs/Digest',
          },
        },
        additionalProperties: false,
      },
      extensions: {
        $ref: 'common.schema.json#/$defs/Extensions',
      },
    },
    additionalProperties: false,
  },
  'https://openpacker.dev/spec/prex/v1/schemas/model.schema.json': {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://openpacker.dev/spec/prex/v1/schemas/model.schema.json',
    title: 'PREX package, requirement, target, artifact, and lifecycle model',
    $defs: {
      PackageIdentity: {
        type: 'object',
        required: [
          'canonicalPurl',
          'purlType',
          'name',
          'qualifiers',
          'nativeCoordinates',
          'aliases',
          'sourceRefs',
          'publisherRefs',
          'externalRefs',
        ],
        properties: {
          canonicalPurl: {
            type: 'string',
            pattern: '^pkg:[a-z0-9.+-]+/',
            maxLength: 8192,
          },
          exactPurl: {
            type: 'string',
            pattern: '^pkg:[a-z0-9.+-]+/.*@',
            maxLength: 8192,
          },
          purlType: {
            type: 'string',
            pattern: '^[a-z0-9.+-]+$',
            maxLength: 64,
          },
          namespace: {
            type: 'string',
            maxLength: 1024,
          },
          name: {
            type: 'string',
            minLength: 1,
            maxLength: 1024,
          },
          version: {
            type: 'string',
            maxLength: 1024,
          },
          qualifiers: {
            type: 'object',
            maxProperties: 64,
            additionalProperties: {
              type: 'string',
              maxLength: 4096,
            },
          },
          subpath: {
            type: 'string',
            maxLength: 4096,
          },
          nativeCoordinates: {
            type: 'array',
            maxItems: 64,
            items: {
              type: 'object',
              required: ['ecosystem', 'coordinate'],
              properties: {
                ecosystem: {
                  type: 'string',
                  maxLength: 64,
                },
                coordinate: {
                  type: 'string',
                  maxLength: 4096,
                },
                version: {
                  type: 'string',
                  maxLength: 1024,
                },
              },
              additionalProperties: false,
            },
          },
          aliases: {
            type: 'array',
            maxItems: 128,
            items: {
              type: 'string',
              maxLength: 4096,
            },
          },
          sourceRefs: {
            type: 'array',
            maxItems: 128,
            items: {
              $ref: 'common.schema.json#/$defs/SourceRef',
            },
          },
          publisherRefs: {
            type: 'array',
            maxItems: 64,
            items: {
              $ref: 'common.schema.json#/$defs/IdentityRef',
            },
          },
          externalRefs: {
            type: 'array',
            maxItems: 128,
            items: {
              $ref: 'common.schema.json#/$defs/ExternalRef',
            },
          },
          extensions: {
            $ref: 'common.schema.json#/$defs/Extensions',
          },
        },
        additionalProperties: false,
      },
      VersionConstraint: {
        type: 'object',
        required: [
          'scheme',
          'original',
          'normalized',
          'ast',
          'reversible',
          'semanticLoss',
        ],
        properties: {
          vers: {
            type: 'string',
            pattern: '^vers:[a-z0-9.+-]+/',
            maxLength: 8192,
          },
          scheme: {
            type: 'string',
            pattern: '^[a-z0-9.+-]+$',
            maxLength: 64,
          },
          original: {
            type: 'string',
            maxLength: 8192,
          },
          normalized: {
            type: 'string',
            maxLength: 8192,
          },
          ast: {
            $ref: '#/$defs/VersionConstraintAst',
          },
          reversible: {
            type: 'boolean',
          },
          semanticLoss: {
            type: 'array',
            maxItems: 128,
            items: {
              $ref: 'common.schema.json#/$defs/SemanticLoss',
            },
          },
        },
        additionalProperties: false,
      },
      VersionConstraintAst: {
        oneOf: [
          {
            type: 'object',
            required: ['type', 'operator', 'version'],
            properties: {
              type: {
                const: 'comparison',
              },
              operator: {
                enum: ['=', '!=', '>', '>=', '<', '<='],
              },
              version: {
                type: 'string',
                minLength: 1,
                maxLength: 1024,
              },
            },
            additionalProperties: false,
          },
          {
            type: 'object',
            required: ['type', 'items'],
            properties: {
              type: {
                enum: ['and', 'or'],
              },
              items: {
                type: 'array',
                minItems: 1,
                maxItems: 256,
                items: {
                  $ref: '#/$defs/VersionConstraintAst',
                },
              },
            },
            additionalProperties: false,
          },
          {
            type: 'object',
            required: ['type', 'item'],
            properties: {
              type: {
                const: 'not',
              },
              item: {
                $ref: '#/$defs/VersionConstraintAst',
              },
            },
            additionalProperties: false,
          },
          {
            type: 'object',
            required: ['type'],
            properties: {
              type: {
                const: 'any',
              },
            },
            additionalProperties: false,
          },
        ],
      },
      TargetContext: {
        type: 'object',
        properties: {
          os: {
            type: 'string',
            maxLength: 128,
          },
          architecture: {
            type: 'string',
            maxLength: 128,
          },
          libc: {
            type: 'string',
            maxLength: 128,
          },
          kernel: {
            type: 'string',
            maxLength: 128,
          },
          runtimes: {
            type: 'object',
            maxProperties: 64,
            additionalProperties: {
              type: 'string',
              maxLength: 128,
            },
          },
          abi: {
            type: 'object',
            maxProperties: 64,
            additionalProperties: {
              type: 'string',
              maxLength: 128,
            },
          },
          capabilities: {
            type: 'array',
            maxItems: 256,
            items: {
              type: 'object',
              required: ['name'],
              properties: {
                name: {
                  type: 'string',
                  maxLength: 255,
                },
                version: {
                  type: 'string',
                  maxLength: 128,
                },
                attributes: {
                  type: 'object',
                  maxProperties: 64,
                  additionalProperties: {
                    type: ['string', 'boolean', 'integer'],
                  },
                },
              },
              additionalProperties: false,
            },
          },
          variables: {
            type: 'object',
            maxProperties: 128,
            additionalProperties: {
              type: ['string', 'boolean', 'integer'],
            },
          },
          extensions: {
            $ref: 'common.schema.json#/$defs/Extensions',
          },
        },
        additionalProperties: false,
      },
      TargetPredicate: {
        oneOf: [
          {
            type: 'object',
            required: ['type'],
            properties: {
              type: {
                enum: ['true', 'false'],
              },
            },
            additionalProperties: false,
          },
          {
            type: 'object',
            required: ['type', 'path', 'value'],
            properties: {
              type: {
                enum: ['equals', 'notEquals'],
              },
              path: {
                type: 'string',
                pattern:
                  '^(?:build\\.|host\\.|target\\.)?(os|architecture|libc|kernel|runtimes\\.[A-Za-z0-9_.-]+|abi\\.[A-Za-z0-9_.-]+|variables\\.[A-Za-z0-9_.-]+)$',
              },
              value: {
                type: ['string', 'boolean', 'integer'],
              },
            },
            additionalProperties: false,
          },
          {
            type: 'object',
            required: ['type', 'path', 'values'],
            properties: {
              type: {
                enum: ['in', 'notIn'],
              },
              path: {
                type: 'string',
                maxLength: 255,
              },
              values: {
                type: 'array',
                minItems: 1,
                maxItems: 128,
                items: {
                  type: ['string', 'boolean', 'integer'],
                },
              },
            },
            additionalProperties: false,
          },
          {
            type: 'object',
            required: ['type', 'path', 'constraint'],
            properties: {
              type: {
                const: 'versionSatisfies',
              },
              path: {
                type: 'string',
                maxLength: 255,
              },
              constraint: {
                $ref: '#/$defs/VersionConstraint',
              },
            },
            additionalProperties: false,
          },
          {
            type: 'object',
            required: ['type', 'name'],
            properties: {
              type: {
                const: 'capabilityPresent',
              },
              name: {
                type: 'string',
                maxLength: 255,
              },
              constraint: {
                $ref: '#/$defs/VersionConstraint',
              },
            },
            additionalProperties: false,
          },
          {
            type: 'object',
            required: ['type', 'predicates'],
            properties: {
              type: {
                enum: ['allOf', 'anyOf'],
              },
              predicates: {
                type: 'array',
                minItems: 1,
                maxItems: 64,
                items: {
                  $ref: '#/$defs/TargetPredicate',
                },
              },
            },
            additionalProperties: false,
          },
          {
            type: 'object',
            required: ['type', 'predicate'],
            properties: {
              type: {
                const: 'not',
              },
              predicate: {
                $ref: '#/$defs/TargetPredicate',
              },
            },
            additionalProperties: false,
          },
        ],
      },
      RequirementExpression: {
        oneOf: [
          {
            type: 'object',
            required: ['type', 'purl'],
            properties: {
              type: {
                const: 'package',
              },
              purl: {
                type: 'string',
                pattern: '^pkg:',
              },
              vers: {
                type: 'string',
                pattern: '^vers:',
              },
              qualifiers: {
                type: 'object',
                maxProperties: 64,
                additionalProperties: {
                  type: 'string',
                },
              },
              outputs: {
                $comment:
                  'Outputs required from the matched package. Absent means the default output.',
                type: 'array',
                minItems: 1,
                maxItems: 64,
                uniqueItems: true,
                items: {
                  $ref: '#/$defs/OutputName',
                },
              },
            },
            additionalProperties: false,
          },
          {
            type: 'object',
            required: ['type', 'name'],
            properties: {
              type: {
                const: 'capability',
              },
              name: {
                type: 'string',
                maxLength: 255,
              },
              vers: {
                type: 'string',
                pattern: '^vers:',
              },
              attributes: {
                type: 'object',
                maxProperties: 64,
                additionalProperties: {
                  type: ['string', 'boolean', 'integer'],
                },
              },
            },
            additionalProperties: false,
          },
          {
            type: 'object',
            required: ['type', 'expressions'],
            properties: {
              type: {
                enum: ['allOf', 'anyOf'],
              },
              expressions: {
                type: 'array',
                minItems: 1,
                maxItems: 64,
                items: {
                  $ref: '#/$defs/RequirementExpression',
                },
              },
            },
            additionalProperties: false,
          },
          {
            type: 'object',
            required: ['type', 'expression'],
            properties: {
              type: {
                const: 'not',
              },
              expression: {
                $ref: '#/$defs/RequirementExpression',
              },
            },
            additionalProperties: false,
          },
          {
            type: 'object',
            required: ['type', 'when', 'then'],
            properties: {
              type: {
                const: 'conditional',
              },
              when: {
                $ref: '#/$defs/TargetPredicate',
              },
              then: {
                $ref: '#/$defs/RequirementExpression',
              },
              else: {
                $ref: '#/$defs/RequirementExpression',
              },
            },
            additionalProperties: false,
          },
        ],
      },
      Requirement: {
        type: 'object',
        required: [
          'id',
          'expression',
          'kind',
          'optional',
          'source',
          'authority',
          'semanticLoss',
        ],
        properties: {
          id: {
            type: 'string',
            pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$',
          },
          dependerNodeId: {
            type: 'string',
            maxLength: 255,
          },
          expression: {
            $ref: '#/$defs/RequirementExpression',
          },
          kind: {
            $ref: '#/$defs/RequirementKind',
          },
          optional: {
            type: 'boolean',
          },
          source: {
            $ref: 'common.schema.json#/$defs/SourceRef',
          },
          authority: {
            type: 'string',
            maxLength: 128,
          },
          raw: {
            $ref: 'common.schema.json#/$defs/CanonicalJsonValue',
          },
          nativeSemantics: {
            type: 'object',
            required: ['version', 'data'],
            properties: {
              version: {
                type: 'string',
                maxLength: 64,
              },
              data: {
                $ref: 'common.schema.json#/$defs/CanonicalJsonValue',
              },
            },
            additionalProperties: false,
          },
          semanticLoss: {
            type: 'array',
            maxItems: 128,
            items: {
              $ref: 'common.schema.json#/$defs/SemanticLoss',
            },
          },
        },
        additionalProperties: false,
      },
      Capability: {
        type: 'object',
        required: ['name', 'providerNodeId', 'source'],
        properties: {
          name: {
            type: 'string',
            maxLength: 255,
          },
          version: {
            type: 'string',
            maxLength: 128,
          },
          attributes: {
            type: 'object',
            maxProperties: 64,
            additionalProperties: {
              type: ['string', 'boolean', 'integer'],
            },
          },
          providerNodeId: {
            type: 'string',
            maxLength: 255,
          },
          targetPredicate: {
            $ref: '#/$defs/TargetPredicate',
          },
          source: {
            $ref: 'common.schema.json#/$defs/SourceRef',
          },
        },
        additionalProperties: false,
      },
      Conflict: {
        type: 'object',
        required: ['id', 'expression', 'scope', 'source'],
        properties: {
          id: {
            type: 'string',
            maxLength: 255,
          },
          expression: {
            $ref: '#/$defs/RequirementExpression',
          },
          scope: {
            enum: ['solution', 'package', 'target'],
          },
          source: {
            $ref: 'common.schema.json#/$defs/SourceRef',
          },
        },
        additionalProperties: false,
      },
      CardinalityConstraint: {
        type: 'object',
        required: ['id', 'selector', 'minimum', 'maximum', 'scope', 'source'],
        properties: {
          id: {
            type: 'string',
            maxLength: 255,
          },
          selector: {
            $ref: '#/$defs/RequirementExpression',
          },
          minimum: {
            type: 'integer',
            minimum: 0,
            maximum: 100000,
          },
          maximum: {
            type: 'integer',
            minimum: 0,
            maximum: 100000,
          },
          scope: {
            enum: ['solution', 'package', 'target'],
          },
          source: {
            $ref: 'common.schema.json#/$defs/SourceRef',
          },
        },
        additionalProperties: false,
      },
      ArtifactLocation: {
        type: 'object',
        required: ['transport', 'uri', 'priority', 'rangeSupported'],
        properties: {
          transport: {
            enum: ['https', 'oci', 'file', 'cas', 'provider'],
          },
          uri: {
            type: 'string',
            format: 'uri',
            maxLength: 8192,
          },
          priority: {
            type: 'integer',
            minimum: 0,
            maximum: 1000,
          },
          rangeSupported: {
            type: 'boolean',
          },
          credentialRef: {
            type: 'string',
            maxLength: 1024,
          },
          expiresAt: {
            type: 'string',
            format: 'date-time',
          },
          annotations: {
            type: 'object',
            maxProperties: 64,
            additionalProperties: {
              type: 'string',
            },
          },
          extensions: {
            $ref: 'common.schema.json#/$defs/Extensions',
          },
        },
        additionalProperties: false,
      },
      ArtifactDescriptor: {
        type: 'object',
        required: [
          'descriptorId',
          'digest',
          'size',
          'mediaType',
          'artifactType',
          'nativeRole',
          'locations',
          'referrers',
          'externalRefs',
        ],
        properties: {
          descriptorId: {
            type: 'string',
            maxLength: 255,
          },
          digest: {
            $ref: 'common.schema.json#/$defs/Digest',
          },
          size: {
            type: 'integer',
            minimum: 0,
            maximum: 9007199254740991,
          },
          mediaType: {
            type: 'string',
            maxLength: 255,
          },
          artifactType: {
            type: 'string',
            maxLength: 255,
          },
          fileName: {
            type: 'string',
            maxLength: 1024,
          },
          targetPredicate: {
            $ref: '#/$defs/TargetPredicate',
          },
          nativeRole: {
            type: 'string',
            maxLength: 128,
          },
          locations: {
            type: 'array',
            maxItems: 64,
            items: {
              $ref: '#/$defs/ArtifactLocation',
            },
          },
          oci: {
            type: 'object',
            maxProperties: 64,
            additionalProperties: {
              $ref: 'common.schema.json#/$defs/CanonicalJsonValue',
            },
          },
          ocm: {
            type: 'object',
            maxProperties: 64,
            additionalProperties: {
              $ref: 'common.schema.json#/$defs/CanonicalJsonValue',
            },
          },
          chunkIndexRef: {
            $ref: 'common.schema.json#/$defs/ExternalRef',
          },
          treeDigest: {
            $comment:
              'tree-manifest-v1 projection digest of the extracted directory tree; identifies unpacked content, never transport bytes',
            $ref: 'common.schema.json#/$defs/Digest',
          },
          treeManifestRef: {
            $ref: 'common.schema.json#/$defs/ExternalRef',
          },
          producedBy: {
            $comment:
              'Captured claim that a build recipe produced these bytes. Verification is an evidence fact; it never establishes identity.',
            type: 'object',
            required: ['recipeDigest', 'outputName'],
            properties: {
              recipeDigest: {
                $ref: 'common.schema.json#/$defs/Digest',
              },
              outputName: {
                $ref: '#/$defs/OutputName',
              },
            },
            additionalProperties: false,
          },
          runtimeReferences: {
            type: 'array',
            maxItems: 4096,
            items: {
              $ref: '#/$defs/ArtifactReference',
            },
          },
          referrers: {
            type: 'array',
            maxItems: 128,
            items: {
              $ref: 'common.schema.json#/$defs/ExternalRef',
            },
          },
          externalRefs: {
            type: 'array',
            maxItems: 128,
            items: {
              $ref: 'common.schema.json#/$defs/ExternalRef',
            },
          },
          extensions: {
            $ref: 'common.schema.json#/$defs/Extensions',
          },
        },
        additionalProperties: false,
      },
      OutputName: {
        type: 'string',
        pattern: '^[a-z0-9][a-z0-9._-]{0,63}$',
      },
      RequirementKind: {
        enum: [
          'runtime',
          'build',
          'development',
          'peer',
          'optional',
          'feature',
          'tool',
          'platform',
          'replacement',
          'conflict',
          'unknown-native',
        ],
      },
      PackageOutput: {
        $comment:
          'A separately installable part of one package. Outputs refine materialization and closure membership; the node remains the atomic unit of selection.',
        type: 'object',
        required: ['name'],
        properties: {
          name: {
            $ref: '#/$defs/OutputName',
          },
          default: {
            type: 'boolean',
          },
          description: {
            type: 'string',
            maxLength: 1024,
          },
          artifactDescriptorIds: {
            type: 'array',
            maxItems: 1024,
            uniqueItems: true,
            items: {
              type: 'string',
              maxLength: 255,
            },
          },
          recipeOutputId: {
            $ref: 'common.schema.json#/$defs/Digest',
          },
        },
        additionalProperties: false,
      },
      ArtifactReference: {
        $comment:
          'A reference from one realised artifact to another. At least one selector is required; multiple selectors must agree.',
        type: 'object',
        anyOf: [
          {
            required: ['artifactDigest'],
          },
          {
            required: ['recipeOutputId'],
          },
          {
            required: ['nodeId'],
          },
        ],
        properties: {
          artifactDigest: {
            $ref: 'common.schema.json#/$defs/Digest',
          },
          recipeOutputId: {
            $ref: 'common.schema.json#/$defs/Digest',
          },
          nodeId: {
            type: 'string',
            pattern: '^sha256:[0-9a-f]{64}$',
          },
          outputName: {
            $ref: '#/$defs/OutputName',
          },
        },
        additionalProperties: false,
      },
      TreeManifestEntry: {
        type: 'object',
        required: ['path', 'kind'],
        properties: {
          path: {
            $comment:
              "Relative, forward-slash separated. No leading slash, no empty segment, no '.' or '..' segment, no backslash.",
            type: 'string',
            minLength: 1,
            maxLength: 4096,
            pattern:
              '^(?![\\s\\S]*(?:^/|//|/$|(?:^|/)\\.{1,2}(?:/|$)))[^\\\\\\u0000-\\u001f\\u007f]+$',
          },
          kind: {
            enum: ['file', 'executable', 'directory', 'symlink'],
          },
          digest: {
            $ref: 'common.schema.json#/$defs/Digest',
          },
          size: {
            type: 'integer',
            minimum: 0,
            maximum: 9007199254740991,
          },
          target: {
            type: 'string',
            minLength: 1,
            maxLength: 4096,
          },
        },
        allOf: [
          {
            if: {
              required: ['kind'],
              properties: {
                kind: {
                  enum: ['file', 'executable'],
                },
              },
            },
            then: {
              required: ['digest', 'size'],
            },
          },
          {
            if: {
              required: ['kind'],
              properties: {
                kind: {
                  const: 'symlink',
                },
              },
            },
            then: {
              required: ['target'],
            },
          },
          {
            if: {
              required: ['kind'],
              properties: {
                kind: {
                  const: 'directory',
                },
              },
            },
            then: {
              not: {
                anyOf: [
                  {
                    required: ['digest'],
                  },
                  {
                    required: ['target'],
                  },
                ],
              },
            },
          },
        ],
        additionalProperties: false,
      },
      TreeManifest: {
        $comment:
          'Canonical whole-tree identity. treeDigest = tree-manifest-v1 projection digest. Deliberately not byte-compatible with Nix NAR hashing; native serializations travel as ordinary artifacts.',
        type: 'object',
        required: ['manifestVersion', 'entries'],
        properties: {
          manifestVersion: {
            const: '1',
          },
          entries: {
            type: 'array',
            maxItems: 100000,
            items: {
              $ref: '#/$defs/TreeManifestEntry',
            },
          },
          semanticLoss: {
            type: 'array',
            maxItems: 128,
            items: {
              $ref: 'common.schema.json#/$defs/SemanticLoss',
            },
          },
          extensions: {
            $ref: 'common.schema.json#/$defs/Extensions',
          },
        },
        additionalProperties: false,
      },
      PlatformContexts: {
        $comment:
          'Build/host/target separation. Absent members default to the host context; host defaults to the enclosing request target.',
        type: 'object',
        minProperties: 1,
        properties: {
          build: {
            $ref: '#/$defs/TargetContext',
          },
          host: {
            $ref: '#/$defs/TargetContext',
          },
          target: {
            $ref: '#/$defs/TargetContext',
          },
        },
        additionalProperties: false,
      },
      BuildRecipeInput: {
        type: 'object',
        required: ['role'],
        anyOf: [
          {
            required: ['nodeId'],
          },
          {
            required: ['exactPurl'],
          },
          {
            required: ['recipeOutputId'],
          },
          {
            required: ['artifactDigest'],
          },
          {
            required: ['sourceRef'],
          },
        ],
        properties: {
          role: {
            enum: ['source', 'build', 'host', 'target', 'recipe'],
          },
          nodeId: {
            type: 'string',
            pattern: '^sha256:[0-9a-f]{64}$',
          },
          exactPurl: {
            type: 'string',
            pattern: '^pkg:[a-z0-9.+-]+/',
            maxLength: 4096,
          },
          recipeOutputId: {
            $ref: 'common.schema.json#/$defs/Digest',
          },
          artifactDigest: {
            $ref: 'common.schema.json#/$defs/Digest',
          },
          sourceRef: {
            $ref: 'common.schema.json#/$defs/SourceRef',
          },
          outputs: {
            type: 'array',
            maxItems: 64,
            uniqueItems: true,
            items: {
              $ref: '#/$defs/OutputName',
            },
          },
        },
        additionalProperties: false,
      },
      BuildRecipeOutput: {
        type: 'object',
        required: ['name', 'hashMode'],
        properties: {
          name: {
            $ref: '#/$defs/OutputName',
          },
          hashMode: {
            enum: ['input-addressed', 'content-addressed', 'fixed-output'],
          },
          inputAddress: {
            $comment:
              'Opaque native input-address token (for example a Nix store-path hash). Never a PREX Digest.',
            type: 'string',
            minLength: 1,
            maxLength: 255,
          },
          expectedDigest: {
            $ref: 'common.schema.json#/$defs/Digest',
          },
          expectedTreeDigest: {
            $ref: 'common.schema.json#/$defs/Digest',
          },
          nodeId: {
            type: 'string',
            pattern: '^sha256:[0-9a-f]{64}$',
          },
        },
        allOf: [
          {
            $comment:
              'A fixed-output recipe must pin what it expects to fetch.',
            if: {
              required: ['hashMode'],
              properties: {
                hashMode: {
                  const: 'fixed-output',
                },
              },
            },
            then: {
              anyOf: [
                {
                  required: ['expectedDigest'],
                },
                {
                  required: ['expectedTreeDigest'],
                },
              ],
            },
          },
        ],
        additionalProperties: false,
      },
      BuildRecipe: {
        $comment:
          'A captured build plan. PREX never executes a recipe; recipeDigest = build-recipe-v1 projection digest, and recipeOutputId = recipe-output-v1 projection digest over {outputName, recipeDigest}.',
        type: 'object',
        required: [
          'recipeVersion',
          'captureProfile',
          'kind',
          'builder',
          'inputs',
          'outputs',
          'provenance',
          'semanticLoss',
        ],
        properties: {
          recipeVersion: {
            const: '1',
          },
          captureProfile: {
            const: 'derivation-capture-v1',
          },
          kind: {
            enum: [
              'derivation',
              'image-build',
              'source-build',
              'repackage',
              'unknown',
            ],
          },
          builder: {
            type: 'object',
            required: ['kind'],
            properties: {
              kind: {
                type: 'string',
                minLength: 1,
                maxLength: 64,
              },
              ref: {
                $ref: 'common.schema.json#/$defs/ExternalRef',
              },
            },
            additionalProperties: false,
          },
          system: {
            type: 'string',
            maxLength: 128,
          },
          platforms: {
            $ref: '#/$defs/PlatformContexts',
          },
          inputs: {
            type: 'array',
            maxItems: 10000,
            items: {
              $ref: '#/$defs/BuildRecipeInput',
            },
          },
          outputs: {
            type: 'array',
            minItems: 1,
            maxItems: 64,
            items: {
              $ref: '#/$defs/BuildRecipeOutput',
            },
          },
          provenance: {
            enum: ['captured', 'attested', 'declared'],
          },
          planRef: {
            $ref: 'common.schema.json#/$defs/ExternalRef',
          },
          nativeRecipe: {
            type: 'object',
            required: ['version', 'data'],
            properties: {
              version: {
                type: 'string',
                maxLength: 64,
              },
              data: {
                $ref: 'common.schema.json#/$defs/CanonicalJsonValue',
              },
            },
            additionalProperties: false,
          },
          sourceRefs: {
            type: 'array',
            maxItems: 128,
            items: {
              $ref: 'common.schema.json#/$defs/SourceRef',
            },
          },
          attestations: {
            type: 'array',
            maxItems: 128,
            items: {
              $ref: 'common.schema.json#/$defs/ExternalRef',
            },
          },
          evidenceRefs: {
            type: 'array',
            maxItems: 128,
            items: {
              $ref: 'common.schema.json#/$defs/ExternalRef',
            },
          },
          semanticLoss: {
            type: 'array',
            maxItems: 128,
            items: {
              $ref: 'common.schema.json#/$defs/SemanticLoss',
            },
          },
          extensions: {
            $ref: 'common.schema.json#/$defs/Extensions',
          },
        },
        additionalProperties: false,
      },
      SubstituteDescriptor: {
        $comment:
          'Prebuilt-content availability metadata (a binary-cache entry). A substitute locates bytes and declares references; it never establishes identity and must be digest-verified before use.',
        type: 'object',
        required: [
          'substituteVersion',
          'subject',
          'treeDigest',
          'size',
          'runtimeReferences',
          'locations',
        ],
        properties: {
          substituteVersion: {
            const: '1',
          },
          subject: {
            type: 'object',
            required: ['artifactDigest'],
            properties: {
              artifactDigest: {
                $ref: 'common.schema.json#/$defs/Digest',
              },
              recipeOutputId: {
                $ref: 'common.schema.json#/$defs/Digest',
              },
              nodeId: {
                type: 'string',
                pattern: '^sha256:[0-9a-f]{64}$',
              },
            },
            additionalProperties: false,
          },
          treeDigest: {
            $ref: 'common.schema.json#/$defs/Digest',
          },
          size: {
            type: 'integer',
            minimum: 0,
            maximum: 9007199254740991,
          },
          runtimeReferences: {
            type: 'array',
            maxItems: 4096,
            items: {
              $ref: '#/$defs/ArtifactReference',
            },
          },
          deriver: {
            $ref: 'common.schema.json#/$defs/Digest',
          },
          chunkIndexRef: {
            $ref: 'common.schema.json#/$defs/ExternalRef',
          },
          locations: {
            $comment:
              'Excluded from the substitute-v1 projection: locations are mutable and never identity.',
            type: 'array',
            maxItems: 64,
            items: {
              $ref: '#/$defs/ArtifactLocation',
            },
          },
          evidenceRefs: {
            type: 'array',
            maxItems: 128,
            items: {
              $ref: 'common.schema.json#/$defs/ExternalRef',
            },
          },
          extensions: {
            $ref: 'common.schema.json#/$defs/Extensions',
          },
        },
        additionalProperties: false,
      },
      LifecycleState: {
        type: 'object',
        required: ['status', 'eligible', 'warnings'],
        properties: {
          status: {
            enum: [
              'published',
              'yanked',
              'deprecated',
              'quarantined',
              'revoked',
              'delisted',
              'restored',
              'promoted',
              'removed-from-channel',
              'ownership-transferred',
              'unknown',
            ],
          },
          eligible: {
            type: 'boolean',
          },
          warnings: {
            type: 'array',
            maxItems: 128,
            items: {
              $ref: 'common.schema.json#/$defs/Warning',
            },
          },
          derivationEventIds: {
            type: 'array',
            maxItems: 1024,
            items: {
              type: 'string',
              maxLength: 255,
            },
          },
        },
        additionalProperties: false,
      },
      SourceSnapshot: {
        type: 'object',
        required: [
          'snapshotId',
          'providerId',
          'providerType',
          'endpointIdentity',
          'retrievedAt',
          'evaluationTime',
          'rootDigest',
          'recordsDigest',
          'evidenceRefs',
        ],
        properties: {
          snapshotId: {
            type: 'string',
            maxLength: 255,
          },
          providerId: {
            type: 'string',
            maxLength: 255,
          },
          providerType: {
            type: 'string',
            maxLength: 128,
          },
          endpointIdentity: {
            type: 'string',
            maxLength: 4096,
          },
          retrievedAt: {
            type: 'string',
            format: 'date-time',
          },
          evaluationTime: {
            type: 'string',
            format: 'date-time',
          },
          revision: {
            type: 'string',
            maxLength: 1024,
          },
          etag: {
            type: 'string',
            maxLength: 1024,
          },
          rootDigest: {
            $ref: 'common.schema.json#/$defs/Digest',
          },
          recordsDigest: {
            $ref: 'common.schema.json#/$defs/Digest',
          },
          authenticationScopeRef: {
            type: 'string',
            maxLength: 1024,
          },
          evidenceRefs: {
            type: 'array',
            maxItems: 128,
            items: {
              $ref: 'common.schema.json#/$defs/ExternalRef',
            },
          },
          extensions: {
            $ref: 'common.schema.json#/$defs/Extensions',
          },
        },
        additionalProperties: false,
      },
      PackageInstance: {
        type: 'object',
        required: [
          'nodeId',
          'identity',
          'nativeVersion',
          'normalizedVersion',
          'versionSortKey',
          'requirements',
          'capabilities',
          'conflicts',
          'cardinalityConstraints',
          'artifacts',
          'lifecycle',
          'sourceSnapshots',
          'metadataDigest',
          'nativeSemantics',
          'semanticLoss',
        ],
        properties: {
          nodeId: {
            type: 'string',
            pattern: '^sha256:[0-9a-f]{64}$',
          },
          identity: {
            $ref: '#/$defs/PackageIdentity',
          },
          nativeVersion: {
            type: 'string',
            maxLength: 1024,
          },
          normalizedVersion: {
            type: 'string',
            maxLength: 1024,
          },
          versionSortKey: {
            type: 'string',
            maxLength: 4096,
          },
          requirements: {
            type: 'array',
            maxItems: 10000,
            items: {
              $ref: '#/$defs/Requirement',
            },
          },
          capabilities: {
            type: 'array',
            maxItems: 10000,
            items: {
              $ref: '#/$defs/Capability',
            },
          },
          conflicts: {
            type: 'array',
            maxItems: 10000,
            items: {
              $ref: '#/$defs/Conflict',
            },
          },
          cardinalityConstraints: {
            type: 'array',
            maxItems: 10000,
            items: {
              $ref: '#/$defs/CardinalityConstraint',
            },
          },
          artifacts: {
            type: 'array',
            maxItems: 1024,
            items: {
              $ref: '#/$defs/ArtifactDescriptor',
            },
          },
          outputs: {
            $comment:
              'Absent means one implicit default output covering every artifact.',
            type: 'array',
            maxItems: 64,
            items: {
              $ref: '#/$defs/PackageOutput',
            },
          },
          lifecycle: {
            $ref: '#/$defs/LifecycleState',
          },
          sourceSnapshots: {
            type: 'array',
            maxItems: 128,
            items: {
              $ref: 'common.schema.json#/$defs/Digest',
            },
          },
          metadataDigest: {
            $ref: 'common.schema.json#/$defs/Digest',
          },
          rawMetadataRef: {
            $ref: 'common.schema.json#/$defs/ExternalRef',
          },
          nativeSemantics: {
            type: 'object',
            required: ['version', 'data'],
            properties: {
              version: {
                type: 'string',
                maxLength: 64,
              },
              data: {
                $ref: 'common.schema.json#/$defs/CanonicalJsonValue',
              },
            },
            additionalProperties: false,
          },
          semanticLoss: {
            type: 'array',
            maxItems: 128,
            items: {
              $ref: 'common.schema.json#/$defs/SemanticLoss',
            },
          },
          extensions: {
            $ref: 'common.schema.json#/$defs/Extensions',
          },
        },
        additionalProperties: false,
      },
    },
  },
  'https://openpacker.dev/spec/prex/v1/schemas/operations.schema.json': {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://openpacker.dev/spec/prex/v1/schemas/operations.schema.json',
    title: 'PREX operation contracts',
    $defs: {
      ConformanceLevel: {
        enum: [
          'PREX-N',
          'PREX-I',
          'PREX-E',
          'PREX-D',
          'PREX-S',
          'PREX-M',
          'PREX-V',
          'PREX-X',
          'PREX-R',
          'PREX-C',
        ],
      },
      Capabilities: {
        type: 'object',
        required: [
          'meta',
          'protocolVersions',
          'operations',
          'conformanceLevels',
          'purlTypes',
          'versSchemes',
          'semanticsProfiles',
          'targetDimensions',
          'evidenceTypes',
          'artifactTransports',
          'contentEncodings',
          'eventBindings',
          'limits',
          'pagination',
          'streaming',
          'authenticationSchemes',
          'extensionSchemaRefs',
        ],
        properties: {
          meta: {
            $ref: 'common.schema.json#/$defs/ProtocolMeta',
          },
          protocolVersions: {
            type: 'array',
            minItems: 1,
            maxItems: 16,
            uniqueItems: true,
            items: {
              type: 'string',
              maxLength: 32,
            },
          },
          operations: {
            type: 'array',
            minItems: 1,
            maxItems: 64,
            uniqueItems: true,
            items: {
              enum: [
                'normalize',
                'identify',
                'enumerate',
                'inspect',
                'solve',
                'materialize',
                'verify',
                'explain',
                'receipt.get',
                'snapshot.get',
                'events.get',
              ],
            },
          },
          conformanceLevels: {
            type: 'array',
            minItems: 1,
            maxItems: 10,
            uniqueItems: true,
            items: {
              $ref: '#/$defs/ConformanceLevel',
            },
          },
          purlTypes: {
            $ref: '#/$defs/StringSet',
          },
          versSchemes: {
            $ref: '#/$defs/StringSet',
          },
          semanticsProfiles: {
            $ref: '#/$defs/StringSet',
          },
          targetDimensions: {
            $ref: '#/$defs/StringSet',
          },
          evidenceTypes: {
            $ref: '#/$defs/StringSet',
          },
          artifactTransports: {
            $ref: '#/$defs/StringSet',
          },
          contentEncodings: {
            $ref: '#/$defs/StringSet',
          },
          eventBindings: {
            $ref: '#/$defs/StringSet',
          },
          limits: {
            $ref: '#/$defs/ResourceLimits',
          },
          pagination: {
            type: 'object',
            required: ['supported', 'maximumPageSize'],
            properties: {
              supported: {
                type: 'boolean',
              },
              maximumPageSize: {
                $ref: '#/$defs/PositiveLimit',
              },
            },
            additionalProperties: false,
          },
          streaming: {
            type: 'object',
            required: ['supported', 'bindings'],
            properties: {
              supported: {
                type: 'boolean',
              },
              bindings: {
                $ref: '#/$defs/StringSet',
              },
            },
            additionalProperties: false,
          },
          authenticationSchemes: {
            type: 'array',
            maxItems: 32,
            items: {
              type: 'object',
              required: ['type'],
              properties: {
                type: {
                  enum: [
                    'none',
                    'bearer',
                    'oauth2',
                    'mtls',
                    'api-key',
                    'provider-specific',
                  ],
                },
                description: {
                  type: 'string',
                  maxLength: 4096,
                },
              },
              additionalProperties: false,
            },
          },
          extensionSchemaRefs: {
            type: 'array',
            maxItems: 64,
            items: {
              type: 'string',
              format: 'uri',
              maxLength: 8192,
            },
          },
        },
        additionalProperties: false,
      },
      StringSet: {
        type: 'array',
        maxItems: 256,
        uniqueItems: true,
        items: {
          type: 'string',
          minLength: 1,
          maxLength: 255,
        },
      },
      PositiveLimit: {
        type: 'integer',
        minimum: 1,
        maximum: 9007199254740991,
      },
      ResourceLimits: {
        type: 'object',
        required: [
          'requestBytes',
          'batchItems',
          'universeNodes',
          'graphNodes',
          'artifactMetadataBytes',
        ],
        properties: {
          requestBytes: {
            $ref: '#/$defs/PositiveLimit',
          },
          batchItems: {
            $ref: '#/$defs/PositiveLimit',
          },
          universeNodes: {
            $ref: '#/$defs/PositiveLimit',
          },
          graphNodes: {
            $ref: '#/$defs/PositiveLimit',
          },
          artifactMetadataBytes: {
            $ref: '#/$defs/PositiveLimit',
          },
          requirements: {
            $ref: '#/$defs/PositiveLimit',
          },
          alternativesPerRequirement: {
            $ref: '#/$defs/PositiveLimit',
          },
          predicateDepth: {
            $ref: '#/$defs/PositiveLimit',
          },
          requirementDepth: {
            $ref: '#/$defs/PositiveLimit',
          },
          overlays: {
            $ref: '#/$defs/PositiveLimit',
          },
          metadataBytes: {
            $ref: '#/$defs/PositiveLimit',
          },
          solveWallTimeMilliseconds: {
            $ref: '#/$defs/PositiveLimit',
          },
          solverMemoryBytes: {
            $ref: '#/$defs/PositiveLimit',
          },
          explanationEdges: {
            $ref: '#/$defs/PositiveLimit',
          },
        },
        additionalProperties: false,
      },
      RequestContext: {
        type: 'object',
        properties: {
          correlationId: {
            type: 'string',
            maxLength: 255,
          },
          traceparent: {
            type: 'string',
            pattern: '^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$',
          },
          tracestate: {
            type: 'string',
            maxLength: 512,
          },
          idempotencyKey: {
            type: 'string',
            maxLength: 255,
          },
          timeoutMilliseconds: {
            type: 'integer',
            minimum: 1,
            maximum: 300000,
          },
          providerIds: {
            $ref: '#/$defs/StringSet',
          },
          semanticsProfile: {
            enum: [
              'native-capture-v1',
              'native-validated-v1',
              'prex-calculus-subset-v1',
            ],
          },
          evaluationTime: {
            type: 'string',
            format: 'date-time',
          },
          extensions: {
            $ref: 'common.schema.json#/$defs/Extensions',
          },
        },
        additionalProperties: false,
      },
      NormalizeInput: {
        oneOf: [
          {
            type: 'object',
            required: ['type', 'value'],
            properties: {
              type: {
                const: 'purl',
              },
              value: {
                type: 'string',
                pattern: '^pkg:',
                maxLength: 8192,
              },
            },
            additionalProperties: false,
          },
          {
            type: 'object',
            required: ['type', 'value'],
            properties: {
              type: {
                const: 'vers',
              },
              value: {
                type: 'string',
                pattern: '^vers:',
                maxLength: 8192,
              },
            },
            additionalProperties: false,
          },
          {
            type: 'object',
            required: ['type', 'ecosystem', 'value'],
            properties: {
              type: {
                enum: ['native-coordinate', 'native-version', 'native-range'],
              },
              ecosystem: {
                type: 'string',
                maxLength: 64,
              },
              value: {
                type: 'string',
                maxLength: 8192,
              },
            },
            additionalProperties: false,
          },
          {
            type: 'object',
            required: ['type', 'value'],
            properties: {
              type: {
                const: 'digest',
              },
              value: {
                $ref: 'common.schema.json#/$defs/DigestString',
              },
            },
            additionalProperties: false,
          },
          {
            type: 'object',
            required: ['type', 'value'],
            properties: {
              type: {
                const: 'target',
              },
              value: {
                $ref: 'model.schema.json#/$defs/TargetContext',
              },
            },
            additionalProperties: false,
          },
        ],
      },
      NormalizeRequest: {
        type: 'object',
        required: ['items'],
        properties: {
          items: {
            type: 'array',
            minItems: 1,
            maxItems: 10000,
            items: {
              $ref: '#/$defs/NormalizeInput',
            },
          },
          context: {
            $ref: '#/$defs/RequestContext',
          },
        },
        additionalProperties: false,
      },
      NormalizeResult: {
        type: 'object',
        required: [
          'type',
          'original',
          'canonical',
          'parsed',
          'reversibility',
          'warnings',
          'semanticLoss',
        ],
        properties: {
          type: {
            type: 'string',
            maxLength: 64,
          },
          original: {
            $ref: 'common.schema.json#/$defs/CanonicalJsonValue',
          },
          canonical: {
            $ref: 'common.schema.json#/$defs/CanonicalJsonValue',
          },
          parsed: {
            type: 'object',
            maxProperties: 128,
            additionalProperties: {
              $ref: 'common.schema.json#/$defs/CanonicalJsonValue',
            },
          },
          ecosystem: {
            type: 'string',
            maxLength: 64,
          },
          scheme: {
            type: 'string',
            maxLength: 64,
          },
          reversibility: {
            enum: ['exact', 'lossy', 'not-applicable'],
          },
          warnings: {
            type: 'array',
            maxItems: 128,
            items: {
              $ref: 'common.schema.json#/$defs/Warning',
            },
          },
          semanticLoss: {
            type: 'array',
            maxItems: 128,
            items: {
              $ref: 'common.schema.json#/$defs/SemanticLoss',
            },
          },
        },
        additionalProperties: false,
      },
      NormalizeResponse: {
        type: 'object',
        required: ['meta', 'results'],
        properties: {
          meta: {
            $ref: 'common.schema.json#/$defs/ProtocolMeta',
          },
          results: {
            type: 'array',
            minItems: 1,
            maxItems: 10000,
            items: {
              $ref: '#/$defs/NormalizeResult',
            },
          },
        },
        additionalProperties: false,
      },
      IdentifyRequest: {
        type: 'object',
        required: ['query'],
        properties: {
          query: {
            type: 'object',
            minProperties: 1,
            maxProperties: 8,
            properties: {
              purl: {
                type: 'string',
                pattern: '^pkg:',
              },
              nativeCoordinate: {
                type: 'string',
                maxLength: 4096,
              },
              ecosystem: {
                type: 'string',
                maxLength: 64,
              },
              sourceRef: {
                $ref: 'common.schema.json#/$defs/SourceRef',
              },
              alias: {
                type: 'string',
                maxLength: 4096,
              },
              externalRef: {
                $ref: 'common.schema.json#/$defs/ExternalRef',
              },
            },
            additionalProperties: false,
          },
          context: {
            $ref: '#/$defs/RequestContext',
          },
        },
        additionalProperties: false,
      },
      IdentityCandidate: {
        type: 'object',
        required: ['identity', 'confidence', 'provenance', 'warnings'],
        properties: {
          identity: {
            $ref: 'model.schema.json#/$defs/PackageIdentity',
          },
          confidence: {
            type: 'integer',
            minimum: 0,
            maximum: 1000000,
          },
          provenance: {
            type: 'array',
            maxItems: 128,
            items: {
              $ref: 'common.schema.json#/$defs/SourceRef',
            },
          },
          warnings: {
            type: 'array',
            maxItems: 128,
            items: {
              $ref: 'common.schema.json#/$defs/Warning',
            },
          },
        },
        additionalProperties: false,
      },
      IdentifyResponse: {
        type: 'object',
        required: ['meta', 'status', 'candidates'],
        properties: {
          meta: {
            $ref: 'common.schema.json#/$defs/ProtocolMeta',
          },
          status: {
            enum: ['identified', 'ambiguous', 'not-found'],
          },
          candidates: {
            type: 'array',
            maxItems: 10000,
            items: {
              $ref: '#/$defs/IdentityCandidate',
            },
          },
        },
        additionalProperties: false,
      },
      EnumerateRequest: {
        type: 'object',
        required: ['canonicalPurl', 'target', 'lifecyclePolicy', 'page'],
        properties: {
          canonicalPurl: {
            type: 'string',
            pattern: '^pkg:',
          },
          vers: {
            type: 'string',
            pattern: '^vers:',
          },
          target: {
            $ref: 'model.schema.json#/$defs/TargetContext',
          },
          lifecyclePolicy: {
            type: 'object',
            required: ['includeYanked', 'includeDelisted'],
            properties: {
              includeYanked: {
                type: 'boolean',
              },
              includeDelisted: {
                type: 'boolean',
              },
            },
            additionalProperties: false,
          },
          page: {
            type: 'object',
            required: ['size'],
            properties: {
              cursor: {
                type: 'string',
                maxLength: 4096,
              },
              size: {
                type: 'integer',
                minimum: 1,
                maximum: 1000,
              },
            },
            additionalProperties: false,
          },
          context: {
            $ref: '#/$defs/RequestContext',
          },
        },
        additionalProperties: false,
      },
      EnumeratedVersion: {
        type: 'object',
        required: [
          'exactPurl',
          'originalVersion',
          'normalizedVersion',
          'sortKey',
          'lifecycle',
          'artifacts',
          'sourceSnapshot',
          'metadataDigest',
          'warnings',
        ],
        properties: {
          exactPurl: {
            type: 'string',
            pattern: '^pkg:.*@',
          },
          originalVersion: {
            type: 'string',
            maxLength: 1024,
          },
          normalizedVersion: {
            type: 'string',
            maxLength: 1024,
          },
          sortKey: {
            type: 'string',
            maxLength: 4096,
          },
          publishedAt: {
            type: 'string',
            format: 'date-time',
          },
          lifecycle: {
            $ref: 'model.schema.json#/$defs/LifecycleState',
          },
          artifacts: {
            type: 'array',
            maxItems: 1024,
            items: {
              $ref: 'model.schema.json#/$defs/ArtifactDescriptor',
            },
          },
          sourceSnapshot: {
            $ref: 'common.schema.json#/$defs/Digest',
          },
          metadataDigest: {
            $ref: 'common.schema.json#/$defs/Digest',
          },
          warnings: {
            type: 'array',
            maxItems: 128,
            items: {
              $ref: 'common.schema.json#/$defs/Warning',
            },
          },
        },
        additionalProperties: false,
      },
      EnumerateResponse: {
        type: 'object',
        required: ['meta', 'versions'],
        properties: {
          meta: {
            $ref: 'common.schema.json#/$defs/ProtocolMeta',
          },
          versions: {
            type: 'array',
            maxItems: 1000,
            items: {
              $ref: '#/$defs/EnumeratedVersion',
            },
          },
          nextCursor: {
            type: 'string',
            maxLength: 4096,
          },
        },
        additionalProperties: false,
      },
      InspectRequest: {
        type: 'object',
        required: ['exact'],
        properties: {
          exact: {
            oneOf: [
              {
                type: 'object',
                required: ['exactPurl'],
                properties: {
                  exactPurl: {
                    type: 'string',
                    pattern: '^pkg:.*@',
                  },
                },
                additionalProperties: false,
              },
              {
                type: 'object',
                required: ['ecosystem', 'coordinate'],
                properties: {
                  ecosystem: {
                    type: 'string',
                    maxLength: 64,
                  },
                  coordinate: {
                    type: 'string',
                    maxLength: 4096,
                  },
                },
                additionalProperties: false,
              },
            ],
          },
          includeRawMetadata: {
            type: 'boolean',
          },
          context: {
            $ref: '#/$defs/RequestContext',
          },
        },
        additionalProperties: false,
      },
      InspectResponse: {
        type: 'object',
        required: ['meta', 'package'],
        properties: {
          meta: {
            $ref: 'common.schema.json#/$defs/ProtocolMeta',
          },
          package: {
            $ref: 'model.schema.json#/$defs/PackageInstance',
          },
        },
        additionalProperties: false,
      },
      MaterializeRequest: {
        type: 'object',
        required: ['subject'],
        properties: {
          subject: {
            oneOf: [
              {
                type: 'object',
                required: ['type', 'exactPurl'],
                properties: {
                  type: {
                    const: 'purl',
                  },
                  exactPurl: {
                    type: 'string',
                    pattern: '^pkg:.*@',
                  },
                },
                additionalProperties: false,
              },
              {
                type: 'object',
                required: ['type', 'nodeId'],
                properties: {
                  type: {
                    const: 'solution-node',
                  },
                  nodeId: {
                    type: 'string',
                    maxLength: 255,
                  },
                },
                additionalProperties: false,
              },
              {
                type: 'object',
                required: ['type', 'descriptor'],
                properties: {
                  type: {
                    const: 'artifact',
                  },
                  descriptor: {
                    $ref: 'model.schema.json#/$defs/ArtifactDescriptor',
                  },
                },
                additionalProperties: false,
              },
              {
                type: 'object',
                required: ['type', 'digest'],
                properties: {
                  type: {
                    const: 'digest',
                  },
                  digest: {
                    $ref: 'common.schema.json#/$defs/Digest',
                  },
                },
                additionalProperties: false,
              },
              {
                type: 'object',
                required: ['type', 'component', 'version'],
                properties: {
                  type: {
                    const: 'ocm',
                  },
                  component: {
                    type: 'string',
                    minLength: 1,
                    maxLength: 1024,
                  },
                  version: {
                    type: 'string',
                    minLength: 1,
                    maxLength: 1024,
                  },
                  resourceName: {
                    type: 'string',
                    maxLength: 1024,
                  },
                  descriptorDigest: {
                    $ref: 'common.schema.json#/$defs/Digest',
                  },
                },
                additionalProperties: false,
              },
            ],
          },
          forensic: {
            type: 'boolean',
          },
          outputs: {
            $comment:
              'Restrict materialization to these package outputs. Absent means the default output.',
            type: 'array',
            minItems: 1,
            maxItems: 64,
            uniqueItems: true,
            items: {
              $ref: 'model.schema.json#/$defs/OutputName',
            },
          },
          target: {
            $ref: 'model.schema.json#/$defs/TargetContext',
          },
          policy: {
            $ref: 'resolution.schema.json#/$defs/PolicyInput',
          },
          resourceLimits: {
            $ref: '#/$defs/ResourceLimits',
          },
          context: {
            $ref: '#/$defs/RequestContext',
          },
        },
        additionalProperties: false,
      },
      MaterializeResponse: {
        type: 'object',
        required: ['meta', 'descriptor', 'restrictions'],
        properties: {
          meta: {
            $ref: 'common.schema.json#/$defs/ProtocolMeta',
          },
          descriptor: {
            $ref: 'model.schema.json#/$defs/ArtifactDescriptor',
          },
          sources: {
            type: 'array',
            maxItems: 64,
            items: {
              $ref: 'model.schema.json#/$defs/ArtifactLocation',
            },
          },
          credentialRequirements: {
            type: 'array',
            maxItems: 64,
            items: {
              type: 'object',
              required: ['credentialRef', 'transport'],
              properties: {
                credentialRef: {
                  type: 'string',
                  maxLength: 1024,
                },
                transport: {
                  type: 'string',
                  maxLength: 64,
                },
                sourceUri: {
                  type: 'string',
                  format: 'uri',
                  maxLength: 8192,
                },
              },
              additionalProperties: false,
            },
          },
          rangeSupported: {
            type: 'boolean',
          },
          chunkIndexRef: {
            $ref: 'common.schema.json#/$defs/ExternalRef',
          },
          ociReferrers: {
            type: 'array',
            maxItems: 128,
            items: {
              $ref: 'common.schema.json#/$defs/ExternalRef',
            },
          },
          ocmReference: {
            $ref: 'common.schema.json#/$defs/ExternalRef',
          },
          tufTargetMetadataRef: {
            $ref: 'common.schema.json#/$defs/ExternalRef',
          },
          restrictions: {
            type: 'array',
            maxItems: 128,
            items: {
              type: 'string',
              maxLength: 4096,
            },
          },
        },
        additionalProperties: false,
      },
      EvidenceStatus: {
        enum: [
          'valid',
          'invalid',
          'not-provided',
          'unknown',
          'not-applicable',
          'policy-denied',
        ],
      },
      VerificationCheck: {
        anyOf: [
          {
            enum: [
              'artifact-digest',
              'artifact-size',
              'oci-descriptors',
              'ocm-integrity',
              'receipt-signature',
              'receipt-bindings',
              'tuf-metadata',
              'sigstore-bundle',
              'slsa-subject',
              'cyclonedx-sbom',
              'lifecycle-eligibility',
              'policy',
            ],
          },
          {
            type: 'string',
            pattern: '^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$',
            maxLength: 128,
          },
        ],
      },
      EvidenceResult: {
        type: 'object',
        required: [
          'type',
          'subjectDigest',
          'status',
          'verifier',
          'evaluationTime',
          'policyRelevant',
          'diagnostics',
        ],
        properties: {
          type: {
            type: 'string',
            maxLength: 128,
          },
          subjectDigest: {
            $ref: 'common.schema.json#/$defs/Digest',
          },
          evidenceRef: {
            $ref: 'common.schema.json#/$defs/ExternalRef',
          },
          evidenceDescriptorDigest: {
            $ref: 'common.schema.json#/$defs/Digest',
          },
          status: {
            $ref: '#/$defs/EvidenceStatus',
          },
          verifier: {
            type: 'object',
            required: ['implementation', 'version'],
            properties: {
              implementation: {
                type: 'string',
                maxLength: 255,
              },
              version: {
                type: 'string',
                maxLength: 128,
              },
              buildDigest: {
                $ref: 'common.schema.json#/$defs/Digest',
              },
            },
            additionalProperties: false,
          },
          evaluationTime: {
            type: 'string',
            format: 'date-time',
          },
          policyRelevant: {
            type: 'boolean',
          },
          diagnostics: {
            type: 'array',
            maxItems: 128,
            items: {
              $ref: 'common.schema.json#/$defs/Warning',
            },
          },
        },
        additionalProperties: false,
      },
      VerifyRequest: {
        type: 'object',
        required: ['subject', 'checks', 'evaluationTime'],
        properties: {
          subject: {
            oneOf: [
              {
                $ref: 'model.schema.json#/$defs/ArtifactDescriptor',
              },
              {
                $ref: 'resolution.schema.json#/$defs/SignedReceipt',
              },
              {
                $ref: 'common.schema.json#/$defs/ExternalRef',
              },
            ],
          },
          checks: {
            type: 'array',
            minItems: 1,
            maxItems: 256,
            uniqueItems: true,
            items: {
              $ref: '#/$defs/VerificationCheck',
            },
          },
          evidenceRefs: {
            type: 'array',
            maxItems: 1024,
            items: {
              $ref: 'common.schema.json#/$defs/ExternalRef',
            },
          },
          policy: {
            $ref: 'resolution.schema.json#/$defs/PolicyInput',
          },
          resourceLimits: {
            $ref: '#/$defs/ResourceLimits',
          },
          evaluationTime: {
            type: 'string',
            format: 'date-time',
          },
          context: {
            $ref: '#/$defs/RequestContext',
          },
        },
        additionalProperties: false,
      },
      VerifyResponse: {
        type: 'object',
        required: ['meta', 'decision', 'evidence'],
        properties: {
          meta: {
            $ref: 'common.schema.json#/$defs/ProtocolMeta',
          },
          decision: {
            enum: ['allow', 'deny', 'indeterminate'],
          },
          policyDigest: {
            $ref: 'common.schema.json#/$defs/Digest',
          },
          evidence: {
            type: 'array',
            maxItems: 10000,
            items: {
              $ref: '#/$defs/EvidenceResult',
            },
          },
          diagnostics: {
            type: 'array',
            maxItems: 1024,
            items: {
              $ref: 'common.schema.json#/$defs/Warning',
            },
          },
        },
        additionalProperties: false,
      },
      ExplainRequest: {
        type: 'object',
        required: ['solutionDigest'],
        properties: {
          solutionDigest: {
            $ref: 'common.schema.json#/$defs/Digest',
          },
          format: {
            enum: ['graph', 'text', 'both'],
          },
          context: {
            $ref: '#/$defs/RequestContext',
          },
        },
        additionalProperties: false,
      },
      ExplainResponse: {
        type: 'object',
        required: ['meta', 'graph'],
        properties: {
          meta: {
            $ref: 'common.schema.json#/$defs/ProtocolMeta',
          },
          graph: {
            $ref: 'resolution.schema.json#/$defs/ExplanationGraph',
          },
          text: {
            type: 'string',
            maxLength: 1048576,
          },
        },
        additionalProperties: false,
      },
      Problem: {
        type: 'object',
        required: ['type', 'title', 'status', 'code', 'retryable'],
        properties: {
          type: {
            type: 'string',
            format: 'uri',
          },
          title: {
            type: 'string',
            maxLength: 1024,
          },
          status: {
            type: 'integer',
            minimum: 400,
            maximum: 599,
          },
          detail: {
            type: 'string',
            maxLength: 16384,
          },
          instance: {
            type: 'string',
            format: 'uri-reference',
          },
          code: {
            $ref: '#/$defs/ErrorCode',
          },
          retryable: {
            type: 'boolean',
          },
          correlationId: {
            type: 'string',
            maxLength: 255,
          },
          violations: {
            type: 'array',
            maxItems: 1024,
            items: {
              type: 'object',
              required: ['path', 'code', 'message'],
              properties: {
                path: {
                  type: 'string',
                  maxLength: 4096,
                },
                code: {
                  type: 'string',
                  maxLength: 128,
                },
                message: {
                  type: 'string',
                  maxLength: 8192,
                },
              },
              additionalProperties: false,
            },
          },
          explanationRef: {
            type: 'string',
            maxLength: 8192,
          },
          provider: {
            type: 'string',
            maxLength: 255,
          },
          upstreamStatus: {
            type: 'integer',
            minimum: 100,
            maximum: 599,
          },
          normalizedRequest: {
            $ref: 'resolution.schema.json#/$defs/SolveRequest',
          },
          requestDigest: {
            $ref: 'common.schema.json#/$defs/Digest',
          },
          universeDigest: {
            $ref: 'common.schema.json#/$defs/Digest',
          },
          unsatCore: {
            type: 'array',
            maxItems: 10000,
            uniqueItems: true,
            items: {
              type: 'string',
              maxLength: 255,
            },
          },
          constraintSources: {
            type: 'array',
            maxItems: 10000,
            items: {
              type: 'object',
              required: ['constraintId', 'source'],
              properties: {
                constraintId: {
                  type: 'string',
                  maxLength: 255,
                },
                source: {
                  $ref: 'common.schema.json#/$defs/SourceRef',
                },
              },
              additionalProperties: false,
            },
          },
          candidateRejections: {
            type: 'array',
            maxItems: 100000,
            items: {
              type: 'object',
              required: ['nodeId', 'reasonRefs'],
              properties: {
                nodeId: {
                  type: 'string',
                  maxLength: 255,
                },
                reasonRefs: {
                  type: 'array',
                  maxItems: 128,
                  items: {
                    type: 'string',
                    maxLength: 255,
                  },
                },
              },
              additionalProperties: false,
            },
          },
          suggestions: {
            type: 'array',
            maxItems: 128,
            items: {
              type: 'object',
              required: ['code', 'derivation'],
              properties: {
                code: {
                  type: 'string',
                  maxLength: 128,
                },
                derivation: {
                  type: 'string',
                  maxLength: 8192,
                },
              },
              additionalProperties: false,
            },
          },
          extensions: {
            $ref: 'common.schema.json#/$defs/Extensions',
          },
        },
        additionalProperties: false,
        allOf: [
          {
            if: {
              required: ['code'],
              properties: {
                code: {
                  const: 'UNSATISFIABLE',
                },
              },
            },
            then: {
              properties: {
                normalizedRequest: {
                  $ref: 'resolution.schema.json#/$defs/SolveRequest',
                },
                requestDigest: {
                  $ref: 'common.schema.json#/$defs/Digest',
                },
                universeDigest: {
                  $ref: 'common.schema.json#/$defs/Digest',
                },
                unsatCore: {
                  type: 'array',
                },
                constraintSources: {
                  type: 'array',
                },
                candidateRejections: {
                  type: 'array',
                },
              },
              required: [
                'normalizedRequest',
                'requestDigest',
                'universeDigest',
                'unsatCore',
                'constraintSources',
                'candidateRejections',
              ],
            },
          },
        ],
      },
      ErrorCode: {
        enum: [
          'INVALID_REQUEST',
          'INVALID_PURL',
          'INVALID_VERS',
          'INVALID_NATIVE_COORDINATE',
          'UNSUPPORTED_ECOSYSTEM',
          'UNSUPPORTED_SEMANTICS_PROFILE',
          'AMBIGUOUS_IDENTITY',
          'PROVIDER_CAPABILITY_MISSING',
          'PACKAGE_NOT_FOUND',
          'VERSION_NOT_FOUND',
          'SNAPSHOT_NOT_FOUND',
          'SNAPSHOT_MISMATCH',
          'UNSATISFIABLE',
          'SEMANTIC_LOSS_REJECTED',
          'POLICY_DENIED',
          'ARTIFACT_NOT_FOUND',
          'DIGEST_MISMATCH',
          'SIZE_MISMATCH',
          'STALE_METADATA',
          'INVALID_SIGNATURE',
          'PROVENANCE_MISMATCH',
          'LIFECYCLE_DENIED',
          'RATE_LIMITED',
          'UPSTREAM_UNAVAILABLE',
          'CANCELLED',
          'INTERNAL_ERROR',
        ],
      },
    },
  },
  'https://openpacker.dev/spec/prex/v1/schemas/package-manifest.schema.json': {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://openpacker.dev/spec/prex/v1/schemas/package-manifest.schema.json',
    title: 'PREX package manifest (one package, every ecosystem it ships to)',
    $comment:
      "Shaped after the MCP registry's server.json, which solved the same problem for MCP servers: one document naming a thing plus the several package managers it can be obtained from. Three deliberate differences. Integrity is a PREX Digest, not a bare sha256 hex string, so the algorithm is stated rather than assumed. A distribution names a registryId from a Registry Definition, not just a base URL, so an external registry provider is identified rather than located. And provenance is evidence PREX already produces — snapshot, receipt, trust tier, semantic loss — not a publisher-supplied blob nobody checked.",
    $ref: '#/$defs/PackageManifest',
    $defs: {
      PackageManifestVersion: {
        const: '1',
      },
      PackageManifest: {
        type: 'object',
        required: [
          'packageManifestVersion',
          'name',
          'version',
          'distributions',
        ],
        properties: {
          packageManifestVersion: {
            $ref: '#/$defs/PackageManifestVersion',
          },
          name: {
            $comment:
              "The name a human uses. Ecosystem-specific spellings live on each distribution, because npm's @scope/name and NuGet's Scope.Name are the same package under different rules.",
            type: 'string',
            minLength: 1,
            maxLength: 512,
          },
          title: {
            type: 'string',
            maxLength: 512,
          },
          description: {
            type: 'string',
            maxLength: 8192,
          },
          version: {
            $comment:
              'The release this manifest describes. Exact: a manifest naming a range describes no particular thing, and could not be pinned or verified.',
            type: 'string',
            minLength: 1,
            maxLength: 255,
            not: {
              const: 'latest',
            },
          },
          websiteUrl: {
            type: 'string',
            format: 'uri',
            maxLength: 8192,
          },
          licenses: {
            type: 'array',
            maxItems: 32,
            items: {
              type: 'string',
              maxLength: 255,
            },
          },
          repository: {
            $ref: '#/$defs/RepositoryRef',
          },
          registries: {
            $comment:
              "Registry Definitions this manifest's distributions refer to, carried inline so a consumer can resolve registryId without a second lookup. External registry providers are first class here.",
            type: 'array',
            maxItems: 64,
            items: {
              $ref: '#/$defs/RegistryRef',
            },
          },
          distributions: {
            $comment:
              'server.json calls these `packages`. One entry per ecosystem this release ships to.',
            type: 'array',
            minItems: 1,
            maxItems: 256,
            items: {
              $ref: '#/$defs/Distribution',
            },
          },
          provenance: {
            $ref: '#/$defs/Provenance',
          },
          semanticLoss: {
            type: 'array',
            maxItems: 256,
            items: {
              $ref: 'common.schema.json#/$defs/SemanticLoss',
            },
          },
          extensions: {
            $ref: 'common.schema.json#/$defs/Extensions',
          },
        },
        additionalProperties: false,
      },
      Distribution: {
        type: 'object',
        required: ['purlType', 'identifier', 'version'],
        properties: {
          purlType: {
            $comment:
              "The PURL type, which PREX already uses as the ecosystem's identity everywhere else. server.json's registryType is the same idea with a private vocabulary; reusing purl means no second naming scheme to keep in step.",
            $ref: 'registry-definition.schema.json#/$defs/PurlType',
          },
          identifier: {
            $comment:
              "The name this ecosystem knows the package by, spelled the ecosystem's way.",
            type: 'string',
            minLength: 1,
            maxLength: 8192,
          },
          version: {
            type: 'string',
            minLength: 1,
            maxLength: 255,
            not: {
              const: 'latest',
            },
          },
          exactPurl: {
            $comment:
              'The canonical PREX identity. Derivable from purlType/identifier/version, and stated so a consumer never has to re-derive it and get the encoding rules wrong.',
            type: 'string',
            pattern: '^pkg:.*@',
            maxLength: 8192,
          },
          registryId: {
            $comment:
              'Which authority publishes it. A base URL says where to look; this says who is answering, which is what a policy can pin.',
            $ref: 'registry-definition.schema.json#/$defs/RegistryId',
          },
          registryBaseUrl: {
            type: 'string',
            format: 'uri',
            maxLength: 8192,
          },
          digest: {
            $comment:
              'sha256 over the archive bytes — PREX identity, algorithm stated.',
            $ref: 'common.schema.json#/$defs/Digest',
          },
          nativeIntegrity: {
            $ref: '#/$defs/NativeIntegrity',
          },
          size: {
            type: 'integer',
            minimum: 0,
          },
          mediaType: {
            type: 'string',
            maxLength: 255,
          },
          locations: {
            type: 'array',
            maxItems: 32,
            items: {
              type: 'string',
              format: 'uri',
              maxLength: 8192,
            },
          },
          runtimeHint: {
            $comment:
              'How this is ordinarily run without installing it, as server.json spells it: npx, uvx, dnx, docker.',
            type: 'string',
            maxLength: 64,
          },
          requirements: {
            type: 'array',
            maxItems: 4096,
            items: {
              $ref: '#/$defs/DistributionRequirement',
            },
          },
          extensions: {
            $ref: 'common.schema.json#/$defs/Extensions',
          },
        },
        additionalProperties: false,
      },
      DistributionRequirement: {
        type: 'object',
        required: ['identifier', 'scope'],
        properties: {
          identifier: {
            type: 'string',
            minLength: 1,
            maxLength: 8192,
          },
          purl: {
            type: 'string',
            maxLength: 8192,
          },
          range: {
            type: 'string',
            maxLength: 4096,
          },
          scope: {
            enum: ['runtime', 'development', 'optional', 'peer', 'build'],
          },
        },
        additionalProperties: false,
      },
      NativeIntegrity: {
        $comment:
          "The value the ecosystem's own lockfile pins with, kept beside the PREX digest rather than instead of it: npm SRI, NuGet base64 sha512, Cargo sha256 hex. A consumer writing a native lockfile needs this exact form; a consumer verifying identity needs the digest.",
        type: 'object',
        required: ['algorithm', 'value', 'encoding'],
        properties: {
          algorithm: {
            type: 'string',
            maxLength: 32,
          },
          value: {
            type: 'string',
            minLength: 1,
            maxLength: 1024,
          },
          encoding: {
            enum: ['hex', 'base64', 'sri'],
          },
        },
        additionalProperties: false,
      },
      RegistryRef: {
        type: 'object',
        required: ['registryId'],
        properties: {
          registryId: {
            $ref: 'registry-definition.schema.json#/$defs/RegistryId',
          },
          displayName: {
            type: 'string',
            maxLength: 255,
          },
          purlTypes: {
            type: 'array',
            maxItems: 64,
            items: {
              $ref: 'registry-definition.schema.json#/$defs/PurlType',
            },
          },
          serviceIndex: {
            $comment:
              'Where the Registry Definition itself can be fetched, so an external provider is discoverable rather than hardcoded.',
            type: 'string',
            maxLength: 8192,
          },
          definitionDigest: {
            $comment:
              'The Registry Definition this manifest was built against. A registry that later advertises different capabilities is a different answer, and this is what makes that visible.',
            $ref: 'common.schema.json#/$defs/Digest',
          },
        },
        additionalProperties: false,
      },
      RepositoryRef: {
        type: 'object',
        required: ['url'],
        properties: {
          url: {
            type: 'string',
            format: 'uri',
            maxLength: 8192,
          },
          source: {
            type: 'string',
            maxLength: 128,
          },
          revision: {
            type: 'string',
            maxLength: 1024,
          },
          subfolder: {
            type: 'string',
            maxLength: 4096,
          },
        },
        additionalProperties: false,
      },
      Provenance: {
        $comment:
          'What is known about where this came from, and what was actually checked. server.json carries publisher-provided metadata; this carries the artefacts PREX itself produced, so a consumer can tell a claim from a verification.',
        type: 'object',
        properties: {
          producedBy: {
            type: 'object',
            required: ['id', 'version'],
            properties: {
              id: {
                type: 'string',
                minLength: 1,
                maxLength: 255,
              },
              version: {
                type: 'string',
                minLength: 1,
                maxLength: 128,
              },
            },
            additionalProperties: false,
          },
          producedAt: {
            type: 'string',
            format: 'date-time',
          },
          sourceRefs: {
            type: 'array',
            maxItems: 64,
            items: {
              $ref: 'common.schema.json#/$defs/SourceRef',
            },
          },
          snapshotDigest: {
            $ref: 'common.schema.json#/$defs/Digest',
          },
          receiptDigest: {
            $comment:
              "The resolution receipt this manifest's versions came from. Without it the versions are an assertion; with it they are checkable.",
            $ref: 'common.schema.json#/$defs/Digest',
          },
          policyDigest: {
            $ref: 'common.schema.json#/$defs/Digest',
          },
          trustLevel: {
            enum: [
              'trusted-publisher',
              'provenance',
              'registry-attested',
              'unsigned',
              'unknown',
            ],
          },
          evidence: {
            type: 'array',
            maxItems: 64,
            items: {
              $ref: 'common.schema.json#/$defs/ExternalRef',
            },
          },
          verified: {
            $comment:
              'Which claims were checked when this was produced, rather than merely recorded. An empty list is an honest answer.',
            type: 'array',
            maxItems: 32,
            items: {
              enum: [
                'artifact-digest',
                'native-integrity',
                'registry-identity',
                'receipt-signature',
                'supply-chain-policy',
              ],
            },
          },
        },
        additionalProperties: false,
      },
      ManifestSignature: {
        $comment:
          'Same construction as SignedReceipt: ed25519 over the ASCII formatDigest(manifestDigest), so one verifier serves both and a manifest cannot be re-signed as a receipt.',
        type: 'object',
        required: ['algorithm', 'keyId', 'signature'],
        properties: {
          algorithm: {
            const: 'ed25519',
          },
          keyId: {
            type: 'string',
            minLength: 1,
            maxLength: 1024,
          },
          signature: {
            type: 'string',
            contentEncoding: 'base64',
            maxLength: 256,
          },
          identity: {
            type: 'string',
            maxLength: 1024,
          },
          role: {
            $comment:
              "Who this signature speaks for. A registry counter-signing what a publisher signed is a different claim from the publisher's own, and collapsing them loses the ability to say which one a consumer trusts.",
            enum: ['publisher', 'registry'],
          },
        },
        additionalProperties: false,
      },
      SignedPackageManifest: {
        $comment:
          'Mirrors SignedReceipt (resolution.schema.json). The digest is carried beside the document so a verifier checks the signature against a stated digest and then the digest against the bytes, rather than trusting one derivation.',
        type: 'object',
        required: ['manifest', 'manifestDigest', 'signatures'],
        properties: {
          manifest: {
            $ref: '#/$defs/PackageManifest',
          },
          manifestDigest: {
            $ref: 'common.schema.json#/$defs/Digest',
          },
          signatures: {
            type: 'array',
            minItems: 1,
            maxItems: 32,
            items: {
              $ref: '#/$defs/ManifestSignature',
            },
          },
        },
        additionalProperties: false,
      },
    },
  },
  'https://openpacker.dev/spec/prex/v1/schemas/prex.schema.json': {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://openpacker.dev/spec/prex/v1/schemas/prex.schema.json',
    title: 'PREX 1.0-draft schema catalog',
    oneOf: [
      {
        $ref: 'common.schema.json#/$defs/DigestProjection',
      },
      {
        $ref: 'operations.schema.json#/$defs/Capabilities',
      },
      {
        $ref: 'operations.schema.json#/$defs/NormalizeRequest',
      },
      {
        $ref: 'operations.schema.json#/$defs/NormalizeResponse',
      },
      {
        $ref: 'operations.schema.json#/$defs/IdentifyRequest',
      },
      {
        $ref: 'operations.schema.json#/$defs/IdentifyResponse',
      },
      {
        $ref: 'operations.schema.json#/$defs/EnumerateRequest',
      },
      {
        $ref: 'operations.schema.json#/$defs/EnumerateResponse',
      },
      {
        $ref: 'operations.schema.json#/$defs/InspectRequest',
      },
      {
        $ref: 'operations.schema.json#/$defs/InspectResponse',
      },
      {
        $ref: 'resolution.schema.json#/$defs/SolveRequest',
      },
      {
        $ref: 'resolution.schema.json#/$defs/SolveResponse',
      },
      {
        $ref: 'operations.schema.json#/$defs/MaterializeRequest',
      },
      {
        $ref: 'operations.schema.json#/$defs/MaterializeResponse',
      },
      {
        $ref: 'operations.schema.json#/$defs/VerifyRequest',
      },
      {
        $ref: 'operations.schema.json#/$defs/VerifyResponse',
      },
      {
        $ref: 'operations.schema.json#/$defs/ExplainRequest',
      },
      {
        $ref: 'operations.schema.json#/$defs/ExplainResponse',
      },
      {
        $ref: 'operations.schema.json#/$defs/Problem',
      },
      {
        $ref: 'resolution.schema.json#/$defs/ResolutionUniverse',
      },
      {
        $ref: 'resolution.schema.json#/$defs/SignedReceipt',
      },
      {
        $ref: 'model.schema.json#/$defs/TreeManifest',
      },
      {
        $ref: 'model.schema.json#/$defs/BuildRecipe',
      },
      {
        $ref: 'model.schema.json#/$defs/SubstituteDescriptor',
      },
      {
        $ref: 'events.schema.json#/$defs/LifecycleEvent',
      },
      {
        $ref: 'events.schema.json#/$defs/OpenPackerCloudEvent',
      },
      {
        $ref: 'lockfile.schema.json',
      },
      {
        $ref: 'environment.schema.json#/$defs/EnvironmentManifest',
      },
      {
        $ref: 'environment.schema.json#/$defs/EnvironmentGeneration',
      },
      {
        $ref: 'environment.schema.json#/$defs/EnvironmentState',
      },
      {
        $ref: 'resolution.schema.json#/$defs/UniverseAmendment',
      },
      {
        $ref: 'resolution.schema.json#/$defs/RuntimeClosure',
      },
    ],
  },
  'https://openpacker.dev/spec/prex/v1/schemas/registry-api.schema.json': {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://openpacker.dev/spec/prex/v1/schemas/registry-api.schema.json',
    title: 'PREX registry HTTP binding',
    $comment:
      "Wire shapes for a registry that serves package manifests. Endpoint and pagination shapes follow the MCP registry's generic contract deliberately: cursor plus updatedSince is a complete mirror protocol, and there is no reason to invent a second one. What differs is that a PREX registry publishes a Registry Definition, so which of these endpoints exist is discoverable rather than described in prose, and that published documents are signed, so a mirror verifies rather than trusts.",
    $defs: {
      Cursor: {
        $comment:
          'Opaque to clients. A registry may encode a key and a watermark; a client that parses one has coupled itself to an implementation.',
        type: 'string',
        minLength: 1,
        maxLength: 4096,
      },
      PageMetadata: {
        type: 'object',
        required: ['count'],
        properties: {
          count: {
            $comment:
              'Entries in this page, not the total. A total would force a registry to count a federated result set it is streaming.',
            type: 'integer',
            minimum: 0,
          },
          nextCursor: {
            $comment:
              'Absent or null means this page was the last one. A client MUST NOT treat an empty page as the end while a cursor is still present.',
            oneOf: [
              {
                $ref: '#/$defs/Cursor',
              },
              {
                type: 'null',
              },
            ],
          },
          unavailable: {
            $comment:
              "Sources that did not answer. Present so a caller can tell 'nothing matched' from 'a source was down' — a mirror that reads an outage as an empty result concludes it has caught up.",
            type: 'array',
            maxItems: 64,
            items: {
              type: 'object',
              required: ['sourceId', 'reason'],
              properties: {
                sourceId: {
                  type: 'string',
                  minLength: 1,
                  maxLength: 128,
                },
                reason: {
                  type: 'string',
                  maxLength: 4096,
                },
              },
              additionalProperties: false,
            },
          },
          searchMode: {
            $comment:
              "Which search ran. A registry quietly falling back to a full scan is indistinguishable from one that is fast until it is not, and `LIKE '%x%'` cannot use an index — the shape behind the MCP registry's 20-25 second reads.",
            enum: ['indexed', 'scan'],
          },
        },
        additionalProperties: false,
      },
      RegistryEntry: {
        $comment:
          "One package version as a registry serves it: the publisher's manifest, plus what the registry itself asserts about it.",
        type: 'object',
        required: ['manifest', 'registryMetadata'],
        properties: {
          manifest: {
            $ref: 'package-manifest.schema.json#/$defs/PackageManifest',
          },
          registryMetadata: {
            $ref: '#/$defs/RegistryMetadata',
          },
          signatures: {
            $comment:
              'Over formatDigest(manifestDigest), as SignedReceipt does it. Present when the registry or the publisher signed; absent is a registry that offers nothing to verify.',
            type: 'array',
            maxItems: 32,
            items: {
              $ref: 'package-manifest.schema.json#/$defs/ManifestSignature',
            },
          },
        },
        additionalProperties: false,
      },
      RegistryMetadata: {
        $comment:
          "What the registry asserts, kept apart from what the publisher wrote. The MCP registry stamps this into _meta under a reserved key; PREX puts it in a named field because mixing registry assertions into a publisher's document is how provenance stops being attributable.",
        type: 'object',
        required: ['registryId', 'status', 'publishedAt', 'isLatest'],
        properties: {
          registryId: {
            $ref: 'registry-definition.schema.json#/$defs/RegistryId',
          },
          sourceId: {
            $comment:
              "Which of the registry's configured sources produced this. Present when the registry is relaying rather than serving something published to it — the difference between what it holds and what it fronts.",
            type: 'string',
            minLength: 1,
            maxLength: 128,
          },
          status: {
            enum: ['active', 'deprecated', 'deleted'],
          },
          publishedAt: {
            type: 'string',
            format: 'date-time',
          },
          updatedAt: {
            type: 'string',
            format: 'date-time',
          },
          isLatest: {
            type: 'boolean',
          },
          manifestDigest: {
            $ref: 'common.schema.json#/$defs/Digest',
          },
          serviceability: {
            $ref: '#/$defs/Serviceability',
          },
        },
        additionalProperties: false,
      },
      PackagePage: {
        type: 'object',
        required: ['packages', 'metadata'],
        properties: {
          packages: {
            type: 'array',
            maxItems: 1000,
            items: {
              $ref: '#/$defs/RegistryEntry',
            },
          },
          metadata: {
            $ref: '#/$defs/PageMetadata',
          },
        },
        additionalProperties: false,
      },
      VersionList: {
        type: 'object',
        required: ['name', 'versions'],
        properties: {
          name: {
            type: 'string',
            minLength: 1,
            maxLength: 512,
          },
          versions: {
            type: 'array',
            maxItems: 10000,
            items: {
              type: 'object',
              required: ['version', 'status', 'isLatest'],
              properties: {
                version: {
                  type: 'string',
                  minLength: 1,
                  maxLength: 255,
                },
                status: {
                  enum: ['active', 'deprecated', 'deleted'],
                },
                isLatest: {
                  type: 'boolean',
                },
                publishedAt: {
                  type: 'string',
                  format: 'date-time',
                },
              },
              additionalProperties: false,
            },
          },
          redirectedFrom: {
            $comment:
              'The name the client actually asked for, when it has moved. Stated rather than silently substituted: a client that gets back a different package than it requested has no way to notice, and a lockfile should record what it resolved.',
            type: 'string',
            minLength: 1,
            maxLength: 512,
          },
          redirects: {
            $comment:
              "The chain that was followed, so a client can fetch and verify each signed redirect rather than take the registry's word that the move happened.",
            type: 'array',
            items: {
              $ref: '#/$defs/PackageRedirect',
            },
            maxItems: 8,
          },
        },
        additionalProperties: false,
      },
      NamespaceProof: {
        $comment:
          'A signature proves a document was not altered; it says nothing about who may use a name. This binds a signing key to a name prefix. The two are independent and neither substitutes for the other.',
        type: 'object',
        required: ['namespace', 'method', 'keyId'],
        properties: {
          namespace: {
            $comment:
              'Reverse-DNS name prefix, e.g. com.example or io.github.someone.',
            type: 'string',
            pattern:
              '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$',
            maxLength: 512,
          },
          method: {
            enum: ['dns-txt', 'https-well-known', 'registry-configured'],
          },
          keyId: {
            type: 'string',
            minLength: 1,
            maxLength: 1024,
          },
          evidence: {
            $comment:
              'What the registry read to satisfy itself: the TXT record, or the URL fetched. Recorded so the decision is auditable after the fact.',
            type: 'string',
            maxLength: 8192,
          },
          verifiedAt: {
            type: 'string',
            format: 'date-time',
          },
        },
        additionalProperties: false,
      },
      StatusUpdate: {
        type: 'object',
        required: ['status'],
        properties: {
          status: {
            enum: ['active', 'deprecated', 'deleted'],
          },
          reason: {
            type: 'string',
            maxLength: 4096,
          },
        },
        additionalProperties: false,
      },
      RegistryPublishRequest: {
        $comment:
          'Named RegistryPublishRequest, not PublishRequest: the extensions schema already has one for pushing an artifact descriptor to OCI, and the two are different operations. The publisher signs; the registry verifies before it stores. A registry that accepts an unsigned manifest is choosing to be the only thing anyone can check.',
        type: 'object',
        required: ['manifest', 'manifestDigest'],
        properties: {
          manifest: {
            $ref: 'package-manifest.schema.json#/$defs/PackageManifest',
          },
          manifestDigest: {
            $ref: 'common.schema.json#/$defs/Digest',
          },
          signatures: {
            type: 'array',
            minItems: 1,
            maxItems: 32,
            items: {
              $ref: 'package-manifest.schema.json#/$defs/ManifestSignature',
            },
          },
          namespaceProof: {
            $ref: '#/$defs/NamespaceProof',
          },
        },
        additionalProperties: false,
      },
      RegistryPublishResponse: {
        type: 'object',
        required: ['entry'],
        properties: {
          entry: {
            $ref: '#/$defs/RegistryEntry',
          },
        },
        additionalProperties: false,
      },
      Serviceability: {
        $comment:
          'Whether what a manifest advertises still answers. Absent means nobody has looked, which is a different claim from having looked and found it fine.',
        type: 'object',
        required: ['state', 'checkedAt', 'method'],
        properties: {
          state: {
            $comment:
              '`gated` is healthy: a service answering 401/402/403 is running and wants credentials the registry does not have. `unchecked` covers timeouts and 5xx, which are evidence about the network between the registry and the origin, not about the package.',
            enum: ['verified', 'gated', 'unreachable', 'unchecked'],
          },
          checkedAt: {
            type: 'string',
            format: 'date-time',
          },
          method: {
            $comment:
              "What was actually done. Reachable is not the same claim as 'these are the right bytes'.",
            enum: ['digest-match', 'head', 'status', 'none'],
          },
          detail: {
            type: 'string',
            maxLength: 4096,
          },
        },
        additionalProperties: false,
      },
      RevocationEntry: {
        type: 'object',
        required: ['keyId', 'revokedAt', 'effective'],
        properties: {
          keyId: {
            type: 'string',
            minLength: 1,
            maxLength: 1024,
          },
          revokedAt: {
            type: 'string',
            format: 'date-time',
          },
          effective: {
            $comment:
              'A routine rotation must not invalidate everything a key ever signed, and a theft must. `from-now` keeps signatures made before revokedAt valid and stops the key publishing; `retroactive` invalidates every signature it ever made. Collapsing the two forces an operator to choose between an unusable registry and an unrevoked compromise.',
            enum: ['from-now', 'retroactive'],
          },
          reason: {
            enum: ['rotated', 'compromised', 'retired', 'unspecified'],
          },
          detail: {
            type: 'string',
            maxLength: 4096,
          },
          replacedBy: {
            $comment: 'The key that took over, when this was a rotation.',
            type: 'string',
            maxLength: 1024,
          },
        },
        additionalProperties: false,
      },
      RevocationList: {
        $comment:
          'Signed, because a revocation a client cannot verify is a rumour — and an attacker who can strip or forge one has undone the signing scheme. `serial` and `expiresAt` exist so a client can tell a stale copy from a current one and refuse to be pinned to an old list by a mirror that stopped updating.',
        type: 'object',
        required: [
          'revocationListVersion',
          'registryId',
          'serial',
          'issuedAt',
          'revoked',
        ],
        properties: {
          revocationListVersion: {
            const: '1',
          },
          registryId: {
            $ref: 'registry-definition.schema.json#/$defs/RegistryId',
          },
          serial: {
            $comment:
              'Monotonic. A client that has seen a higher serial must refuse a lower one, or a replay pins it to a list from before a compromise.',
            type: 'integer',
            minimum: 0,
          },
          issuedAt: {
            type: 'string',
            format: 'date-time',
          },
          expiresAt: {
            type: 'string',
            format: 'date-time',
          },
          revoked: {
            type: 'array',
            maxItems: 10000,
            items: {
              $ref: '#/$defs/RevocationEntry',
            },
          },
        },
        additionalProperties: false,
      },
      SignedRevocationList: {
        type: 'object',
        required: ['list', 'listDigest', 'signatures'],
        properties: {
          list: {
            $ref: '#/$defs/RevocationList',
          },
          listDigest: {
            $ref: 'common.schema.json#/$defs/Digest',
          },
          signatures: {
            type: 'array',
            minItems: 1,
            maxItems: 32,
            items: {
              $ref: 'package-manifest.schema.json#/$defs/ManifestSignature',
            },
          },
        },
        additionalProperties: false,
      },
      KeyRotation: {
        $comment:
          'A new key attested by its predecessor. Continuity is the point: signatures made before the rotation still verify against the old key, while the old key can no longer publish. Without this a publisher rotating a key must re-sign every version they ever published, which is what makes people not rotate.',
        type: 'object',
        required: [
          'previousKeyId',
          'nextKeyId',
          'nextPublicKey',
          'rotatedAt',
          'signature',
        ],
        properties: {
          previousKeyId: {
            type: 'string',
            minLength: 1,
            maxLength: 1024,
          },
          nextKeyId: {
            type: 'string',
            minLength: 1,
            maxLength: 1024,
          },
          nextPublicKey: {
            $comment: 'Ed25519 public JWK for the incoming key.',
            type: 'object',
            required: ['kty', 'crv', 'x'],
            properties: {
              kty: {
                const: 'OKP',
              },
              crv: {
                const: 'Ed25519',
              },
              x: {
                type: 'string',
                minLength: 1,
                maxLength: 1024,
              },
            },
            additionalProperties: true,
          },
          rotatedAt: {
            type: 'string',
            format: 'date-time',
          },
          signature: {
            $comment:
              'By the previous key, over the canonical digest of this document with the signature field absent.',
            type: 'string',
            contentEncoding: 'base64',
            maxLength: 256,
          },
        },
        additionalProperties: false,
      },
      HolderId: {
        $comment:
          'Who holds a namespace, not merely which key signed for it. A survey of the MCP registry found one domain behind 75 namespaces, 62 of them serving a marketing page — visible only to somebody who went and looked. Recording the holder at proof time makes that a query instead of a research project, and it is what a quota can be charged against: 75 namespaces under one domain are one publisher and must share one budget.',
        type: 'string',
        pattern: '^(dns|github|operator):[A-Za-z0-9][A-Za-z0-9._/-]*$',
        maxLength: 512,
      },
      NamespaceHolder: {
        type: 'object',
        required: ['holderId', 'namespaces'],
        properties: {
          holderId: {
            $ref: '#/$defs/HolderId',
          },
          namespaces: {
            type: 'array',
            items: {
              type: 'object',
              required: ['namespace', 'method'],
              properties: {
                namespace: {
                  $comment:
                    'Reverse-DNS name prefix, e.g. com.example or io.github.someone.',
                  type: 'string',
                  pattern:
                    '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$',
                  maxLength: 512,
                },
                method: {
                  enum: ['dns-txt', 'https-well-known', 'registry-configured'],
                },
                keyIds: {
                  type: 'array',
                  items: {
                    type: 'string',
                    minLength: 1,
                    maxLength: 1024,
                  },
                },
                verifiedAt: {
                  type: 'string',
                  format: 'date-time',
                },
                packageCount: {
                  type: 'integer',
                  minimum: 0,
                },
              },
              additionalProperties: false,
            },
            maxItems: 4096,
          },
          firstSeen: {
            type: 'string',
            format: 'date-time',
          },
          quota: {
            $ref: '#/$defs/PublishQuota',
          },
        },
        additionalProperties: false,
      },
      PublishQuota: {
        $comment:
          'Charged per holder, never per namespace. A limit per namespace is not a limit: registering another namespace is exactly the cheap move the holder identity exists to make visible.',
        type: 'object',
        required: ['limit', 'windowSeconds', 'remaining'],
        properties: {
          limit: {
            type: 'integer',
            minimum: 0,
          },
          windowSeconds: {
            type: 'integer',
            minimum: 1,
          },
          remaining: {
            type: 'integer',
            minimum: 0,
          },
          resetAt: {
            type: 'string',
            format: 'date-time',
          },
        },
        additionalProperties: false,
      },
      PackageRedirect: {
        $comment:
          'A name that moved. A publisher migrating from io.github.someone to com.their-company should not have to ask a maintainer, and the packages that pinned the old name should not stop resolving. Kept as a document rather than an HTTP 308 so a mirror can verify the move actually came from the party that held both names.',
        type: 'object',
        required: ['redirectVersion', 'from', 'to', 'effectiveAt', 'reason'],
        properties: {
          redirectVersion: {
            const: '1',
          },
          from: {
            type: 'string',
            minLength: 1,
            maxLength: 512,
          },
          to: {
            type: 'string',
            minLength: 1,
            maxLength: 512,
          },
          effectiveAt: {
            type: 'string',
            format: 'date-time',
          },
          reason: {
            $comment:
              "A rename keeps the same holder; a transfer changes it. Both need the outgoing holder's signature, and recording which happened is the difference between 'we moved' and 'we handed it over'.",
            enum: ['rename', 'transfer'],
          },
          previousHolder: {
            $ref: '#/$defs/HolderId',
          },
          nextHolder: {
            $ref: '#/$defs/HolderId',
          },
        },
        additionalProperties: false,
      },
      SignedPackageRedirect: {
        type: 'object',
        required: ['redirect', 'redirectDigest', 'signatures'],
        properties: {
          redirect: {
            $ref: '#/$defs/PackageRedirect',
          },
          redirectDigest: {
            $ref: 'common.schema.json#/$defs/Digest',
          },
          signatures: {
            $comment:
              "The publisher signature must come from a key holding BOTH names. One name is not enough: a key that holds only the destination could otherwise claim any package it liked, and a key that holds only the source could redirect its users to somebody else's package.",
            type: 'array',
            minItems: 1,
            items: {
              $ref: 'package-manifest.schema.json#/$defs/ManifestSignature',
            },
            maxItems: 16,
          },
        },
        additionalProperties: false,
      },
    },
  },
  'https://openpacker.dev/spec/prex/v1/schemas/registry-definition.schema.json':
    {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: 'https://openpacker.dev/spec/prex/v1/schemas/registry-definition.schema.json',
      title:
        'PREX registry definition (capability-discoverable package source)',
      $comment:
        'A Registry Definition is the portable service index for a package source. Inspired by NuGet v3 service index resource discovery; applicable to HTTP registries and local/CLI backends via non-HTTP @id schemes.',
      $defs: {
        RegistryDefinitionVersion: {
          const: '1',
        },
        RegistryId: {
          type: 'string',
          minLength: 3,
          maxLength: 512,
          pattern: '^(urn:|https://|prex-registry:)[A-Za-z0-9._:/-]+$',
        },
        PurlType: {
          type: 'string',
          pattern: '^[a-z][a-z0-9+.-]{0,63}$',
          maxLength: 64,
        },
        ResourceTypeName: {
          $comment:
            'NuGet-style Name/Version resource types. Major versions are incompatible; clients feature-detect by type string.',
          type: 'string',
          pattern: '^prex\\.registry\\.[a-z][a-z0-9-]*\\/[1-9][0-9]*$',
          maxLength: 128,
        },
        ResourceId: {
          $comment:
            'Locator for a resource: HTTPS URL, or a non-HTTP scheme for CLI/local backends (nix+flake://, exec:, file:, git+, oci+).',
          type: 'string',
          minLength: 1,
          maxLength: 8192,
        },
        Transport: {
          type: 'string',
          enum: ['https', 'http', 'file', 'exec', 'git', 'oci', 'nix', 'other'],
        },
        InstallSideEffects: {
          type: 'string',
          enum: ['none', 'project-store', 'user-profile', 'system', 'unknown'],
        },
        Reversibility: {
          type: 'string',
          enum: [
            'none',
            'uninstall',
            'project-generation',
            'native-generation',
            'unknown',
          ],
        },
        RegistryResource: {
          type: 'object',
          required: ['@id', '@type'],
          properties: {
            '@id': {
              $ref: '#/$defs/ResourceId',
            },
            '@type': {
              oneOf: [
                {
                  $ref: '#/$defs/ResourceTypeName',
                },
                {
                  type: 'array',
                  minItems: 1,
                  maxItems: 16,
                  uniqueItems: true,
                  items: {
                    $ref: '#/$defs/ResourceTypeName',
                  },
                },
              ],
            },
            comment: {
              type: 'string',
              maxLength: 1024,
            },
            mediaTypes: {
              type: 'array',
              maxItems: 32,
              uniqueItems: true,
              items: {
                type: 'string',
                maxLength: 255,
              },
            },
            clientVersion: {
              $comment:
                'Optional native protocol version this resource speaks (e.g. RegistrationsBaseUrl/3.6.0).',
              type: 'string',
              maxLength: 128,
            },
            extensions: {
              $ref: 'common.schema.json#/$defs/Extensions',
            },
          },
          additionalProperties: false,
        },
        RegistryFeatures: {
          type: 'object',
          properties: {
            offlineReplay: {
              type: 'boolean',
            },
            signedMetadata: {
              type: 'boolean',
            },
            installSideEffects: {
              $ref: '#/$defs/InstallSideEffects',
            },
            reversibility: {
              $ref: '#/$defs/Reversibility',
            },
            requiresElevation: {
              type: 'string',
              enum: ['never', 'sometimes', 'always', 'unknown'],
            },
          },
          additionalProperties: false,
        },
        RegistryLimits: {
          type: 'object',
          properties: {
            maxEnumerate: {
              type: 'integer',
              minimum: 1,
              maximum: 9007199254740991,
            },
            maxSearchResults: {
              type: 'integer',
              minimum: 1,
              maximum: 9007199254740991,
            },
            maxArtifactBytes: {
              type: 'integer',
              minimum: 1,
              maximum: 9007199254740991,
            },
          },
          additionalProperties: false,
        },
        RegistryProtocol: {
          type: 'object',
          properties: {
            native: {
              type: 'string',
              maxLength: 128,
              pattern: '^[a-z][a-z0-9+.-]*$',
            },
            transport: {
              type: 'array',
              minItems: 1,
              maxItems: 16,
              uniqueItems: true,
              items: {
                $ref: '#/$defs/Transport',
              },
            },
          },
          additionalProperties: false,
        },
        RegistryDefinition: {
          type: 'object',
          required: [
            'registryDefinitionVersion',
            'registryId',
            'purlTypes',
            'resources',
          ],
          properties: {
            registryDefinitionVersion: {
              $ref: '#/$defs/RegistryDefinitionVersion',
            },
            registryId: {
              $ref: '#/$defs/RegistryId',
            },
            displayName: {
              type: 'string',
              maxLength: 256,
            },
            purlTypes: {
              type: 'array',
              minItems: 1,
              maxItems: 64,
              uniqueItems: true,
              items: {
                $ref: '#/$defs/PurlType',
              },
            },
            protocol: {
              $ref: '#/$defs/RegistryProtocol',
            },
            resources: {
              type: 'array',
              minItems: 1,
              maxItems: 256,
              items: {
                $ref: '#/$defs/RegistryResource',
              },
            },
            features: {
              $ref: '#/$defs/RegistryFeatures',
            },
            limits: {
              $ref: '#/$defs/RegistryLimits',
            },
            semanticLossDefaults: {
              type: 'array',
              maxItems: 128,
              items: {
                $ref: 'common.schema.json#/$defs/SemanticLoss',
              },
            },
            extensions: {
              $ref: 'common.schema.json#/$defs/Extensions',
            },
          },
          additionalProperties: false,
        },
      },
    },
  'https://openpacker.dev/spec/prex/v1/schemas/resolution.schema.json': {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://openpacker.dev/spec/prex/v1/schemas/resolution.schema.json',
    title:
      'PREX resolution universe, solution, proof, explanation, and receipt',
    $defs: {
      OpenPackerOverlay: {
        type: 'object',
        required: [
          'overlayVersion',
          'subject',
          'requirements',
          'capabilities',
          'conflicts',
          'cardinalityConstraints',
          'artifactAnnotations',
          'sourceRefs',
          'authority',
          'evidenceRefs',
          'externalRefs',
        ],
        properties: {
          overlayVersion: {
            const: '1',
          },
          subject: {
            $ref: 'model.schema.json#/$defs/PackageIdentity',
          },
          appliesToMetadataDigest: {
            $ref: 'common.schema.json#/$defs/Digest',
          },
          requirements: {
            type: 'array',
            maxItems: 10000,
            items: {
              $ref: 'model.schema.json#/$defs/Requirement',
            },
          },
          capabilities: {
            type: 'array',
            maxItems: 10000,
            items: {
              $ref: 'model.schema.json#/$defs/Capability',
            },
          },
          conflicts: {
            type: 'array',
            maxItems: 10000,
            items: {
              $ref: 'model.schema.json#/$defs/Conflict',
            },
          },
          cardinalityConstraints: {
            type: 'array',
            maxItems: 10000,
            items: {
              $ref: 'model.schema.json#/$defs/CardinalityConstraint',
            },
          },
          artifactAnnotations: {
            type: 'array',
            maxItems: 1024,
            items: {
              type: 'object',
              required: ['descriptorId', 'annotations'],
              properties: {
                descriptorId: {
                  type: 'string',
                  maxLength: 255,
                },
                annotations: {
                  type: 'object',
                  maxProperties: 64,
                  additionalProperties: {
                    type: 'string',
                    maxLength: 4096,
                  },
                },
              },
              additionalProperties: false,
            },
          },
          sourceRefs: {
            type: 'array',
            maxItems: 128,
            items: {
              $ref: 'common.schema.json#/$defs/SourceRef',
            },
          },
          authority: {
            enum: [
              'publisher',
              'registry',
              'organization',
              'user',
              'test-fixture',
            ],
          },
          evidenceRefs: {
            type: 'array',
            maxItems: 128,
            items: {
              $ref: 'common.schema.json#/$defs/ExternalRef',
            },
          },
          externalRefs: {
            type: 'array',
            maxItems: 128,
            items: {
              $ref: 'common.schema.json#/$defs/ExternalRef',
            },
          },
          extensions: {
            $ref: 'common.schema.json#/$defs/Extensions',
          },
        },
        additionalProperties: false,
      },
      UniverseAmendment: {
        $comment:
          'An authority-gated supersession of interpretation. An amendment never mutates a native fact: the PackageInstance it applies to is preserved verbatim, and every applied operation records NATIVE_FACT_SUPERSEDED semantic loss plus an explanation node.',
        type: 'object',
        required: [
          'amendmentVersion',
          'subject',
          'appliesToMetadataDigest',
          'operations',
          'authority',
          'sourceRefs',
          'evidenceRefs',
        ],
        properties: {
          amendmentVersion: {
            const: '1',
          },
          subject: {
            $ref: 'model.schema.json#/$defs/PackageIdentity',
          },
          appliesToMetadataDigest: {
            $comment:
              'Required: an amendment is bound to the exact native metadata state it was written against.',
            $ref: 'common.schema.json#/$defs/Digest',
          },
          operations: {
            type: 'array',
            minItems: 1,
            maxItems: 1024,
            items: {
              $ref: '#/$defs/AmendmentOperation',
            },
          },
          authority: {
            enum: [
              'publisher',
              'registry',
              'organization',
              'user',
              'test-fixture',
            ],
          },
          justification: {
            type: 'string',
            minLength: 1,
            maxLength: 16384,
          },
          sourceRefs: {
            type: 'array',
            maxItems: 128,
            items: {
              $ref: 'common.schema.json#/$defs/SourceRef',
            },
          },
          evidenceRefs: {
            type: 'array',
            maxItems: 128,
            items: {
              $ref: 'common.schema.json#/$defs/ExternalRef',
            },
          },
          externalRefs: {
            type: 'array',
            maxItems: 128,
            items: {
              $ref: 'common.schema.json#/$defs/ExternalRef',
            },
          },
          extensions: {
            $ref: 'common.schema.json#/$defs/Extensions',
          },
        },
        additionalProperties: false,
      },
      RuntimeClosure: {
        $comment:
          'A runtime reference closure. Edges carry the provenance that produced them, so a declared graph is never mistaken for an observed one.',
        type: 'object',
        required: [
          'closureVersion',
          'rootNodeIds',
          'members',
          'edges',
          'completeness',
        ],
        properties: {
          closureVersion: {
            const: '1',
          },
          rootNodeIds: {
            type: 'array',
            minItems: 1,
            maxItems: 100000,
            uniqueItems: true,
            items: {
              type: 'string',
              pattern: '^sha256:[0-9a-f]{64}$',
            },
          },
          members: {
            type: 'array',
            maxItems: 100000,
            items: {
              $ref: '#/$defs/ClosureMember',
            },
          },
          edges: {
            type: 'array',
            maxItems: 1000000,
            items: {
              $ref: '#/$defs/ClosureEdge',
            },
          },
          completeness: {
            $comment:
              'declared: only metadata edges. scanned: only observed edges. reconciled: both agree, or divergence is loss-recorded.',
            enum: ['declared', 'scanned', 'reconciled'],
          },
          semanticLoss: {
            type: 'array',
            maxItems: 1024,
            items: {
              $ref: 'common.schema.json#/$defs/SemanticLoss',
            },
          },
          extensions: {
            $ref: 'common.schema.json#/$defs/Extensions',
          },
        },
        additionalProperties: false,
      },
      ClosureMember: {
        type: 'object',
        required: ['nodeId', 'artifactDigest'],
        properties: {
          nodeId: {
            type: 'string',
            pattern: '^sha256:[0-9a-f]{64}$',
          },
          exactPurl: {
            type: 'string',
            pattern: '^pkg:[a-z0-9.+-]+/',
            maxLength: 8192,
          },
          artifactDigest: {
            $ref: 'common.schema.json#/$defs/Digest',
          },
          treeDigest: {
            $ref: 'common.schema.json#/$defs/Digest',
          },
          outputName: {
            $ref: 'model.schema.json#/$defs/OutputName',
          },
        },
        additionalProperties: false,
      },
      ClosureEdge: {
        type: 'object',
        required: ['fromNodeId', 'toNodeId', 'provenance'],
        properties: {
          fromNodeId: {
            type: 'string',
            pattern: '^sha256:[0-9a-f]{64}$',
          },
          toNodeId: {
            type: 'string',
            pattern: '^sha256:[0-9a-f]{64}$',
          },
          provenance: {
            enum: ['declared', 'scanned', 'both'],
          },
          evidenceRefs: {
            type: 'array',
            maxItems: 64,
            items: {
              $ref: 'common.schema.json#/$defs/ExternalRef',
            },
          },
        },
        additionalProperties: false,
      },
      AmendmentOperation: {
        oneOf: [
          {
            type: 'object',
            required: ['op', 'requirementId', 'replacement'],
            properties: {
              op: {
                const: 'supersedeRequirement',
              },
              requirementId: {
                type: 'string',
                minLength: 1,
                maxLength: 255,
              },
              replacement: {
                $ref: 'model.schema.json#/$defs/Requirement',
              },
            },
            additionalProperties: false,
          },
          {
            type: 'object',
            required: ['op', 'requirementId', 'justification'],
            properties: {
              op: {
                const: 'retractRequirement',
              },
              requirementId: {
                type: 'string',
                minLength: 1,
                maxLength: 255,
              },
              justification: {
                type: 'string',
                minLength: 1,
                maxLength: 16384,
              },
            },
            additionalProperties: false,
          },
          {
            type: 'object',
            required: ['op', 'match', 'to'],
            properties: {
              op: {
                const: 'redirectPackage',
              },
              match: {
                $ref: 'model.schema.json#/$defs/RequirementExpression',
              },
              to: {
                $ref: 'model.schema.json#/$defs/RequirementExpression',
              },
            },
            additionalProperties: false,
          },
        ],
      },
      ResolutionUniverse: {
        type: 'object',
        required: [
          'universeVersion',
          'packages',
          'overlays',
          'sourceSnapshots',
          'lifecycleRoot',
          'targetVocabularyVersion',
          'canonicalDigest',
        ],
        properties: {
          universeVersion: {
            const: '1',
          },
          packages: {
            type: 'array',
            maxItems: 100000,
            items: {
              $ref: 'model.schema.json#/$defs/PackageInstance',
            },
          },
          overlays: {
            type: 'array',
            maxItems: 10000,
            items: {
              $ref: '#/$defs/OpenPackerOverlay',
            },
          },
          sourceSnapshots: {
            type: 'array',
            maxItems: 10000,
            items: {
              $ref: 'model.schema.json#/$defs/SourceSnapshot',
            },
          },
          recipes: {
            $comment:
              'Captured build plans referenced by artifact producedBy claims. Absent means no realisation facts were captured.',
            type: 'array',
            maxItems: 100000,
            items: {
              $ref: 'model.schema.json#/$defs/BuildRecipe',
            },
          },
          lifecycleRoot: {
            $ref: 'common.schema.json#/$defs/Digest',
          },
          targetVocabularyVersion: {
            type: 'string',
            maxLength: 64,
          },
          canonicalDigest: {
            $comment:
              'universe-v1 projection: omit /canonicalDigest and canonicalize declared set paths before hashing',
            $ref: 'common.schema.json#/$defs/Digest',
          },
          extensions: {
            $ref: 'common.schema.json#/$defs/Extensions',
          },
          amendments: {
            $comment:
              'Authority-gated supersessions. Ignored unless policy.acceptedAmendmentAuthorities admits their authority.',
            type: 'array',
            maxItems: 10000,
            items: {
              $ref: '#/$defs/UniverseAmendment',
            },
          },
        },
        additionalProperties: false,
      },
      PolicyInput: {
        type: 'object',
        required: [
          'allowYanked',
          'allowQuarantined',
          'semanticLossMaximum',
          'requiredEvidence',
        ],
        properties: {
          allowYanked: {
            type: 'boolean',
          },
          allowQuarantined: {
            type: 'boolean',
          },
          semanticLossMaximum: {
            enum: ['info', 'warning', 'error'],
          },
          requiredEvidence: {
            type: 'array',
            maxItems: 128,
            uniqueItems: true,
            items: {
              type: 'string',
              maxLength: 128,
            },
          },
          acceptedOverlayAuthorities: {
            type: 'array',
            maxItems: 5,
            uniqueItems: true,
            items: {
              enum: [
                'publisher',
                'registry',
                'organization',
                'user',
                'test-fixture',
              ],
            },
          },
          allowDeprecated: {
            type: 'boolean',
          },
          allowDelisted: {
            type: 'boolean',
          },
          allowRevoked: {
            type: 'boolean',
          },
          requireFreshTufMetadata: {
            type: 'boolean',
          },
          acceptedSignerIdentityPatterns: {
            type: 'array',
            maxItems: 128,
            uniqueItems: true,
            items: {
              type: 'string',
              minLength: 1,
              maxLength: 1024,
            },
          },
          sigstore: {
            type: 'object',
            properties: {
              required: {
                type: 'boolean',
              },
              issuerPatterns: {
                type: 'array',
                maxItems: 128,
                uniqueItems: true,
                items: {
                  type: 'string',
                  minLength: 1,
                  maxLength: 1024,
                },
              },
              identityPatterns: {
                type: 'array',
                maxItems: 128,
                uniqueItems: true,
                items: {
                  type: 'string',
                  minLength: 1,
                  maxLength: 1024,
                },
              },
              requireTransparencyEvidence: {
                type: 'boolean',
              },
            },
            additionalProperties: false,
          },
          slsa: {
            type: 'object',
            properties: {
              required: {
                type: 'boolean',
              },
              predicateTypes: {
                type: 'array',
                maxItems: 64,
                uniqueItems: true,
                items: {
                  type: 'string',
                  format: 'uri',
                  maxLength: 8192,
                },
              },
              builderIds: {
                type: 'array',
                maxItems: 128,
                uniqueItems: true,
                items: {
                  type: 'string',
                  maxLength: 2048,
                },
              },
              buildTypes: {
                type: 'array',
                maxItems: 128,
                uniqueItems: true,
                items: {
                  type: 'string',
                  maxLength: 2048,
                },
              },
            },
            additionalProperties: false,
          },
          licenses: {
            type: 'object',
            properties: {
              allowed: {
                type: 'array',
                maxItems: 1024,
                uniqueItems: true,
                items: {
                  type: 'string',
                  maxLength: 255,
                },
              },
              denied: {
                type: 'array',
                maxItems: 1024,
                uniqueItems: true,
                items: {
                  type: 'string',
                  maxLength: 255,
                },
              },
              allowUnknown: {
                type: 'boolean',
              },
              allowMissing: {
                type: 'boolean',
              },
            },
            additionalProperties: false,
          },
          allowedProviderIds: {
            type: 'array',
            maxItems: 256,
            uniqueItems: true,
            items: {
              type: 'string',
              maxLength: 255,
            },
          },
          allowedArtifactSourceSchemes: {
            type: 'array',
            maxItems: 64,
            uniqueItems: true,
            items: {
              type: 'string',
              pattern: '^[a-z][a-z0-9+.-]*$',
              maxLength: 64,
            },
          },
          allowedTargets: {
            type: 'array',
            maxItems: 128,
            items: {
              $ref: 'model.schema.json#/$defs/TargetPredicate',
            },
          },
          maximumArtifactSize: {
            type: 'integer',
            minimum: 0,
            maximum: 9007199254740991,
          },
          maximumExpandedMaterializationSize: {
            type: 'integer',
            minimum: 0,
            maximum: 9007199254740991,
          },
          deniedSemanticLossCodes: {
            type: 'array',
            maxItems: 1024,
            uniqueItems: true,
            items: {
              type: 'string',
              pattern: '^[A-Z][A-Z0-9_]{2,127}$',
            },
          },
          requiredSourceSnapshotDigests: {
            type: 'array',
            maxItems: 10000,
            uniqueItems: true,
            items: {
              $ref: 'common.schema.json#/$defs/Digest',
            },
          },
          permitForensicDigestMaterialization: {
            type: 'boolean',
          },
          minimumReleaseAgeMinutes: {
            $comment:
              'pnpm-aligned detection-window quarantine: minutes after publish before a version may be selected.',
            type: 'integer',
            minimum: 0,
            maximum: 5256000,
          },
          minimumReleaseAgeExclude: {
            type: 'array',
            maxItems: 1024,
            uniqueItems: true,
            items: {
              type: 'string',
              minLength: 1,
              maxLength: 2048,
            },
          },
          minimumReleaseAgeStrict: {
            $comment:
              'When true, missing publishedAt under a minimum age policy is policy-denied rather than not-provided.',
            type: 'boolean',
          },
          trustPolicy: {
            $comment:
              'no-downgrade refuses a candidate whose trust tier is lower than a prior selected release.',
            enum: ['none', 'no-downgrade'],
          },
          trustPolicyExclude: {
            type: 'array',
            maxItems: 1024,
            uniqueItems: true,
            items: {
              type: 'string',
              minLength: 1,
              maxLength: 2048,
            },
          },
          blockExoticSources: {
            type: 'object',
            properties: {
              direct: {
                type: 'boolean',
              },
              transitive: {
                type: 'boolean',
              },
            },
            additionalProperties: false,
          },
          allowLifecycleScripts: {
            $comment:
              'Default posture is refuse execution of dependency lifecycle scripts.',
            type: 'boolean',
          },
          allowedLifecycleScriptPackages: {
            type: 'array',
            maxItems: 1024,
            uniqueItems: true,
            items: {
              type: 'string',
              minLength: 1,
              maxLength: 2048,
            },
          },
          expectedRegistryId: {
            $comment:
              'Pin expected Registry Definition registryId (named-registry spirit).',
            type: 'string',
            minLength: 1,
            maxLength: 2048,
          },
          extensions: {
            $ref: 'common.schema.json#/$defs/Extensions',
          },
          acceptedAmendmentAuthorities: {
            $comment:
              'Absent or empty means amendments are ignored with a warning; solutions are then identical to an amendment-free universe.',
            type: 'array',
            maxItems: 5,
            uniqueItems: true,
            items: {
              enum: [
                'publisher',
                'registry',
                'organization',
                'user',
                'test-fixture',
              ],
            },
          },
        },
        additionalProperties: false,
      },
      SemanticsInput: {
        type: 'object',
        required: ['profile', 'nativeCompatibility'],
        properties: {
          profile: {
            enum: [
              'native-capture-v1',
              'native-validated-v1',
              'prex-calculus-subset-v1',
            ],
          },
          nativeCompatibility: {
            type: 'array',
            maxItems: 64,
            uniqueItems: true,
            items: {
              type: 'string',
              maxLength: 64,
            },
          },
          extensions: {
            $ref: 'common.schema.json#/$defs/Extensions',
          },
        },
        additionalProperties: false,
      },
      SolveRequest: {
        type: 'object',
        required: [
          'requirements',
          'target',
          'environment',
          'policy',
          'semantics',
          'objectives',
          'mode',
          'evaluationTime',
        ],
        properties: {
          requirements: {
            type: 'array',
            minItems: 0,
            maxItems: 10000,
            items: {
              $ref: 'model.schema.json#/$defs/Requirement',
            },
          },
          target: {
            $comment:
              'The host platform: where selected packages will run. When platforms is present, platforms.host MUST equal this value.',
            $ref: 'model.schema.json#/$defs/TargetContext',
          },
          platforms: {
            $comment:
              'Build/host/target separation for cross compilation. Absent members default to the host platform, so omitting this field reproduces single-platform behavior exactly.',
            $ref: 'model.schema.json#/$defs/PlatformContexts',
          },
          requirementKindPolicy: {
            $comment:
              'Overrides which requirement kinds resolve against the build platform, and which are inactive. Absent means the default attribution applies: build and tool resolve against the build platform, every other kind against the host.',
            type: 'object',
            properties: {
              buildPlatformKinds: {
                type: 'array',
                maxItems: 16,
                uniqueItems: true,
                items: {
                  $ref: 'model.schema.json#/$defs/RequirementKind',
                },
              },
              inactiveKinds: {
                type: 'array',
                maxItems: 16,
                uniqueItems: true,
                items: {
                  $ref: 'model.schema.json#/$defs/RequirementKind',
                },
              },
            },
            additionalProperties: false,
          },
          environment: {
            type: 'object',
            required: ['installed', 'locked'],
            properties: {
              installed: {
                type: 'array',
                maxItems: 100000,
                items: {
                  type: 'string',
                  maxLength: 255,
                },
              },
              locked: {
                type: 'array',
                maxItems: 100000,
                items: {
                  type: 'string',
                  maxLength: 255,
                },
              },
              generationDigest: {
                $comment:
                  'Binds installed/locked to a specific environment generation record.',
                $ref: 'common.schema.json#/$defs/Digest',
              },
            },
            additionalProperties: false,
          },
          policy: {
            $ref: '#/$defs/PolicyInput',
          },
          semantics: {
            $ref: '#/$defs/SemanticsInput',
          },
          objectives: {
            type: 'array',
            minItems: 1,
            maxItems: 16,
            uniqueItems: true,
            items: {
              enum: [
                'satisfy-hard-constraints',
                'preserve-locks',
                'minimize-changes',
                'minimize-package-count',
                'exclude-lifecycle-denied',
                'prefer-stable',
                'prefer-highest-native-version',
                'canonical-lexical-tie-break',
              ],
            },
          },
          mode: {
            enum: ['closure', 'direct', 'validate-native'],
          },
          evaluationTime: {
            type: 'string',
            format: 'date-time',
          },
          providerPolicy: {
            type: 'object',
            additionalProperties: false,
            properties: {
              providerIds: {
                type: 'array',
                maxItems: 64,
                uniqueItems: true,
                items: {
                  type: 'string',
                  maxLength: 255,
                },
              },
            },
          },
          timeoutMilliseconds: {
            type: 'integer',
            minimum: 1,
            maximum: 300000,
          },
          resourceLimits: {
            $ref: 'operations.schema.json#/$defs/ResourceLimits',
          },
          context: {
            $ref: 'operations.schema.json#/$defs/RequestContext',
          },
          extensions: {
            $ref: 'common.schema.json#/$defs/Extensions',
          },
        },
        additionalProperties: false,
      },
      DependencyEdge: {
        type: 'object',
        required: ['requirementId', 'fromNodeId', 'toNodeId', 'witnessType'],
        properties: {
          requirementId: {
            type: 'string',
            maxLength: 255,
          },
          fromNodeId: {
            type: 'string',
            maxLength: 255,
          },
          toNodeId: {
            type: 'string',
            maxLength: 255,
          },
          witnessType: {
            enum: ['package', 'capability', 'replacement', 'optional'],
          },
          toOutputs: {
            $comment:
              "Outputs of the target node this edge needs. Absent means the target's default output.",
            type: 'array',
            maxItems: 64,
            uniqueItems: true,
            items: {
              $ref: 'model.schema.json#/$defs/OutputName',
            },
          },
        },
        additionalProperties: false,
      },
      ResolutionSolution: {
        type: 'object',
        required: [
          'selectedNodeIds',
          'selectedCapabilityProviders',
          'satisfiedRequirementIds',
          'dependencyEdges',
          'excludedCandidates',
          'objectiveTuple',
          'semanticLoss',
          'sourceSnapshotDigests',
          'solutionDigest',
        ],
        properties: {
          selectedNodeIds: {
            type: 'array',
            maxItems: 100000,
            uniqueItems: true,
            items: {
              type: 'string',
              maxLength: 255,
            },
          },
          selectedCapabilityProviders: {
            type: 'array',
            maxItems: 100000,
            items: {
              type: 'object',
              required: ['capability', 'providerNodeId'],
              properties: {
                capability: {
                  type: 'string',
                  maxLength: 255,
                },
                providerNodeId: {
                  type: 'string',
                  maxLength: 255,
                },
              },
              additionalProperties: false,
            },
          },
          satisfiedRequirementIds: {
            type: 'array',
            maxItems: 100000,
            uniqueItems: true,
            items: {
              type: 'string',
              maxLength: 255,
            },
          },
          dependencyEdges: {
            type: 'array',
            maxItems: 1000000,
            items: {
              $ref: '#/$defs/DependencyEdge',
            },
          },
          excludedCandidates: {
            type: 'array',
            maxItems: 100000,
            items: {
              type: 'object',
              required: ['nodeId', 'reasonRefs'],
              properties: {
                nodeId: {
                  type: 'string',
                  maxLength: 255,
                },
                reasonRefs: {
                  type: 'array',
                  maxItems: 128,
                  items: {
                    type: 'string',
                    maxLength: 255,
                  },
                },
              },
              additionalProperties: false,
            },
          },
          objectiveTuple: {
            type: 'array',
            maxItems: 64,
            items: {
              type: ['string', 'integer', 'boolean'],
            },
          },
          semanticLoss: {
            type: 'array',
            maxItems: 10000,
            items: {
              $ref: 'common.schema.json#/$defs/SemanticLoss',
            },
          },
          sourceSnapshotDigests: {
            type: 'array',
            maxItems: 10000,
            items: {
              $ref: 'common.schema.json#/$defs/Digest',
            },
          },
          solutionDigest: {
            $comment:
              'solution-v1 projection: omit /solutionDigest before hashing',
            $ref: 'common.schema.json#/$defs/Digest',
          },
        },
        additionalProperties: false,
      },
      ResolutionProof: {
        type: 'object',
        required: [
          'proofVersion',
          'universeDigest',
          'requestDigest',
          'selectedAssignments',
          'requirementWitnesses',
          'conflictChecks',
          'cardinalityChecks',
          'targetChecks',
          'objectiveEvidence',
        ],
        properties: {
          proofVersion: {
            const: '1',
          },
          universeDigest: {
            $ref: 'common.schema.json#/$defs/Digest',
          },
          requestDigest: {
            $ref: 'common.schema.json#/$defs/Digest',
          },
          selectedAssignments: {
            type: 'array',
            maxItems: 100000,
            items: {
              type: 'object',
              required: ['nodeId', 'selected', 'nodeDigest'],
              properties: {
                nodeId: {
                  type: 'string',
                  maxLength: 255,
                },
                selected: {
                  type: 'boolean',
                },
                nodeDigest: {
                  $ref: 'common.schema.json#/$defs/Digest',
                },
              },
              additionalProperties: false,
            },
          },
          requirementWitnesses: {
            type: 'array',
            maxItems: 1000000,
            items: {
              type: 'object',
              required: ['requirementId', 'status', 'witnessNodeIds'],
              properties: {
                requirementId: {
                  type: 'string',
                  maxLength: 255,
                },
                status: {
                  enum: ['satisfied', 'optional-omitted', 'inactive'],
                },
                witnessNodeIds: {
                  type: 'array',
                  maxItems: 10000,
                  items: {
                    type: 'string',
                    maxLength: 255,
                  },
                },
              },
              additionalProperties: false,
            },
          },
          conflictChecks: {
            $ref: '#/$defs/ProofChecks',
          },
          cardinalityChecks: {
            $ref: '#/$defs/ProofChecks',
          },
          targetChecks: {
            $ref: '#/$defs/ProofChecks',
          },
          objectiveEvidence: {
            $ref: '#/$defs/ProofChecks',
          },
          appliedAmendmentDigests: {
            $comment:
              'Digests of the amendments that produced the universe this proof is about. Absent for an unamended solve.',
            type: 'array',
            maxItems: 10000,
            uniqueItems: true,
            items: {
              $ref: 'common.schema.json#/$defs/Digest',
            },
          },
        },
        additionalProperties: false,
      },
      ProofChecks: {
        type: 'array',
        maxItems: 1000000,
        items: {
          type: 'object',
          required: ['id', 'valid', 'evidence'],
          properties: {
            id: {
              type: 'string',
              maxLength: 255,
            },
            valid: {
              type: 'boolean',
            },
            evidence: {
              $ref: 'common.schema.json#/$defs/CanonicalJsonValue',
            },
          },
          additionalProperties: false,
        },
      },
      ExplanationGraph: {
        type: 'object',
        required: ['nodes', 'edges', 'roots', 'unsatCore'],
        properties: {
          nodes: {
            type: 'array',
            maxItems: 100000,
            items: {
              type: 'object',
              required: ['id', 'kind', 'label', 'data'],
              properties: {
                id: {
                  type: 'string',
                  maxLength: 255,
                },
                kind: {
                  enum: [
                    'candidate',
                    'requirement',
                    'capability',
                    'conflict',
                    'cardinality',
                    'target',
                    'predicate',
                    'lifecycle',
                    'policy',
                    'objective',
                    'semantic-loss',
                    'proof',
                    'amendment-applied',
                    'amendment-ignored',
                    'requirement-suppressed',
                  ],
                  $comment:
                    'amendment-applied is reserved for compiled amendments; amendment compilation is not implemented, so no current implementation emits it.',
                },
                label: {
                  type: 'string',
                  maxLength: 4096,
                },
                data: {
                  type: 'object',
                  maxProperties: 128,
                  additionalProperties: {
                    $ref: 'common.schema.json#/$defs/CanonicalJsonValue',
                  },
                },
              },
              additionalProperties: false,
            },
          },
          edges: {
            type: 'array',
            maxItems: 1000000,
            items: {
              type: 'object',
              required: ['from', 'to', 'kind'],
              properties: {
                from: {
                  type: 'string',
                  maxLength: 255,
                },
                to: {
                  type: 'string',
                  maxLength: 255,
                },
                kind: {
                  enum: [
                    'requires',
                    'satisfied-by',
                    'rejected-by',
                    'conflicts-with',
                    'conditioned-by',
                    'preferred-over',
                    'derived-from',
                    'checked-by',
                  ],
                },
              },
              additionalProperties: false,
            },
          },
          roots: {
            type: 'array',
            maxItems: 10000,
            items: {
              type: 'string',
              maxLength: 255,
            },
          },
          unsatCore: {
            type: 'array',
            maxItems: 10000,
            items: {
              type: 'string',
              maxLength: 255,
            },
          },
          renderHints: {
            type: 'object',
            maxProperties: 64,
            additionalProperties: {
              type: 'string',
              maxLength: 4096,
            },
          },
        },
        additionalProperties: false,
      },
      ResolutionReceipt: {
        type: 'object',
        required: [
          'receiptVersion',
          'protocolVersion',
          'requestDigest',
          'normalizedRequest',
          'universeDigest',
          'sourceSnapshots',
          'targetDigest',
          'policyDigest',
          'lifecycleRoot',
          'semanticsProfile',
          'objectiveOrdering',
          'solutionDigest',
          'proofDigest',
          'explanationDigest',
          'artifactSetDigest',
          'resolver',
          'evaluationTime',
          'evidenceRefs',
          'externalRefs',
        ],
        properties: {
          receiptVersion: {
            const: '1',
          },
          protocolVersion: {
            const: '1.0-draft',
          },
          requestDigest: {
            $ref: 'common.schema.json#/$defs/Digest',
          },
          normalizedRequest: {
            $ref: '#/$defs/SolveRequest',
          },
          universeDigest: {
            $ref: 'common.schema.json#/$defs/Digest',
          },
          sourceSnapshots: {
            type: 'array',
            maxItems: 10000,
            items: {
              $ref: 'model.schema.json#/$defs/SourceSnapshot',
            },
          },
          targetDigest: {
            $ref: 'common.schema.json#/$defs/Digest',
          },
          policyDigest: {
            $ref: 'common.schema.json#/$defs/Digest',
          },
          lifecycleRoot: {
            $ref: 'common.schema.json#/$defs/Digest',
          },
          semanticsProfile: {
            enum: [
              'native-capture-v1',
              'native-validated-v1',
              'prex-calculus-subset-v1',
            ],
          },
          objectiveOrdering: {
            $ref: '#/$defs/SolveRequest/properties/objectives',
          },
          solutionDigest: {
            $ref: 'common.schema.json#/$defs/Digest',
          },
          proofDigest: {
            $comment:
              'proof-v1 projection: canonicalize the complete ResolutionProof',
            $ref: 'common.schema.json#/$defs/Digest',
          },
          explanationDigest: {
            $comment:
              'explanation-v1 projection: canonicalize the complete ExplanationGraph',
            $ref: 'common.schema.json#/$defs/Digest',
          },
          artifactSetDigest: {
            $comment:
              'artifact-set-v1 projection excludes ArtifactDescriptor.locations',
            $ref: 'common.schema.json#/$defs/Digest',
          },
          resolver: {
            type: 'object',
            required: [
              'providerId',
              'implementation',
              'version',
              'buildDigest',
            ],
            properties: {
              providerId: {
                type: 'string',
                maxLength: 255,
              },
              implementation: {
                type: 'string',
                maxLength: 255,
              },
              version: {
                type: 'string',
                maxLength: 128,
              },
              buildDigest: {
                $ref: 'common.schema.json#/$defs/Digest',
              },
            },
            additionalProperties: false,
          },
          evaluationTime: {
            type: 'string',
            format: 'date-time',
          },
          evidenceRefs: {
            type: 'array',
            maxItems: 1024,
            items: {
              $ref: 'common.schema.json#/$defs/ExternalRef',
            },
          },
          externalRefs: {
            type: 'array',
            maxItems: 1024,
            items: {
              $ref: 'common.schema.json#/$defs/ExternalRef',
            },
          },
          extensions: {
            $ref: 'common.schema.json#/$defs/Extensions',
          },
          amendmentDigests: {
            $comment:
              'Digests of amendments actually applied to produce this result.',
            type: 'array',
            maxItems: 10000,
            uniqueItems: true,
            items: {
              $ref: 'common.schema.json#/$defs/Digest',
            },
          },
        },
        additionalProperties: false,
      },
      SignedReceipt: {
        type: 'object',
        required: ['receipt', 'receiptDigest', 'signatures'],
        properties: {
          receipt: {
            $ref: '#/$defs/ResolutionReceipt',
          },
          receiptDigest: {
            $ref: 'common.schema.json#/$defs/Digest',
          },
          signatures: {
            type: 'array',
            minItems: 1,
            maxItems: 32,
            items: {
              type: 'object',
              required: ['algorithm', 'keyId', 'signature'],
              properties: {
                algorithm: {
                  const: 'ed25519',
                },
                keyId: {
                  type: 'string',
                  maxLength: 1024,
                },
                signature: {
                  type: 'string',
                  contentEncoding: 'base64',
                  maxLength: 256,
                },
                identity: {
                  $ref: 'common.schema.json#/$defs/IdentityRef',
                },
              },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
      SolveResponse: {
        type: 'object',
        required: [
          'meta',
          'normalizedRequest',
          'requestDigest',
          'universeDigest',
          'selected',
          'solution',
          'proof',
          'explanation',
          'unsignedReceipt',
        ],
        properties: {
          meta: {
            $ref: 'common.schema.json#/$defs/ProtocolMeta',
          },
          normalizedRequest: {
            $ref: '#/$defs/SolveRequest',
          },
          requestDigest: {
            $ref: 'common.schema.json#/$defs/Digest',
          },
          universeDigest: {
            $ref: 'common.schema.json#/$defs/Digest',
          },
          selected: {
            type: 'array',
            maxItems: 100000,
            items: {
              $ref: 'model.schema.json#/$defs/PackageInstance',
            },
          },
          solution: {
            $ref: '#/$defs/ResolutionSolution',
          },
          proof: {
            $ref: '#/$defs/ResolutionProof',
          },
          explanation: {
            $ref: '#/$defs/ExplanationGraph',
          },
          unsignedReceipt: {
            $ref: '#/$defs/ResolutionReceipt',
          },
          signedReceipt: {
            $ref: '#/$defs/SignedReceipt',
          },
        },
        additionalProperties: false,
      },
    },
  },
};
