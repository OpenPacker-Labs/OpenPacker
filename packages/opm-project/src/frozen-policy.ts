/**
 * Supply-chain policy for a frozen install.
 *
 * A lock is the decision. Someone chose these exact versions and committed the
 * digests, so the questions policy asks of a candidate (is it old enough, is it
 * the newest, could the resolver have preferred another) were answered when the
 * lock was written. What is still a question on install is what the lock now
 * says about each package: where it comes from, whether it is withdrawn, what
 * the project's own policy permits of that. Facts come from the lock and
 * nothing else; no registry is asked.
 *
 * The minimum release age is the one gate that does not apply: it guards the
 * moment a version is first chosen, and a person already chose these. A
 * yanked, quarantined or revoked flag, a source kind the policy blocks, and
 * everything else the project's policy says still deny.
 */

import { echoed, type FrozenLockPackage } from '@openpacker/adapter-core';
import type { LifecycleState, PolicyInput } from '@openpacker/contracts';
import {
  evaluatePolicy,
  policyDocumentFromPolicyInput,
  type PolicyDocument,
  type PolicyFacts,
} from '@openpacker/policy';
import { defaultSupplyChainPolicyInput } from './supply-chain.js';
import { OpmError } from './types.js';

/** The policy a frozen install evaluates: the project's, less the release-age gate. */
export function frozenPolicyDocument(
  input: PolicyInput | undefined,
): PolicyDocument {
  const document = policyDocumentFromPolicyInput(
    input ?? defaultSupplyChainPolicyInput(),
  );
  delete document.minimumReleaseAgeMinutes;
  delete document.minimumReleaseAgeExclude;
  delete document.minimumReleaseAgeStrict;
  return document;
}

/** What the lock establishes about one package. */
export function frozenFacts(
  pkg: FrozenLockPackage,
  ecosystem: string,
  evaluationTime: string,
): PolicyFacts {
  let scheme: string | undefined;
  try {
    scheme = new URL(pkg.source).protocol.replace(':', '');
  } catch {
    scheme = undefined;
  }
  return {
    evidence: [],
    packageId: pkg.exactPurl,
    provider: ecosystem,
    evaluationTime,
    sourceKind: pkg.sourceKind,
    ...(scheme !== undefined && { sourceScheme: scheme }),
    dependencyDepth: pkg.direct ? 0 : 1,
    lifecycle: lifecycleOf(pkg),
    lifecycleScriptsDeclared: pkg.hasInstallScript,
    lifecycleScriptsExecuted: false,
    semanticLoss: [],
    trustLevel: pkg.sourceKind === 'registry' ? 'unsigned' : 'unknown',
  };
}

function lifecycleOf(pkg: FrozenLockPackage): LifecycleState {
  if (pkg.withdrawn !== undefined)
    return {
      status: pkg.withdrawn,
      eligible: false,
      warnings: [
        {
          code: 'WITHDRAWN',
          message: `The lock marks this release ${pkg.withdrawn}`,
        },
      ],
    };
  if (pkg.deprecated !== undefined)
    return {
      status: 'deprecated',
      eligible: true,
      warnings: [{ code: 'DEPRECATED', message: pkg.deprecated }],
    };
  return { status: 'published', eligible: true, warnings: [] };
}

/**
 * Refuse, in one error naming every package, the ones policy does not allow.
 *
 * All of them are evaluated before any is fetched, so a lock that holds ten
 * packages the policy blocks says so once, up front, rather than ten times
 * after the downloads.
 */
export async function assertFrozenAllowed(
  document: PolicyDocument,
  packages: readonly FrozenLockPackage[],
  ecosystem: string,
  evaluationTime: string,
): Promise<void> {
  const refusals: string[] = [];
  let denied = false;
  for (const pkg of packages) {
    const result = await evaluatePolicy(
      document,
      frozenFacts(pkg, ecosystem, evaluationTime),
    );
    if (result.decision === 'allow') continue;
    if (result.decision === 'deny') denied = true;
    const why = result.checks
      .filter((check) => check.status !== 'valid')
      .map((check) => `${check.code}: ${echoed(check.message)}`)
      .join('; ');
    refusals.push(
      `${echoed(pkg.path)} (${echoed(pkg.packageName)}@${echoed(pkg.version)}): ${why}`,
    );
  }
  if (refusals.length === 0) return;
  throw new OpmError(
    denied ? 'POLICY_DENIED' : 'POLICY_INDETERMINATE',
    `Supply-chain policy refuses ${refusals.length} package${refusals.length === 1 ? '' : 's'} in the lock:\n${listLines(refusals)}`,
  );
}

/** Lines of a refusal list, bounded so a damaged lock cannot make a novel. */
export function listLines(lines: readonly string[], maximum = 20): string {
  const shown = lines.slice(0, maximum).map((line) => `  ${line}`);
  if (lines.length > maximum)
    shown.push(`  ... and ${lines.length - maximum} more`);
  return shown.join('\n');
}
