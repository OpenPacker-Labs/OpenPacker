/**
 * Every refusal this package makes carries a stable code, so callers map a
 * failure to an exit status or a policy decision without parsing prose.
 *
 * The codes follow the specification's consumer rules: a document that is
 * malformed, a signature that does not verify, a signer that changed, a
 * download that does not match, and a host that cannot run the result are
 * different failures with different remedies.
 */
export type PackslipErrorCode =
  /** A project name, pin, or request is not well formed. */
  | 'INVALID_INPUT'
  /** The statement or release list is structurally invalid. */
  | 'INVALID_STATEMENT'
  /** The bundle is not a readable Sigstore bundle. */
  | 'INVALID_BUNDLE'
  /** Signature, certificate chain, or transparency log did not verify. */
  | 'VERIFICATION_FAILED'
  /** The bundle verified, but not under the signer the consumer expects. */
  | 'SIGNER_MISMATCH'
  /** The signer fingerprint the consumer holds does not match. */
  | 'PIN_MISMATCH'
  /** The signer differs from the one remembered; a person must approve it. */
  | 'TRUST_CHANGE'
  /** The release weakens what the last accepted release promised. */
  | 'DOWNGRADE'
  /** The bundle has no transparency-log entry and none was allowed. */
  | 'UNLOGGED'
  /** The statement names a different project or version than requested. */
  | 'PROJECT_MISMATCH'
  /** A downloaded file does not match its signed digest. */
  | 'DIGEST_MISMATCH'
  /** A downloaded file does not match its signed size. */
  | 'SIZE_MISMATCH'
  /** A signed release list is past its expiry. */
  | 'LIST_EXPIRED'
  /** A signed release list is older than one already accepted. */
  | 'LIST_ROLLBACK'
  /** A previously accepted signed list is now missing. */
  | 'LIST_MISSING'
  /** No release satisfies the request. */
  | 'NO_RELEASE'
  /** No artifact fits the host. */
  | 'NO_ARTIFACT'
  /** Two artifacts fit equally; the vendor must disambiguate. */
  | 'AMBIGUOUS_ARTIFACT'
  /** The host lacks a library, glibc, or OS version the artifact needs. */
  | 'HOST_INCOMPATIBLE'
  /** A network or filesystem read the consumer needed was unavailable. */
  | 'UNAVAILABLE'
  /** The consumer is offline and the answer is not already local. */
  | 'OFFLINE';

export class PackslipError extends Error {
  readonly code: PackslipErrorCode;

  constructor(code: PackslipErrorCode, message: string) {
    super(message);
    this.name = 'PackslipError';
    this.code = code;
  }
}

/**
 * A signer or trust change a person has to approve. It carries the proposal so
 * a CLI can show exactly what would change and print the id that approves
 * exactly that, and nothing broader.
 */
export class TrustChangeError extends PackslipError {
  readonly proposalId: string;
  readonly changes: readonly string[];

  constructor(proposalId: string, project: string, changes: readonly string[]) {
    super(
      'TRUST_CHANGE',
      `The trust for ${project} changed and needs your approval (proposal ${proposalId}):\n` +
        changes.map((change) => `  - ${change}`).join('\n'),
    );
    this.name = 'TrustChangeError';
    this.proposalId = proposalId;
    this.changes = changes;
  }
}
