import {
  canonicalDigest,
  compareCanonicalStrings,
} from '@openpacker/canonical';
import type {
  Digest,
  EvidenceStatus,
  LifecycleState,
  SemanticLoss,
} from '@openpacker/contracts';

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
