import type {
  CatalogProvider,
  Clock,
  CredentialResolver,
  EcosystemCodec,
} from '@openpacker/adapter-core';
import {
  collectStream,
  streamFromBytes,
  type ArtifactSink,
  type ArtifactSource,
} from '@openpacker/artifact-model';
import { canonicalBytes, canonicalize } from '@openpacker/canonical';
import type {
  ArtifactDescriptor,
  EvidenceResult,
  EvidenceStatus,
  JsonValue,
} from '@openpacker/contracts';
import type { EventSink, OpenPackerCloudEvent } from '@openpacker/events';
import { canonicalEventBytes } from '@openpacker/events';
import type { Signer as ReceiptSigner, Verifier } from '@openpacker/trust';

export type {
  ArtifactSink,
  ArtifactSource,
  CatalogProvider,
  Clock,
  CredentialResolver,
  EcosystemCodec,
  EventSink,
  ReceiptSigner,
};

export interface ExtensionDiagnostic {
  level: 'info' | 'warning' | 'error';
  code: string;
  message: string;
}

export interface ExtensionDescriptor {
  id: string;
  version: string;
  capabilities: readonly string[];
  configurationSchema: JsonValue;
  supportedProtocolVersions: readonly string[];
  determinism: 'deterministic' | 'input-deterministic' | 'nondeterministic';
  securityBoundaries: readonly string[];
  diagnostics: readonly ExtensionDiagnostic[];
}

export interface OpenPackerExtension<T> {
  descriptor: ExtensionDescriptor;
  implementation: T;
}

export type CatalogProviderExtension = OpenPackerExtension<CatalogProvider>;
export type EcosystemCodecExtension = OpenPackerExtension<EcosystemCodec>;
export type ArtifactSourceExtension = OpenPackerExtension<ArtifactSource>;
export type ArtifactSinkExtension = OpenPackerExtension<ArtifactSink>;
export type ReceiptSignerExtension = OpenPackerExtension<ReceiptSigner>;
export type EventSinkExtension = OpenPackerExtension<EventSink>;
export type ClockExtension = OpenPackerExtension<Clock>;
export type CredentialResolverExtension =
  OpenPackerExtension<CredentialResolver>;

export interface EvidenceVerifier {
  verify(
    input: { subject: JsonValue; evidence: JsonValue; evaluationTime: string },
    signal?: AbortSignal,
  ): Promise<EvidenceResult>;
}
export type EvidenceVerifierExtension = OpenPackerExtension<EvidenceVerifier>;

export interface PolicyRuleResult {
  status: EvidenceStatus;
  code: string;
  message: string;
}
export interface PolicyRule {
  evaluate(input: JsonValue, signal?: AbortSignal): Promise<PolicyRuleResult>;
}
export type PolicyRuleExtension = OpenPackerExtension<PolicyRule>;

export interface ConformanceCheck {
  name: string;
  passed: boolean;
  detail?: string;
}
export interface ConformanceReport {
  extensionId: string;
  checks: readonly ConformanceCheck[];
}

export function checkExtensionDescriptor(
  descriptor: ExtensionDescriptor,
): ConformanceReport {
  const checks: ConformanceCheck[] = [
    check(
      'id',
      /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/u.test(descriptor.id),
      'Use a reverse-domain extension ID',
    ),
    check(
      'version',
      /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:[-+][0-9A-Za-z.-]+)?$/u.test(
        descriptor.version,
      ),
      'Use SemVer',
    ),
    check(
      'capabilities',
      descriptor.capabilities.length > 0 && unique(descriptor.capabilities),
      'Advertise a non-empty unique capability set',
    ),
    check(
      'protocol',
      descriptor.supportedProtocolVersions.includes('1.0-draft'),
      'PREX 1.0-draft support is required',
    ),
    check(
      'configuration-schema',
      isObject(descriptor.configurationSchema),
      'Configuration schema must be a JSON object',
    ),
    check(
      'security-boundaries',
      descriptor.securityBoundaries.length > 0,
      'Declare at least one security boundary',
    ),
    check(
      'diagnostics',
      descriptor.diagnostics.every(
        (item) => item.code.length > 0 && item.message.length > 0,
      ),
      'Diagnostics require codes and messages',
    ),
  ];
  return { extensionId: descriptor.id, checks };
}

export function assertConforms(report: ConformanceReport): void {
  const failures = report.checks.filter((item) => !item.passed);
  if (failures.length)
    throw new TypeError(
      `${report.extensionId} extension conformance failed: ${failures.map((item) => `${item.name}: ${item.detail ?? 'failed'}`).join('; ')}`,
    );
}

export async function checkEventSink(
  extension: EventSinkExtension,
  event: OpenPackerCloudEvent,
): Promise<ConformanceReport> {
  const base = checkRequiredMethods(
    checkExtensionDescriptor(extension.descriptor),
    extension.implementation,
    ['publish'],
  );
  if (hasFailures(base)) return base;
  const bytes = canonicalEventBytes(event);
  const first = await extension.implementation.publish({
    event,
    canonicalBytes: bytes,
  });
  const replay = await extension.implementation.publish({
    event,
    canonicalBytes: bytes,
  });
  return append(
    base,
    check(
      'event-id',
      first.eventId === event.id && replay.eventId === event.id,
      'Sink must preserve event IDs',
    ),
    check(
      'checkpoint',
      first.checkpoint.length > 0 && replay.checkpoint === first.checkpoint,
      'Duplicate delivery must return the original replay checkpoint',
    ),
    check(
      'deduplication',
      first.duplicate === false && replay.duplicate === true,
      'Sink must report first delivery and duplicate replay distinctly',
    ),
  );
}

export async function checkArtifactSource(
  extension: ArtifactSourceExtension,
  descriptor: ArtifactDescriptor,
  expected: Uint8Array,
): Promise<ConformanceReport> {
  const base = checkRequiredMethods(
    checkExtensionDescriptor(extension.descriptor),
    extension.implementation,
    ['stat', 'open', 'listReferrers'],
  );
  if (hasFailures(base)) return base;
  const stat = await extension.implementation.stat(descriptor);
  const bytes = await collectStream(
    await extension.implementation.open(descriptor),
    expected.byteLength,
  );
  const referrers = await extension.implementation.listReferrers(descriptor);
  return append(
    base,
    check(
      'descriptor',
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      canonicalize(JSON.parse(JSON.stringify(stat.descriptor)) as JsonValue) ===
        // SAFETY: The surrounding boundary establishes the asserted domain contract.
        canonicalize(JSON.parse(JSON.stringify(descriptor)) as JsonValue),
      'stat must preserve the descriptor',
    ),
    check(
      'bytes',
      equalBytes(bytes, expected),
      'open returned different bytes',
    ),
    check(
      'referrers',
      Array.isArray(referrers),
      'listReferrers must return an array',
    ),
  );
}

export async function checkArtifactSink(
  extension: ArtifactSinkExtension,
  descriptor: ArtifactDescriptor,
  bytes: Uint8Array,
): Promise<ConformanceReport> {
  const base = checkRequiredMethods(
    checkExtensionDescriptor(extension.descriptor),
    extension.implementation,
    ['putBlob', 'putManifest', 'attachReferrer'],
  );
  if (hasFailures(base)) return base;
  const stored = await extension.implementation.putBlob(
    streamFromBytes(bytes),
    descriptor,
  );
  // SAFETY: The surrounding boundary establishes the asserted domain contract.
  const manifestBytes = canonicalBytes(
    JSON.parse(JSON.stringify(descriptor)) as JsonValue,
  );
  const manifest = await extension.implementation.putManifest(
    manifestBytes,
    descriptor,
  );
  await extension.implementation.attachReferrer(descriptor, manifest);
  return append(
    base,
    check(
      'descriptor',
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      canonicalize(JSON.parse(JSON.stringify(stored)) as JsonValue) ===
        // SAFETY: The surrounding boundary establishes the asserted domain contract.
        canonicalize(JSON.parse(JSON.stringify(descriptor)) as JsonValue),
      'putBlob must preserve the expected immutable descriptor',
    ),
    check(
      'manifest-descriptor',
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      canonicalize(JSON.parse(JSON.stringify(manifest)) as JsonValue) ===
        // SAFETY: The surrounding boundary establishes the asserted domain contract.
        canonicalize(JSON.parse(JSON.stringify(descriptor)) as JsonValue),
      'putManifest must preserve its immutable descriptor',
    ),
  );
}

export async function checkCatalogProvider(
  extension: CatalogProviderExtension,
  basePurl: string,
  evaluationTime: string,
): Promise<ConformanceReport> {
  const base = checkRequiredMethods(
    checkExtensionDescriptor(extension.descriptor),
    extension.implementation,
    ['identify', 'enumerate', 'inspect', 'fetchArtifactRecord', 'snapshot'],
  );
  if (hasFailures(base)) return base;
  const identities = await extension.implementation.identify(basePurl);
  const first = await extension.implementation.enumerate(basePurl);
  const second = await extension.implementation.enumerate(basePurl);
  const exactPurl = first[0];
  const inspection = exactPurl
    ? await extension.implementation.inspect(exactPurl)
    : undefined;
  const artifact = exactPurl
    ? await extension.implementation.fetchArtifactRecord(exactPurl)
    : undefined;
  const snapshot = await extension.implementation.snapshot(evaluationTime);
  return append(
    base,
    check(
      'provider-id',
      extension.implementation.providerId.length > 0,
      'Provider ID is required',
    ),
    check(
      'deterministic-enumeration',
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      canonicalize([...first] as JsonValue) ===
        // SAFETY: The surrounding boundary establishes the asserted domain contract.
        canonicalize([...second] as JsonValue),
      'Offline enumeration must be deterministic',
    ),
    check('identity', identities.length > 0, 'identify returned no candidates'),
    check(
      'inspection',
      inspection !== undefined && inspection.record.rawBody.byteLength > 0,
      'inspect did not return a metadata record',
    ),
    check(
      'artifact-record',
      artifact !== undefined && artifact.rawBody.byteLength > 0,
      'fetchArtifactRecord did not return artifact metadata',
    ),
    check(
      'snapshot',
      snapshot.providerId === extension.implementation.providerId,
      'Snapshot provider ID mismatch',
    ),
  );
}

export function checkEcosystemCodec(
  extension: EcosystemCodecExtension,
  purl: string,
  leftVersion: string,
  rightVersion: string,
): ConformanceReport {
  const base = checkRequiredMethods(
    checkExtensionDescriptor(extension.descriptor),
    extension.implementation,
    [
      'parseNativeCoordinate',
      'canonicalizePurl',
      'parseNativeVersion',
      'compareNativeVersions',
      'parseNativeRange',
      'toVers',
      'satisfies',
      'translateMetadata',
      'translateLockResult',
    ],
  );
  if (hasFailures(base)) return base;
  const codec = extension.implementation;
  const canonical = codec.canonicalizePurl(purl);
  codec.parseNativeVersion(leftVersion);
  codec.parseNativeVersion(rightVersion);
  const forward = Math.sign(
    codec.compareNativeVersions(leftVersion, rightVersion),
  );
  const reverse = Math.sign(
    codec.compareNativeVersions(rightVersion, leftVersion),
  );
  return append(
    base,
    check(
      'canonical-idempotence',
      codec.canonicalizePurl(canonical) === canonical,
      'PURL canonicalization must be idempotent',
    ),
    check(
      'version-reflexivity',
      codec.compareNativeVersions(leftVersion, leftVersion) === 0,
      'Version comparison must be reflexive',
    ),
    check(
      'version-antisymmetry',
      forward === -reverse,
      'Version comparison must be antisymmetric',
    ),
  );
}

export async function checkReceiptSigner(
  extension: ReceiptSignerExtension,
  verifier: Verifier,
  message = new TextEncoder().encode('openpacker-extension-conformance'),
): Promise<ConformanceReport> {
  const base = checkRequiredMethods(
    checkExtensionDescriptor(extension.descriptor),
    extension.implementation,
    ['sign'],
  );
  if (hasFailures(base)) return base;
  const signature = await extension.implementation.sign(message);
  return append(
    base,
    check(
      'algorithm',
      extension.implementation.algorithm === verifier.algorithm,
      'Signer and verifier algorithms differ',
    ),
    check(
      'key-id',
      extension.implementation.keyId === verifier.keyId,
      'Signer and verifier key IDs differ',
    ),
    check(
      'signature',
      await verifier.verify(message, signature),
      'Verifier rejected the signature',
    ),
  );
}

export async function checkPolicyRule(
  extension: PolicyRuleExtension,
  input: JsonValue,
): Promise<ConformanceReport> {
  const base = checkRequiredMethods(
    checkExtensionDescriptor(extension.descriptor),
    extension.implementation,
    ['evaluate'],
  );
  if (hasFailures(base)) return base;
  const first = await extension.implementation.evaluate(input);
  const second = await extension.implementation.evaluate(input);
  return append(
    base,
    check(
      'deterministic-result',
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      canonicalize(JSON.parse(JSON.stringify(first)) as JsonValue) ===
        // SAFETY: The surrounding boundary establishes the asserted domain contract.
        canonicalize(JSON.parse(JSON.stringify(second)) as JsonValue),
      'Policy rule changed for identical input',
    ),
    check(
      'policy-result',
      EVIDENCE_STATUSES.has(first.status) &&
        first.code.length > 0 &&
        first.message.length > 0,
      'Policy rule returned an invalid result',
    ),
  );
}

const EVIDENCE_STATUSES = new Set<EvidenceStatus>([
  'valid',
  'invalid',
  'not-provided',
  'unknown',
  'not-applicable',
  'policy-denied',
]);

export async function checkEvidenceVerifier(
  extension: EvidenceVerifierExtension,
  input: { subject: JsonValue; evidence: JsonValue; evaluationTime: string },
): Promise<ConformanceReport> {
  const base = checkRequiredMethods(
    checkExtensionDescriptor(extension.descriptor),
    extension.implementation,
    ['verify'],
  );
  if (hasFailures(base)) return base;
  const first = await extension.implementation.verify(input);
  const second = await extension.implementation.verify(input);
  return append(
    base,
    check(
      'deterministic-result',
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      canonicalize(JSON.parse(JSON.stringify(first)) as JsonValue) ===
        // SAFETY: The surrounding boundary establishes the asserted domain contract.
        canonicalize(JSON.parse(JSON.stringify(second)) as JsonValue),
      'Evidence verifier changed for identical input',
    ),
    check(
      'evidence-result',
      EVIDENCE_STATUSES.has(first.status) &&
        first.evaluationTime === input.evaluationTime &&
        first.type.length > 0,
      'Evidence verifier returned an invalid result',
    ),
  );
}

export async function checkClock(
  extension: ClockExtension,
): Promise<ConformanceReport> {
  const base = checkRequiredMethods(
    checkExtensionDescriptor(extension.descriptor),
    extension.implementation,
    ['now'],
  );
  if (hasFailures(base)) return base;
  return append(
    base,
    check(
      'timestamp',
      Number.isFinite(Date.parse(extension.implementation.now())),
      'Clock must return RFC 3339-compatible time',
    ),
  );
}

export async function checkCredentialResolver(
  extension: CredentialResolverExtension,
  secretReference: string,
): Promise<ConformanceReport> {
  const base = checkRequiredMethods(
    checkExtensionDescriptor(extension.descriptor),
    extension.implementation,
    ['resolve'],
  );
  if (hasFailures(base)) return base;
  const credentials = await extension.implementation.resolve(secretReference);
  return append(
    base,
    check(
      'credentials',
      Object.values(credentials).every((value) => typeof value === 'string'),
      'Credential values must be strings',
    ),
  );
}

function check(
  name: string,
  passed: boolean,
  detail: string,
): ConformanceCheck {
  return { name, passed, ...(!passed && { detail }) };
}
function append(
  report: ConformanceReport,
  ...checks: ConformanceCheck[]
): ConformanceReport {
  return { ...report, checks: [...report.checks, ...checks] };
}
function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}
function isObject(value: JsonValue): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength &&
    left.every((byte, index) => byte === right[index])
  );
}

function checkRequiredMethods<T extends object>(
  report: ConformanceReport,
  implementation: T,
  methods: readonly string[],
): ConformanceReport {
  return append(
    report,
    ...methods.map((method) =>
      check(
        `method:${method}`,
        method in implementation &&
          typeof implementation[method as keyof T] === 'function',
        `Extension is missing ${method}()`,
      ),
    ),
  );
}

function hasFailures(report: ConformanceReport): boolean {
  return report.checks.some(({ passed }) => !passed);
}
