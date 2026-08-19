/**
 * Supply-chain fact capture and project policy evaluation.
 *
 * Adapters / registry inspect paths only capture facts. Policy decisions live
 * in @openpacker/policy (evaluatePolicy) and are bound via policyDigest.
 */

import type {
  CatalogProvider,
  ProviderInspection,
} from '@openpacker/adapter-core';
import type {
  Digest,
  LifecycleState,
  PolicyInput,
  SemanticLoss,
} from '@openpacker/contracts';
import {
  evaluatePolicy,
  isSourceKind,
  isTrustTier,
  policyDocumentFromPolicyInput,
  type PolicyDocument,
  type PolicyFacts,
  type PolicyResult,
  type SourceKind,
  type TrustTier,
} from '@openpacker/policy';
import { stripPurlVersion } from './spec.js';
import type { LockPackage, OpmLockfile, OpmManifest } from './types.js';
import { OpmError } from './types.js';

export type {
  PolicyDocument,
  PolicyFacts,
  PolicyResult,
  SourceKind,
  TrustTier,
};

/** Default fail-closed supply-chain posture for new projects (pnpm-aligned). */
export function defaultSupplyChainPolicyInput(): PolicyInput {
  return {
    allowYanked: false,
    allowQuarantined: false,
    semanticLossMaximum: 'warning',
    requiredEvidence: [],
    allowLifecycleScripts: false,
    minimumReleaseAgeMinutes: 1440,
    trustPolicy: 'no-downgrade',
    blockExoticSources: { transitive: true, direct: false },
    sandboxMode: 'fail-closed',
    sandboxRequired: true,
    sandboxPrefer: 'auto',
    allowHostUnsandboxedInstall: false,
  };
}

/** Map committed project policy onto evaluatePolicy document. */
export function projectPolicyDocument(manifest: OpmManifest): PolicyDocument {
  return policyDocumentFromPolicyInput(
    manifest.policy ?? defaultSupplyChainPolicyInput(),
  );
}

/**
 * Prior trust tier for a package from the lockfile (upgrade / no-downgrade).
 * Matches by exact purl first, then by base purl (strip version).
 */
export function priorTrustFromLock(
  lock: OpmLockfile | undefined,
  packageId: string,
): TrustTier | undefined {
  if (!lock) return undefined;
  const direct = lock.packages;
  for (const pkg of Object.values(direct)) {
    if (pkg.purl === packageId && pkg.trustLevel !== undefined)
      return pkg.trustLevel;
  }
  const base = stripPurlVersion(packageId);
  for (const pkg of Object.values(direct)) {
    if (stripPurlVersion(pkg.purl) === base && pkg.trustLevel !== undefined)
      return pkg.trustLevel;
  }
  return undefined;
}

/**
 * Capture supply-chain facts from a catalog provider inspection.
 * Honest absence: fields are omitted when the native metadata does not provide them.
 */
export function captureFactsFromInspection(
  inspection: ProviderInspection,
  options: {
    evaluationTime: string;
    dependencyDepth?: number;
    registryId?: string;
    sourceUri?: string;
    priorTrustLevel?: TrustTier;
    lifecycleScriptsExecuted?: boolean;
  },
): PolicyFacts {
  const exactPurl =
    inspection.package.identity.exactPurl ??
    inspection.package.identity.canonicalPurl;
  const facts: PolicyFacts = {
    evidence: [],
    lifecycle: inspection.package.lifecycle,
    semanticLoss: [...inspection.package.semanticLoss],
    sourceSnapshotDigests: [...inspection.package.sourceSnapshots],
    packageId: exactPurl,
    evaluationTime: options.evaluationTime,
    provider: inspection.package.identity.purlType,
    dependencyDepth: options.dependencyDepth ?? 0,
    lifecycleScriptsExecuted: options.lifecycleScriptsExecuted ?? false,
  };
  if (options.registryId !== undefined) facts.registryId = options.registryId;
  if (options.priorTrustLevel !== undefined)
    facts.priorTrustLevel = options.priorTrustLevel;

  const body = inspection.record.body as Record<string, unknown> | undefined;
  const version =
    inspection.package.nativeVersion ??
    inspection.package.identity.version ??
    parseVersionFromPurl(exactPurl);

  // npm packument: time[version], versions[version].scripts
  if (body && typeof body === 'object') {
    const time = body.time;
    if (
      version &&
      time &&
      typeof time === 'object' &&
      time !== null &&
      !Array.isArray(time)
    ) {
      const stamp = (time as Record<string, unknown>)[version];
      if (typeof stamp === 'string' && stamp.length > 0)
        facts.publishedAt = stamp;
    }

    const versions = body.versions;
    let versionMeta: Record<string, unknown> | undefined;
    if (
      version &&
      versions &&
      typeof versions === 'object' &&
      versions !== null &&
      !Array.isArray(versions)
    ) {
      const entry = (versions as Record<string, unknown>)[version];
      if (entry && typeof entry === 'object' && !Array.isArray(entry))
        versionMeta = entry as Record<string, unknown>;
    }
    // single-version documents (some registries return the version object)
    if (!versionMeta && body.version === version) versionMeta = body;

    if (versionMeta) {
      const scripts = versionMeta.scripts;
      if (scripts && typeof scripts === 'object' && scripts !== null) {
        const names = Object.keys(scripts as object);
        facts.lifecycleScriptsDeclared = names.some((name) =>
          /^(pre|post)?install$|^prepare$|^prepublish/.test(name),
        );
      } else {
        facts.lifecycleScriptsDeclared = false;
      }
      const dist = versionMeta.dist;
      if (dist && typeof dist === 'object' && dist !== null) {
        const tarball = (dist as Record<string, unknown>).tarball;
        if (typeof tarball === 'string') {
          Object.assign(facts, sourceFactsFromUri(tarball));
          // The inspected provider record, not its hostname, establishes
          // registry provenance.
          facts.sourceKind = 'registry';
        }
      }
    }
  }

  // An explicit source overrides whatever the packument's dist pointed at, so
  // it lands before the trust default below — otherwise a git source inherits
  // the "registry tarball ⇒ unsigned" tier it never earned.
  if (options.sourceUri)
    Object.assign(facts, sourceFactsFromUri(options.sourceUri));
  if (facts.sourceKind === undefined && !options.sourceUri)
    facts.sourceKind = 'registry';

  // npm provenance / trusted publisher are not always present; do not invent.
  // Registry HTTPS tarball without signatures → unsigned (honest default for
  // npm). Only claimable when a metadata document was actually read: with no
  // body there is nothing to have inspected, and the tier stays absent so
  // no-downgrade reports not-provided instead of a tier nobody observed.
  if (facts.trustLevel === undefined && body && typeof body === 'object')
    facts.trustLevel = facts.sourceKind === 'registry' ? 'unsigned' : 'unknown';
  if (facts.sourceScheme === undefined && inspection.record.endpoint) {
    try {
      facts.sourceScheme = new URL(inspection.record.endpoint).protocol.replace(
        ':',
        '',
      );
    } catch {
      // leave absent
    }
  }

  return facts;
}

/** Capture facts for an explicit file/git/https source (no registry inspect). */
export function captureFactsFromSourceUri(
  packageId: string,
  sourceUri: string,
  options: {
    evaluationTime: string;
    dependencyDepth?: number;
    priorTrustLevel?: TrustTier;
    lifecycleScriptsExecuted?: boolean;
    lifecycle?: LifecycleState;
    semanticLoss?: readonly SemanticLoss[];
    sourceSnapshotDigests?: readonly Digest[];
    /**
     * Set when the URI came from a registry's own artifact record and its
     * origin was checked against that ecosystem's allowlist. Only the caller
     * knows that; the URI alone cannot prove it.
     */
    fromRegistryArtifactRecord?: boolean;
  },
): PolicyFacts {
  const facts: PolicyFacts = {
    evidence: [],
    packageId,
    evaluationTime: options.evaluationTime,
    dependencyDepth: options.dependencyDepth ?? 0,
    lifecycleScriptsExecuted: options.lifecycleScriptsExecuted ?? false,
    ...(options.lifecycle === undefined
      ? {}
      : { lifecycle: options.lifecycle }),
    ...(options.semanticLoss === undefined
      ? {}
      : { semanticLoss: [...options.semanticLoss] }),
    ...(options.sourceSnapshotDigests === undefined
      ? {}
      : { sourceSnapshotDigests: [...options.sourceSnapshotDigests] }),
    trustLevel: 'unknown',
    ...sourceFactsFromUri(sourceUri),
  };
  if (options.fromRegistryArtifactRecord === true)
    facts.sourceKind = 'registry';
  if (options.priorTrustLevel !== undefined)
    facts.priorTrustLevel = options.priorTrustLevel;
  return facts;
}

/**
 * Classify a source URI.
 *
 * `registry` is the one kind `blockExoticSources` never blocks, so it is not
 * the fallback: a URI that merely parses tells you nothing about whether an
 * authority stands behind it. Anything that is not recognisably a registry
 * artifact is `tarball`, and callers that know an origin-checked registry
 * produced the URI say so explicitly.
 */
function sourceFactsFromUri(uri: string): Partial<PolicyFacts> {
  const lower = uri.toLowerCase();
  const scheme = uriScheme(uri);
  if (
    lower.startsWith('git+') ||
    lower.startsWith('git:') ||
    (lower.includes('github.com/') && !lower.includes('codeload'))
  )
    return {
      sourceKind: 'git',
      ...(scheme === undefined ? {} : { sourceScheme: scheme }),
    };
  if (
    lower.startsWith('file:') ||
    lower.startsWith('/') ||
    lower.startsWith('./') ||
    lower.startsWith('../')
  )
    return { sourceKind: 'path', sourceScheme: 'file' };
  if (lower.startsWith('oci:') || lower.includes('/v2/'))
    return {
      sourceKind: 'oci',
      ...(scheme === undefined ? {} : { sourceScheme: scheme }),
    };
  try {
    const url = new URL(uri);
    const protocol = url.protocol.replace(':', '');
    return { sourceKind: 'tarball', sourceScheme: protocol };
  } catch {
    return { sourceKind: 'exotic' };
  }
}

/** Reconstruct the complete policy surface before materializing a lock item. */
export function policyFactsFromLockPackage(
  pkg: LockPackage,
  evaluationTime: string,
  options: { registryArtifactVerified?: boolean } = {},
): PolicyFacts {
  const source = sourceFactsFromUri(pkg.source);
  return {
    evidence: [],
    packageId: pkg.purl,
    provider: pkg.ecosystem,
    artifactSize: pkg.size,
    evaluationTime,
    dependencyDepth: pkg.reason === 'transitive' ? 1 : 0,
    lifecycleScriptsExecuted: false,
    ...source,
    ...(options.registryArtifactVerified === true &&
    pkg.sourceKind === 'registry'
      ? { sourceKind: 'registry' as const }
      : {}),
    ...(pkg.trustLevel === undefined ? {} : { trustLevel: pkg.trustLevel }),
    ...(pkg.publishedAt === undefined ? {} : { publishedAt: pkg.publishedAt }),
    ...(pkg.registryId === undefined ? {} : { registryId: pkg.registryId }),
    ...(pkg.lifecycle === undefined ? {} : { lifecycle: pkg.lifecycle }),
  };
}

/** Policy gate shared by public lock installation and direct materialization. */
export async function assertLockPackageAllowed(
  pkg: LockPackage,
  policyInput: PolicyInput | undefined,
  evaluationTime: string,
  options: {
    registryArtifactVerified?: boolean;
    verifiedFacts?: PolicyFacts;
  } = {},
): Promise<void> {
  const policy = policyDocumentFromPolicyInput(
    policyInput ?? defaultSupplyChainPolicyInput(),
  );
  await assertSupplyChainAllowed(
    policy,
    options.verifiedFacts === undefined
      ? policyFactsFromLockPackage(pkg, evaluationTime, options)
      : {
          ...options.verifiedFacts,
          packageId: pkg.purl,
          provider: pkg.ecosystem,
          artifactSize: pkg.size,
          evaluationTime,
          dependencyDepth: pkg.reason === 'transitive' ? 1 : 0,
          lifecycleScriptsExecuted: false,
        },
  );
}

function uriScheme(uri: string): string | undefined {
  try {
    return new URL(uri).protocol.replace(':', '');
  } catch {
    return undefined;
  }
}

function parseVersionFromPurl(purl: string): string | undefined {
  const at = purl.lastIndexOf('@');
  const slash = purl.indexOf('/');
  if (at > slash && at !== -1) return decodeURIComponent(purl.slice(at + 1));
  return undefined;
}

/**
 * Evaluate supply-chain policy for one package selection.
 * Throws OpmError with POLICY_DENIED or POLICY_INDETERMINATE when not allow.
 */
export async function assertSupplyChainAllowed(
  policy: PolicyDocument,
  facts: PolicyFacts,
): Promise<PolicyResult> {
  const result = await evaluatePolicy(policy, facts);
  if (result.decision === 'allow') return result;
  const summary = result.checks
    .filter(
      (check) =>
        check.status === 'policy-denied' ||
        check.status === 'invalid' ||
        check.status === 'not-provided',
    )
    .map((check) => `${check.code}: ${check.message}`)
    .join('; ');
  throw new OpmError(
    result.decision === 'deny' ? 'POLICY_DENIED' : 'POLICY_INDETERMINATE',
    `Supply-chain policy ${result.decision}: ${summary || 'failed checks'}`,
  );
}

/** Inspect via catalog provider and return captured facts (real path). */
export async function captureFactsFromCatalog(
  provider: CatalogProvider,
  exactPurl: string,
  options: {
    evaluationTime: string;
    dependencyDepth?: number;
    registryId?: string;
    priorTrustLevel?: TrustTier;
    signal?: AbortSignal;
  },
): Promise<{ inspection: ProviderInspection; facts: PolicyFacts }> {
  const inspection = await provider.inspect(exactPurl, options.signal);
  const facts = captureFactsFromInspection(inspection, {
    evaluationTime: options.evaluationTime,
    ...(options.dependencyDepth === undefined
      ? {}
      : { dependencyDepth: options.dependencyDepth }),
    ...(options.registryId === undefined
      ? {}
      : { registryId: options.registryId }),
    ...(options.priorTrustLevel === undefined
      ? {}
      : { priorTrustLevel: options.priorTrustLevel }),
    lifecycleScriptsExecuted: false,
  });
  return { inspection, facts };
}

/** Merge captured facts onto a lock package for persistence. */
export function lockPackageSupplyChainFields(
  facts: PolicyFacts,
): Pick<
  LockPackage,
  'trustLevel' | 'publishedAt' | 'registryId' | 'sourceKind' | 'lifecycle'
> {
  return {
    ...(facts.trustLevel !== undefined && isTrustTier(facts.trustLevel)
      ? { trustLevel: facts.trustLevel }
      : {}),
    ...(facts.publishedAt !== undefined
      ? { publishedAt: facts.publishedAt }
      : {}),
    ...(facts.registryId !== undefined ? { registryId: facts.registryId } : {}),
    ...(facts.sourceKind !== undefined && isSourceKind(facts.sourceKind)
      ? { sourceKind: facts.sourceKind }
      : {}),
    ...(facts.lifecycle === undefined ? {} : { lifecycle: facts.lifecycle }),
  };
}
