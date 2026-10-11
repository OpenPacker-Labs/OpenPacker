import { createHash } from 'node:crypto';
import type { AttestedBy, SignatureScheme } from './types.js';

/** The signer of a release as a consumer remembers it between installs. */
export interface SignerRecord {
  readonly scheme: SignatureScheme;
  /** The signing workflow's path inside its repository (no ref), or the key id. */
  readonly identity: string;
  readonly issuer?: string;
  readonly repositoryId?: string;
  /** Whether the vendor holds later releases to the repository, not the workflow. */
  readonly pinWorkflow: boolean;
}

/**
 * Everything remembered about the last release accepted for a project. It is
 * the consumer's own record, kept in its lockfile: it exists to notice change,
 * and a person approving a change is the only thing that moves it.
 */
export interface TrustMemory {
  /** The project name the last release was signed under (it may be a rename). */
  readonly project: string;
  readonly signer: SignerRecord;
  readonly attestedBy: AttestedBy;
  /** Whether the signature had a transparency-log entry. */
  readonly logged: boolean;
  /** Whether the release carried per-artifact build provenance. */
  readonly provenance: boolean;
}

export type TrustChangeKind =
  | 'signer-changed'
  | 'workflow-pin-reduced'
  | 'scheme-weaker'
  | 'attestation-weaker'
  | 'provenance-dropped'
  | 'log-dropped';

export interface TrustChange {
  readonly kind: TrustChangeKind;
  readonly message: string;
}

/** A change a person must approve, identified by an id that names exactly it. */
export interface TrustProposal {
  readonly id: string;
  readonly project: string;
  readonly changes: readonly TrustChange[];
}

export type TrustDecision =
  | {
      readonly accepted: true;
      /** What to remember from now on. */
      readonly memory: TrustMemory;
      /** Changes a person approved, empty on first use or when nothing changed. */
      readonly approved: readonly TrustChange[];
    }
  | { readonly accepted: false; readonly proposal: TrustProposal };

/** Keyless outranks a long-lived key: there is no key for the vendor to lose. */
const SCHEME_RANK: Record<SignatureScheme, number> = {
  'sigstore-oidc': 2,
  'sigstore-key': 1,
};

function describeSigner(signer: SignerRecord): string {
  return signer.scheme === 'sigstore-key'
    ? `key ${signer.identity}`
    : `${signer.identity} (repository ${signer.repositoryId ?? 'unknown'})`;
}

function signerChanges(
  project: string,
  previous: TrustMemory,
  observed: TrustMemory,
): TrustChange[] {
  const before = previous.signer;
  const after = observed.signer;
  const changes: TrustChange[] = [];
  const signerChanged = (why: string): void => {
    changes.push({
      kind: 'signer-changed',
      message: `The signer changed ${why}: from ${describeSigner(before)} to ${describeSigner(after)}`,
    });
  };

  if (before.scheme !== after.scheme) {
    if (SCHEME_RANK[after.scheme] < SCHEME_RANK[before.scheme])
      changes.push({
        kind: 'scheme-weaker',
        message: `The signature scheme weakened from ${before.scheme} to ${after.scheme}`,
      });
    signerChanged('scheme');
    return changes;
  }
  if (after.scheme === 'sigstore-key') {
    if (before.identity !== after.identity) signerChanged('key');
    return changes;
  }

  if (before.issuer !== after.issuer) {
    signerChanged('issuer');
    return changes;
  }
  // A changed repository ID is a changed signer even when the identity string
  // matches. Without an ID on both sides the name is all there is.
  if (before.repositoryId !== undefined && after.repositoryId !== undefined) {
    if (before.repositoryId !== after.repositoryId) {
      signerChanged('repository');
      return changes;
    }
  } else if (previous.project !== project) {
    signerChanged('project');
    return changes;
  }

  if (before.pinWorkflow && !after.pinWorkflow) {
    changes.push({
      kind: 'workflow-pin-reduced',
      message:
        'The vendor now holds later releases to the repository instead of the signing workflow, which reduces what was pinned',
    });
    return changes;
  }
  // Both pin the workflow, or the vendor resumes pinning it: either way the
  // workflow is compared. Only both-false compares the repository alone.
  if (
    (before.pinWorkflow || after.pinWorkflow) &&
    before.identity !== after.identity
  )
    signerChanged('workflow');
  return changes;
}

function changeId(
  project: string,
  previous: TrustMemory,
  observed: TrustMemory,
): string {
  const stable = (value: TrustMemory) => ({
    project: value.project,
    signer: { ...value.signer },
    attestedBy: value.attestedBy,
    logged: value.logged,
    provenance: value.provenance,
  });
  const text = JSON.stringify(
    { project, from: stable(previous), to: stable(observed) },
    (_key, value: unknown) =>
      typeof value === 'object' && value !== null && !Array.isArray(value)
        ? Object.fromEntries(
            Object.entries(value).sort(([left], [right]) =>
              left < right ? -1 : 1,
            ),
          )
        : value,
  );
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/**
 * Enforce the no-downgrade rule. Compared with the last release accepted for
 * the project, refuse one whose signature scheme is weaker, whose signer
 * changed, whose attestation went from vendor to repackager, or that dropped
 * provenance or its log entry — unless a person approved exactly this change.
 *
 * Keyless signers compare by workflow path without the ref, so a new tag from
 * the same workflow keeps the same signer. With `pin_workflow: false` they
 * compare by repository alone; turning the workflow pin off is itself a
 * reduction of remembered trust and needs approval.
 *
 * `approvals` are proposal ids a person passed explicitly. An id approves only
 * the one change it names, so an old approval cannot wave through a new one.
 */
export function evaluateTrust(
  requested: string,
  previous: TrustMemory | undefined,
  observed: TrustMemory,
  approvals: readonly string[] = [],
): TrustDecision {
  if (previous === undefined)
    return { accepted: true, memory: observed, approved: [] };
  const changes = signerChanges(requested, previous, observed);
  if (previous.attestedBy === 'vendor' && observed.attestedBy === 'repackager')
    changes.push({
      kind: 'attestation-weaker',
      message:
        'A repackager now vouches for this release where the vendor did before',
    });
  if (previous.provenance && !observed.provenance)
    changes.push({
      kind: 'provenance-dropped',
      message:
        'This release dropped the build provenance the last release carried',
    });
  if (previous.logged && !observed.logged)
    changes.push({
      kind: 'log-dropped',
      message:
        'This release has no transparency-log entry, where the last one did',
    });
  if (changes.length === 0)
    return { accepted: true, memory: observed, approved: [] };
  const id = changeId(requested, previous, observed);
  if (approvals.includes(id))
    return { accepted: true, memory: observed, approved: changes };
  return { accepted: false, proposal: { id, project: requested, changes } };
}
