import {
  canonicalDigest,
  compareCanonicalStrings,
} from '@openpacker/canonical';
import type {
  Digest,
  EvidenceStatus,
  LifecycleState,
  PolicyInput,
  SemanticLoss,
} from '@openpacker/contracts';

/**
 * Ordered trust tiers for supply-chain policy (higher = stronger).
 * Aligns with pnpm-style trustPolicy without collapsing into a boolean.
 */
export type TrustTier =
  | 'trusted-publisher'
  | 'provenance'
  | 'registry-attested'
  | 'unsigned'
  | 'unknown';

export type SourceKind =
  | 'registry'
  | 'git'
  | 'tarball'
  | 'path'
  | 'oci'
  | 'exotic';

export interface PolicyDocument {
  allowYanked: boolean;
  allowQuarantined: boolean;
  allowDelistedExact?: boolean;
  requiredEvidence: string[];
  acceptedIdentities?: string[];
  acceptedIssuers?: string[];
  deniedLicenses?: string[];
  allowedProviders?: string[];
  allowedSourceSchemes?: string[];
  allowedTargets?: Array<{ os?: string; architecture?: string }>;
  maximumArtifactSize?: number;
  maximumExpandedSize?: number;
  semanticLossMaximum: 'info' | 'warning' | 'error';
  deniedSemanticLossCodes?: string[];
  requireExactSourceSnapshot?: boolean;
  permitForensicDigestMaterialization?: boolean;
  /**
   * pnpm minimumReleaseAge: minutes a version must age after publish before
   * install is allowed. Detection-window quarantine.
   */
  minimumReleaseAgeMinutes?: number;
  /** Package name / purl prefixes exempt from minimum release age. */
  minimumReleaseAgeExclude?: string[];
  /**
   * When true, missing publishedAt under a minimum age policy is deny rather
   * than indeterminate (pnpm minimumReleaseAgeStrict spirit).
   */
  minimumReleaseAgeStrict?: boolean;
  /**
   * Refuse candidates whose trust tier is lower than a prior selected release
   * of the same package (pnpm trustPolicy: no-downgrade).
   */
  trustPolicy?: 'none' | 'no-downgrade';
  /** Exact package ids / purl prefixes exempt from trustPolicy. */
  trustPolicyExclude?: string[];
  /**
   * Block non-registry sources. When only `transitive` is true, direct deps
   * may still use git/tarball (pnpm blockExoticSubdeps spirit).
   */
  blockExoticSources?: {
    direct?: boolean;
    transitive?: boolean;
  };
  /**
   * Lifecycle scripts in dependencies. Default posture is refuse execution;
   * allowlist package ids that may run scripts when an execution capability
   * exists (pnpm allowBuilds).
   */
  allowLifecycleScripts?: boolean;
  allowedLifecycleScriptPackages?: string[];
  /**
   * Sandbox posture for package install/execution (ADR 0036).
   * fail-closed refuses when no jail is available.
   */
  sandboxMode?: 'fail-closed' | 'degrade-warn' | 'off';
  /** When true, SANDBOX_UNAVAILABLE is deny. Defaults true under fail-closed. */
  sandboxRequired?: boolean;
  sandboxPrefer?: 'auto' | 'mxc' | 'native';
  /** Permit host installers without a jail (ambient system install). */
  allowHostUnsandboxedInstall?: boolean;
  /**
   * Per-package jail grants. Keys use the same exclude-list boundary rules as
   * trust / release-age exemptions.
   */
  sandboxPackageGrants?: Record<
    string,
    {
      network?: boolean;
      write?: string[];
      read?: string[];
      env?: string[];
    }
  >;
  /** Expected Registry Definition registryId for this selection. */
  expectedRegistryId?: string;
}

export interface PolicyFacts {
  evidence: Array<{ type: string; status: EvidenceStatus }>;
  lifecycle?: LifecycleState;
  signerIdentity?: string;
  sigstoreIssuer?: string;
  licenses?: Array<{
    status: 'declared' | 'concluded' | 'unknown' | 'missing';
    expression?: string;
  }>;
  provider?: string;
  sourceScheme?: string;
  target?: { os?: string; architecture?: string };
  artifactSize?: number;
  expandedSize?: number;
  semanticLoss?: SemanticLoss[];
  exactSourceSnapshot?: boolean;
  forensicDigestMaterialization?: boolean;
  /** Package identity string used for exclude lists (purl or name). */
  packageId?: string;
  /** Registry-reported publish time (ISO-8601). */
  publishedAt?: string;
  /** Evaluation / decision time (ISO-8601). Defaults to now only if both age checks are off. */
  evaluationTime?: string;
  /** Captured trust tier for this candidate. */
  trustLevel?: TrustTier;
  /** Prior selected release trust tier (lock or previous solve). */
  priorTrustLevel?: TrustTier;
  /** How the package bytes/source were obtained. */
  sourceKind?: SourceKind;
  /** 0 = direct requirement; >0 = transitive. */
  dependencyDepth?: number;
  /** Whether package metadata declares install/lifecycle scripts. */
  lifecycleScriptsDeclared?: boolean;
  /** Whether any lifecycle script actually ran (must be false unless policy allows). */
  lifecycleScriptsExecuted?: boolean;
  /** Registry Definition registryId that supplied metadata/bytes. */
  registryId?: string;
  /**
   * Whether a sandbox jail was enforced for install/run (when execution happened).
   * Absent means not applicable (pure metadata path).
   */
  sandboxEnforced?: boolean;
  /** Backend id that ran, when known (mxc, native-bwrap, none, off, …). */
  sandboxBackend?: string;
  /** True when execution was ambient under degrade-warn / off. */
  sandboxDegraded?: boolean;
}

/** Numeric rank for trust tiers (higher is stronger). */
export const TRUST_TIER_RANK: Readonly<Record<TrustTier, number>> = {
  'trusted-publisher': 40,
  provenance: 30,
  'registry-attested': 20,
  unsigned: 10,
  unknown: 0,
};

const EXOTIC_KINDS = new Set<SourceKind>(['git', 'tarball', 'exotic']);

/** Characters that end one PURL coordinate and begin the next. */
const COORDINATE_BOUNDARY = new Set(['@', '/', '?', '#']);

/**
 * Whether an exclude list exempts this package.
 *
 * Exclude lists relax a mitigation, so a loose match hands the exemption to
 * packages nobody reviewed: a bare `startsWith` would let `pkg:npm/left-pad`
 * also exempt `pkg:npm/left-pad-installer`. A prefix therefore has to stop on
 * a coordinate boundary — or already end on one, which is how a caller
 * exempts a whole scope (`pkg:npm/@acme/`).
 */
function matchesExclude(
  packageId: string | undefined,
  excludes: readonly string[] | undefined,
): boolean {
  if (!packageId || !excludes?.length) return false;
  return excludes.some((entry) => {
    if (entry === '') return false;
    if (packageId === entry) return true;
    if (!packageId.startsWith(entry)) return false;
    const last = entry.charAt(entry.length - 1);
    if (COORDINATE_BOUNDARY.has(last)) return true;
    return COORDINATE_BOUNDARY.has(packageId.charAt(entry.length));
  });
}

export interface PolicyCheck {
  code: string;
  status: EvidenceStatus;
  message: string;
}
export interface PolicyResult {
  decision: 'allow' | 'deny' | 'indeterminate';
  policyDigest: Digest;
  checks: PolicyCheck[];
}

const severity = { info: 0, warning: 1, error: 2 } as const;
const evidenceRank: Record<EvidenceStatus, number> = {
  valid: 0,
  'not-applicable': 1,
  'not-provided': 2,
  unknown: 3,
  invalid: 4,
  'policy-denied': 5,
};

export async function evaluatePolicy(
  policy: PolicyDocument,
  facts: PolicyFacts,
): Promise<PolicyResult> {
  const checks: PolicyCheck[] = [];
  for (const type of [...policy.requiredEvidence].sort()) {
    const supplied = facts.evidence
      .filter((item) => item.type === type)
      .sort(
        (left, right) => evidenceRank[right.status] - evidenceRank[left.status],
      )[0];
    checks.push({
      code: `evidence.${type}`,
      status: supplied?.status ?? 'not-provided',
      message: supplied
        ? `${type}: ${supplied.status}`
        : `${type} was not provided`,
    });
  }
  const deny = (code: string, denied: boolean, message: string) =>
    checks.push({ code, status: denied ? 'policy-denied' : 'valid', message });
  const requireValue = (
    code: string,
    supplied: boolean,
    denied: boolean,
    message: string,
  ) =>
    checks.push({
      code,
      status: !supplied ? 'not-provided' : denied ? 'policy-denied' : 'valid',
      message,
    });
  if (!facts.lifecycle) {
    checks.push({
      code: 'lifecycle.eligibility',
      status: 'not-provided',
      message: 'Lifecycle eligibility was not provided',
    });
  } else {
    const explicitlyAllowed =
      (facts.lifecycle.status === 'yanked' && policy.allowYanked) ||
      (facts.lifecycle.status === 'quarantined' && policy.allowQuarantined) ||
      (facts.lifecycle.status === 'delisted' &&
        policy.allowDelistedExact === true);
    checks.push({
      code: 'lifecycle.eligibility',
      status:
        facts.lifecycle.status === 'unknown'
          ? 'unknown'
          : facts.lifecycle.eligible || explicitlyAllowed
            ? 'valid'
            : 'policy-denied',
      message: 'Lifecycle eligibility policy',
    });
    deny(
      'lifecycle.yanked',
      facts.lifecycle.status === 'yanked' && !policy.allowYanked,
      'Yanked release policy',
    );
    deny(
      'lifecycle.quarantined',
      facts.lifecycle.status === 'quarantined' && !policy.allowQuarantined,
      'Quarantined release policy',
    );
    deny(
      'lifecycle.revoked',
      facts.lifecycle.status === 'revoked',
      'Revoked releases are denied',
    );
    deny(
      'lifecycle.delisted',
      facts.lifecycle.status === 'delisted' && !policy.allowDelistedExact,
      'Delisted exact lookup policy',
    );
  }
  if (policy.acceptedIdentities)
    requireValue(
      'identity',
      facts.signerIdentity !== undefined,
      facts.signerIdentity !== undefined &&
        !policy.acceptedIdentities.includes(facts.signerIdentity),
      'Accepted signer identity policy',
    );
  if (policy.acceptedIssuers)
    requireValue(
      'issuer',
      facts.sigstoreIssuer !== undefined,
      facts.sigstoreIssuer !== undefined &&
        !policy.acceptedIssuers.includes(facts.sigstoreIssuer),
      'Accepted Sigstore issuer policy',
    );
  if (policy.deniedLicenses)
    for (const license of facts.licenses ?? [{ status: 'missing' as const }]) {
      if (license.status === 'missing')
        checks.push({
          code: 'license',
          status: 'not-provided',
          message: 'License evidence is missing',
        });
      else if (license.status === 'unknown')
        checks.push({
          code: 'license',
          status: 'unknown',
          message: 'License evidence is unknown',
        });
      else
        deny(
          'license',
          policy.deniedLicenses.includes(license.expression ?? ''),
          `License ${license.expression ?? 'unknown'}`,
        );
    }
  if (policy.allowedProviders)
    requireValue(
      'provider',
      facts.provider !== undefined,
      facts.provider !== undefined &&
        !policy.allowedProviders.includes(facts.provider),
      'Provider policy',
    );
  if (policy.allowedSourceSchemes)
    requireValue(
      'source-scheme',
      facts.sourceScheme !== undefined,
      facts.sourceScheme !== undefined &&
        !policy.allowedSourceSchemes.includes(facts.sourceScheme),
      'Artifact source scheme policy',
    );
  if (policy.allowedTargets)
    requireValue(
      'target',
      facts.target !== undefined,
      facts.target !== undefined &&
        !policy.allowedTargets.some(
          (target) =>
            (!target.os || target.os === facts.target?.os) &&
            (!target.architecture ||
              target.architecture === facts.target?.architecture),
        ),
      'Target platform policy',
    );
  if (policy.maximumArtifactSize !== undefined)
    requireValue(
      'artifact-size',
      facts.artifactSize !== undefined,
      facts.artifactSize !== undefined &&
        facts.artifactSize > policy.maximumArtifactSize,
      'Maximum artifact size policy',
    );
  if (policy.maximumExpandedSize !== undefined)
    requireValue(
      'expanded-size',
      facts.expandedSize !== undefined,
      facts.expandedSize !== undefined &&
        facts.expandedSize > policy.maximumExpandedSize,
      'Maximum expanded size policy',
    );
  for (const loss of facts.semanticLoss ?? [])
    deny(
      `semantic-loss.${loss.code}`,
      (policy.deniedSemanticLossCodes?.includes(loss.code) ?? false) ||
        severity[loss.severity] > severity[policy.semanticLossMaximum],
      `Semantic loss ${loss.code}`,
    );
  if (policy.requireExactSourceSnapshot)
    requireValue(
      'source-snapshot',
      facts.exactSourceSnapshot !== undefined,
      facts.exactSourceSnapshot === false,
      'Exact source snapshot policy',
    );
  if (facts.forensicDigestMaterialization)
    deny(
      'forensic-materialization',
      policy.permitForensicDigestMaterialization !== true,
      'Forensic digest materialization policy',
    );

  // --- Supply-chain mitigations (pnpm-aligned; facts must be captured first) ---

  if (
    policy.minimumReleaseAgeMinutes !== undefined &&
    policy.minimumReleaseAgeMinutes > 0 &&
    !matchesExclude(facts.packageId, policy.minimumReleaseAgeExclude)
  ) {
    if (facts.sourceKind === 'path') {
      checks.push({
        code: 'supply-chain.release-age',
        status: 'valid',
        message:
          'local path has no publish clock; minimum release age does not apply',
      });
    } else if (!facts.publishedAt || !facts.evaluationTime) {
      checks.push({
        code: 'supply-chain.release-age',
        status: policy.minimumReleaseAgeStrict
          ? 'policy-denied'
          : 'not-provided',
        message: policy.minimumReleaseAgeStrict
          ? 'minimumReleaseAge is strict but publishedAt/evaluationTime was not captured'
          : 'publishedAt/evaluationTime not captured for minimum release age',
      });
    } else {
      const published = Date.parse(facts.publishedAt);
      const evaluated = Date.parse(facts.evaluationTime);
      const ageMs = evaluated - published;
      const requiredMs = policy.minimumReleaseAgeMinutes * 60_000;
      const tooNew =
        !Number.isFinite(published) ||
        !Number.isFinite(evaluated) ||
        ageMs < requiredMs;
      deny(
        'supply-chain.release-age',
        tooNew,
        tooNew
          ? `Release age ${Number.isFinite(ageMs) ? Math.floor(ageMs / 60_000) : '?'}m < minimum ${policy.minimumReleaseAgeMinutes}m`
          : `Release age satisfies minimum ${policy.minimumReleaseAgeMinutes}m`,
      );
    }
  }

  if (
    policy.trustPolicy === 'no-downgrade' &&
    !matchesExclude(facts.packageId, policy.trustPolicyExclude)
  ) {
    // First install: no prior selected release → nothing to compare; allow.
    if (facts.priorTrustLevel === undefined) {
      checks.push({
        code: 'supply-chain.trust-no-downgrade',
        status: 'valid',
        message:
          'No prior trust tier (first install); no-downgrade check skipped',
      });
    } else if (facts.trustLevel === undefined) {
      checks.push({
        code: 'supply-chain.trust-no-downgrade',
        status: 'not-provided',
        message:
          'trustPolicy no-downgrade needs trustLevel for the candidate when a prior tier exists',
      });
    } else {
      const current = TRUST_TIER_RANK[facts.trustLevel];
      const prior = TRUST_TIER_RANK[facts.priorTrustLevel];
      deny(
        'supply-chain.trust-no-downgrade',
        current < prior,
        current < prior
          ? `Trust tier downgraded from ${facts.priorTrustLevel} to ${facts.trustLevel}`
          : `Trust tier ${facts.trustLevel} does not downgrade from ${facts.priorTrustLevel}`,
      );
    }
  }

  if (policy.blockExoticSources && facts.sourceKind !== undefined) {
    const depth = facts.dependencyDepth ?? 0;
    const block =
      (depth === 0 && policy.blockExoticSources.direct === true) ||
      (depth > 0 && policy.blockExoticSources.transitive === true);
    if (block && EXOTIC_KINDS.has(facts.sourceKind))
      deny(
        'supply-chain.exotic-source',
        true,
        `Exotic source kind "${facts.sourceKind}" blocked at dependency depth ${depth}`,
      );
    else if (block)
      checks.push({
        code: 'supply-chain.exotic-source',
        status: 'valid',
        message: `Source kind ${facts.sourceKind} allowed at depth ${depth}`,
      });
  }

  if (facts.lifecycleScriptsExecuted === true) {
    const allowed = matchesExclude(
      facts.packageId,
      policy.allowedLifecycleScriptPackages,
    );
    deny(
      'supply-chain.lifecycle-scripts-executed',
      !allowed,
      allowed
        ? 'Lifecycle script execution allowlisted'
        : 'Lifecycle scripts executed but not allowlisted (default deny)',
    );
  } else if (
    facts.lifecycleScriptsDeclared === true &&
    policy.allowLifecycleScripts === false
  ) {
    // Declared but not executed is fine — capture honesty, no deny.
    checks.push({
      code: 'supply-chain.lifecycle-scripts-declared',
      status: 'valid',
      message:
        'Lifecycle scripts declared but not executed (safe materialize path)',
    });
  }

  // Sandbox: when execution happened (scripts or install), enforce jail policy.
  const sandboxMode = policy.sandboxMode ?? 'fail-closed';
  const sandboxRequired =
    policy.sandboxRequired ?? sandboxMode === 'fail-closed';
  if (
    facts.sandboxEnforced === false &&
    (facts.lifecycleScriptsExecuted === true ||
      facts.sandboxBackend === 'none' ||
      facts.sandboxDegraded === true)
  ) {
    if (sandboxMode === 'off') {
      checks.push({
        code: 'sandbox.disabled',
        status: 'valid',
        message: 'Sandbox disabled by policy (ambient execution)',
      });
    } else if (sandboxRequired || sandboxMode === 'fail-closed') {
      deny(
        'sandbox.unavailable',
        true,
        'Sandbox jail was required but not enforced (fail-closed)',
      );
    } else {
      checks.push({
        code: 'sandbox.degraded',
        status: 'valid',
        message: 'Sandbox unavailable; degraded ambient execution allowed',
      });
    }
  } else if (facts.sandboxEnforced === true) {
    checks.push({
      code: 'sandbox.enforced',
      status: 'valid',
      message: `Sandbox enforced via ${facts.sandboxBackend ?? 'unknown'}`,
    });
  }

  if (policy.expectedRegistryId !== undefined) {
    requireValue(
      'supply-chain.registry-pin',
      facts.registryId !== undefined,
      facts.registryId !== undefined &&
        facts.registryId !== policy.expectedRegistryId,
      `Registry pin expected ${policy.expectedRegistryId}`,
    );
  }

  const policyDigest = await canonicalDigest(
    policy as unknown as import('@openpacker/contracts').JsonValue,
  );
  const decision = checks.some(
    (check) => check.status === 'invalid' || check.status === 'policy-denied',
  )
    ? 'deny'
    : checks.some((check) => check.status !== 'valid')
      ? 'indeterminate'
      : 'allow';
  return {
    decision,
    policyDigest,
    checks: checks.sort((left, right) =>
      compareCanonicalStrings(left.code, right.code),
    ),
  };
}

/**
 * Map normative PREX PolicyInput (schema) onto the evaluation PolicyDocument.
 * Supply-chain knobs are optional on PolicyInput; absent means not configured.
 */
export function policyDocumentFromPolicyInput(
  input: PolicyInput,
): PolicyDocument {
  const document: PolicyDocument = {
    allowYanked: input.allowYanked,
    allowQuarantined: input.allowQuarantined,
    requiredEvidence: [...input.requiredEvidence],
    semanticLossMaximum: input.semanticLossMaximum,
  };
  if (input.permitForensicDigestMaterialization !== undefined)
    document.permitForensicDigestMaterialization =
      input.permitForensicDigestMaterialization;
  if (input.deniedSemanticLossCodes)
    document.deniedSemanticLossCodes = [...input.deniedSemanticLossCodes];
  if (input.allowedProviderIds)
    document.allowedProviders = [...input.allowedProviderIds];
  if (input.allowedArtifactSourceSchemes)
    document.allowedSourceSchemes = [...input.allowedArtifactSourceSchemes];
  if (input.allowedTargets) {
    document.allowedTargets = input.allowedTargets.flatMap((target) => {
      if (!('os' in target) && !('architecture' in target)) return [];
      const os =
        'os' in target && typeof target.os === 'string' ? target.os : undefined;
      const architecture =
        'architecture' in target && typeof target.architecture === 'string'
          ? target.architecture
          : undefined;
      return [
        {
          ...(os === undefined ? {} : { os }),
          ...(architecture === undefined ? {} : { architecture }),
        },
      ];
    });
  }
  if (input.maximumArtifactSize !== undefined)
    document.maximumArtifactSize = input.maximumArtifactSize;
  if (input.maximumExpandedMaterializationSize !== undefined)
    document.maximumExpandedSize = input.maximumExpandedMaterializationSize;
  if (input.licenses?.denied)
    document.deniedLicenses = [...input.licenses.denied];
  if (input.acceptedSignerIdentityPatterns)
    document.acceptedIdentities = [...input.acceptedSignerIdentityPatterns];
  if (input.sigstore?.issuerPatterns)
    document.acceptedIssuers = [...input.sigstore.issuerPatterns];
  if (input.minimumReleaseAgeMinutes !== undefined)
    document.minimumReleaseAgeMinutes = input.minimumReleaseAgeMinutes;
  if (input.minimumReleaseAgeExclude)
    document.minimumReleaseAgeExclude = [...input.minimumReleaseAgeExclude];
  if (input.minimumReleaseAgeStrict !== undefined)
    document.minimumReleaseAgeStrict = input.minimumReleaseAgeStrict;
  if (input.trustPolicy !== undefined) document.trustPolicy = input.trustPolicy;
  if (input.trustPolicyExclude)
    document.trustPolicyExclude = [...input.trustPolicyExclude];
  if (input.blockExoticSources) {
    document.blockExoticSources = {
      ...(input.blockExoticSources.direct === undefined
        ? {}
        : { direct: input.blockExoticSources.direct }),
      ...(input.blockExoticSources.transitive === undefined
        ? {}
        : { transitive: input.blockExoticSources.transitive }),
    };
  }
  if (input.allowLifecycleScripts !== undefined)
    document.allowLifecycleScripts = input.allowLifecycleScripts;
  if (input.allowedLifecycleScriptPackages)
    document.allowedLifecycleScriptPackages = [
      ...input.allowedLifecycleScriptPackages,
    ];
  if (input.sandboxMode !== undefined) document.sandboxMode = input.sandboxMode;
  if (input.sandboxRequired !== undefined)
    document.sandboxRequired = input.sandboxRequired;
  if (input.sandboxPrefer !== undefined)
    document.sandboxPrefer = input.sandboxPrefer;
  if (input.allowHostUnsandboxedInstall !== undefined)
    document.allowHostUnsandboxedInstall = input.allowHostUnsandboxedInstall;
  if (input.sandboxPackageGrants !== undefined) {
    document.sandboxPackageGrants = { ...input.sandboxPackageGrants };
  }
  if (input.expectedRegistryId !== undefined)
    document.expectedRegistryId = input.expectedRegistryId;
  if (input.requiredSourceSnapshotDigests !== undefined)
    document.requireExactSourceSnapshot =
      input.requiredSourceSnapshotDigests.length > 0;
  return document;
}

/** Type guard for lock/project persistence of trust tiers. */
export function isTrustTier(value: unknown): value is TrustTier {
  return (
    value === 'trusted-publisher' ||
    value === 'provenance' ||
    value === 'registry-attested' ||
    value === 'unsigned' ||
    value === 'unknown'
  );
}

export function isSourceKind(value: unknown): value is SourceKind {
  return (
    value === 'registry' ||
    value === 'git' ||
    value === 'tarball' ||
    value === 'path' ||
    value === 'oci' ||
    value === 'exotic'
  );
}
