import { createHash, createPublicKey, type KeyObject } from 'node:crypto';
import { bundleFromJSON, type Bundle } from '@sigstore/bundle';
import { X509Certificate } from '@sigstore/core';
import { TrustedRoot } from '@sigstore/protobuf-specs';
import {
  PolicyError,
  Verifier,
  VerificationError,
  toSignedEntity,
  toTrustMaterial,
  type KeyFinderFunc,
  type SignedEntity,
  type TrustMaterial,
} from '@sigstore/verify';
import { checkFingerprint, fingerprintOf } from './fingerprint.js';
import { workflowPath } from './forge.js';
import { ObjectReader } from './json.js';
import { PackslipError } from './errors.js';
import {
  MAX_BUNDLE_BYTES,
  SignedPayloadCostError,
  parseSignedPayload,
} from './payload.js';
import { parseMinisignPublicKey } from './minisign.js';
import { SIGSTORE_PUBLIC_GOOD_ROOT } from './sigstore-root.js';
import type { SignatureScheme } from './types.js';
import { PAYLOAD_TYPE } from './types.js';

const OID_SOURCE_REPOSITORY_URI = '1.3.6.1.4.1.57264.1.12';
const OID_SOURCE_REPOSITORY_ID = '1.3.6.1.4.1.57264.1.15';

/**
 * Who the consumer expects to have signed. The expectation always comes from
 * the consumer — the project it asked for, a key it pinned — and never from the
 * document, which cannot vouch for its own signer.
 */
export interface KeylessExpectation {
  readonly scheme: 'sigstore-oidc';
  /** The OIDC issuer the certificate must record. */
  readonly issuer: string;
  /** The exact certificate identity (the signing workflow, with its ref). */
  readonly identity?: string;
  /** A prefix the certificate identity must start with. */
  readonly identityPrefix?: string;
  /**
   * The repository the certificate must record as its source, whichever
   * workflow signed — for a release signed through a reusable workflow of
   * another repository.
   */
  readonly sourceRepository?: string;
  /** Signer fingerprints; the certificate's repository must match one. */
  readonly pins?: readonly string[];
  /**
   * The caller will compare the certificate's repository with the forge
   * project it asked for (`checkForge`) before trusting the result. A forge
   * name can be renamed or transferred, so that comparison — not a name
   * prefix — is what ties the signer to the project. Without this, an
   * expectation must narrow by identity, source repository, or fingerprint.
   */
  readonly narrowedByForge?: boolean;
}

export interface KeyExpectation {
  readonly scheme: 'sigstore-key';
  /** A minisign public key, as a `.pub` file or its bare base64 line. */
  readonly publicKey: string;
}

export type SignerExpectation = KeylessExpectation | KeyExpectation;

export interface VerifyBundleInput {
  /** The bytes of `packslip.sigstore.json`. */
  readonly bundle: Uint8Array;
  readonly expectation: SignerExpectation;
  /** A Sigstore `trusted_root.json`; defaults to the embedded public-good root. */
  readonly trustedRoot?: string;
  /** Accept a key-signed bundle that has no transparency-log entry. */
  readonly allowUnlogged?: boolean;
}

/** What the verified certificate or key says about the signer. */
export interface VerifiedSigner {
  readonly scheme: SignatureScheme;
  /** The certificate identity (signing workflow with ref), or the key id. */
  readonly identity: string;
  readonly issuer?: string;
  /** The signing workflow without its ref, for continuity comparisons. */
  readonly workflow?: string;
  readonly repositoryUri?: string;
  readonly repositoryId?: string;
  /** `ps1_…` of the issuer and repository ID, when the certificate has both. */
  readonly fingerprint?: string;
  /**
   * The pinned key's 8-byte hint, for a key-signed bundle. The key id alone
   * says which key; the hint is carried so continuity compares the whole
   * key a project pinned and not only the part of it that names it.
   */
  readonly keyHint?: string;
}

export interface VerifiedBundle {
  /** The DSSE payload exactly as signed: an in-toto statement as JSON text. */
  readonly payload: string;
  readonly signer: VerifiedSigner;
  /** `sha256:` digest of the bundle file, which a release list pins. */
  readonly bundleDigest: string;
  /** Whether a transparency-log entry was verified. */
  readonly logged: boolean;
  /**
   * The earliest time the signature is proven to have existed, taken only from
   * a timestamp that was itself verified: a transparency-log entry whose signed
   * entry timestamp covers its integration time, or an RFC 3161 timestamp from
   * a trusted authority. Absent when nothing verified a time — an unlogged
   * bundle, or a log entry that carries a proof but no signed timestamp, whose
   * integration time is only JSON a forger can write. Never the signer's own
   * `published_at`.
   */
  readonly integratedTime?: string;
}

function fail(
  code: ConstructorParameters<typeof PackslipError>[0],
  message: string,
): PackslipError {
  return new PackslipError(code, message);
}

/** A Fulcio extension value is a DER UTF8String; anything else is not trusted. */
function derUtf8(value: Uint8Array): string | undefined {
  if (value.length < 2 || value[0] !== 0x0c) return undefined;
  let length = value[1] ?? 0;
  let offset = 2;
  if ((length & 0x80) !== 0) {
    const count = length & 0x7f;
    if (count === 0 || count > 4 || value.length < 2 + count) return undefined;
    length = 0;
    for (let index = 0; index < count; index += 1)
      length = length * 256 + (value[2 + index] ?? 0);
    offset = 2 + count;
  }
  if (offset + length !== value.length) return undefined;
  return Buffer.from(value.subarray(offset)).toString('utf8');
}

function extensionText(cert: X509Certificate, oid: string): string | undefined {
  const extension = cert.extension(oid);
  if (extension === undefined) return undefined;
  const text = derUtf8(extension.value);
  if (text === undefined)
    throw fail(
      'VERIFICATION_FAILED',
      `The signing certificate has a malformed ${oid} extension`,
    );
  return text === '' ? undefined : text;
}

function parseBundle(bytes: Uint8Array): Bundle {
  if (bytes.byteLength > MAX_BUNDLE_BYTES)
    throw fail(
      'INVALID_BUNDLE',
      `The bundle is larger than ${MAX_BUNDLE_BYTES} bytes`,
    );
  try {
    return bundleFromJSON(JSON.parse(Buffer.from(bytes).toString('utf8')));
  } catch (error) {
    throw fail(
      'INVALID_BUNDLE',
      `Not a Sigstore bundle: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function loadTrustedRoot(text: string): TrustedRoot {
  try {
    return TrustedRoot.fromJSON(JSON.parse(text));
  } catch (error) {
    throw fail(
      'INVALID_INPUT',
      `The Sigstore trusted root is unreadable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function leafCertificate(bundle: Bundle): X509Certificate | undefined {
  const content = bundle.verificationMaterial.content;
  if (content.$case === 'certificate')
    return X509Certificate.parse(Buffer.from(content.certificate.rawBytes));
  if (content.$case === 'x509CertificateChain') {
    const first = content.x509CertificateChain.certificates[0];
    return first === undefined
      ? undefined
      : X509Certificate.parse(Buffer.from(first.rawBytes));
  }
  return undefined;
}

function mapVerifierError(error: Error): PackslipError {
  if (error instanceof VerificationError || error instanceof PolicyError)
    return fail(
      'VERIFICATION_FAILED',
      `Sigstore verification failed (${error.code}): ${error.message}`,
    );
  return fail(
    'VERIFICATION_FAILED',
    `Sigstore verification failed: ${error.message}`,
  );
}

/**
 * The earliest time the verifier itself vouched for. `Verifier.verify` checks
 * every RFC 3161 timestamp and every log entry's signed entry timestamp, but
 * only a log entry with an inclusion *promise* has an integration time that
 * promise covers: a proof-only entry (Rekor v2) carries the time as unsigned
 * JSON. Reading the time from the bundle instead of from what was verified
 * would let a signer back-date a release and walk through a release-age gate.
 */
function authenticatedTime(entity: SignedEntity): string | undefined {
  const millis: number[] = [];
  for (const timestamp of entity.timestamps) {
    if (timestamp.$case === 'timestamp-authority') {
      millis.push(timestamp.timestamp.signingTime.getTime());
    } else if (timestamp.tlogEntry.inclusionPromise !== undefined) {
      millis.push(Number(timestamp.tlogEntry.integratedTime) * 1000);
    }
  }
  const valid = millis.filter((ms) => Number.isSafeInteger(ms) && ms > 0);
  if (valid.length === 0) return undefined;
  return new Date(Math.min(...valid)).toISOString();
}

function checkKeyless(
  expectation: KeylessExpectation,
  cert: X509Certificate,
  identity: string,
  issuer: string,
): VerifiedSigner {
  if (issuer !== expectation.issuer)
    throw fail(
      'SIGNER_MISMATCH',
      `The release was signed through issuer ${issuer}, not the expected ${expectation.issuer}`,
    );
  if (expectation.identity !== undefined && identity !== expectation.identity)
    throw fail(
      'SIGNER_MISMATCH',
      `The release was signed by ${identity}, not the expected ${expectation.identity}`,
    );
  if (
    expectation.identityPrefix !== undefined &&
    !identity.startsWith(expectation.identityPrefix)
  )
    throw fail(
      'SIGNER_MISMATCH',
      `The release was signed by ${identity}, which does not start with ${expectation.identityPrefix}`,
    );
  const repositoryUri = extensionText(cert, OID_SOURCE_REPOSITORY_URI);
  const repositoryId = extensionText(cert, OID_SOURCE_REPOSITORY_ID);
  if (
    expectation.sourceRepository !== undefined &&
    repositoryUri !== expectation.sourceRepository
  )
    throw fail(
      'SIGNER_MISMATCH',
      `The certificate records source repository ${repositoryUri ?? '(none)'}, not the expected ${expectation.sourceRepository}`,
    );
  const fingerprint = fingerprintOf(issuer, repositoryId);
  const pins = expectation.pins ?? [];
  if (pins.length > 0) {
    const results = pins.map((pin) =>
      checkFingerprint(pin, issuer, repositoryId),
    );
    if (!results.includes('match'))
      throw fail(
        'PIN_MISMATCH',
        results.every((result) => result === 'no-repository-id')
          ? 'The signing certificate records no repository ID, so no signer fingerprint can match it'
          : `The signing repository's fingerprint ${fingerprint ?? '(none)'} is not one of the pinned ${pins.join(', ')}`,
      );
  }
  const workflow = workflowPath(identity);
  return {
    scheme: 'sigstore-oidc',
    identity,
    issuer,
    ...(workflow !== undefined && { workflow }),
    ...(repositoryUri !== undefined && { repositoryUri }),
    ...(repositoryId !== undefined && { repositoryId }),
    ...(fingerprint !== undefined && { fingerprint }),
  };
}

/**
 * A statement declares who signed it (`identity`) so a consumer can compare its
 * pin with the signature it received. The declaration is the signer's own word
 * and is trusted for nothing — but a statement whose declaration disagrees with
 * the key or certificate that actually signed it is malformed or forged, and
 * is refused.
 */
function assertDeclaredSigner(payload: string, signer: VerifiedSigner): void {
  let identity: ObjectReader;
  try {
    identity = new ObjectReader(
      parseSignedPayload(payload),
      '',
      'INVALID_STATEMENT',
    )
      .object('predicate')
      .object('identity');
  } catch (error) {
    // A payload refused for what it would cost says so; any other one does not
    // declare its signer.
    if (error instanceof SignedPayloadCostError) throw error;
    throw fail(
      'INVALID_STATEMENT',
      'The signed statement does not declare its signer',
    );
  }
  const scheme = identity.optionalString('scheme');
  const keyId = identity.optionalString('key_id');
  const issuer = identity.optionalString('issuer');
  if (scheme !== signer.scheme)
    throw fail(
      'SIGNER_MISMATCH',
      `The statement declares a ${scheme ?? 'missing'} signature but was signed with ${signer.scheme}`,
    );
  if (keyId !== signer.identity)
    throw fail(
      'SIGNER_MISMATCH',
      `The statement declares signer ${keyId ?? '(none)'}, but it was signed by ${signer.identity}`,
    );
  if (
    signer.issuer !== undefined &&
    issuer !== undefined &&
    issuer !== signer.issuer
  )
    throw fail(
      'SIGNER_MISMATCH',
      `The statement declares issuer ${issuer}, but the certificate records ${signer.issuer}`,
    );
}

/**
 * Verify a packslip bundle: the DSSE signature, the signer's certificate chain
 * or pinned key, and the transparency-log entry, all against a trust root —
 * then check the signer is the one the consumer expects.
 *
 * This proves the named signer made the statement. It does not prove the
 * statement is about the project the consumer asked for, that the version is
 * the requested one, or that the signer is the same as last time; callers
 * apply those rules to the result.
 *
 * A keyless bundle without a log entry is always refused: a Fulcio
 * certificate lives for minutes, and only the log shows the signature was
 * made inside that window. A key-signed bundle without one is refused unless
 * the caller explicitly allows unlogged bundles.
 */
export function verifyBundle(input: VerifyBundleInput): VerifiedBundle {
  const { expectation } = input;
  // An empty string narrows nothing: every identity starts with it. It is
  // treated as absent here so an empty `identity_prefix` cannot satisfy the
  // rule that an expectation must say who may sign.
  const present = (value: string | undefined): boolean =>
    value !== undefined && value !== '';
  if (
    expectation.scheme === 'sigstore-oidc' &&
    !present(expectation.identity) &&
    !present(expectation.identityPrefix) &&
    !present(expectation.sourceRepository) &&
    (expectation.pins ?? []).length === 0 &&
    expectation.narrowedByForge !== true
  )
    throw fail(
      'INVALID_INPUT',
      'A keyless expectation needs an identity, an identity prefix, a source repository, or a signer fingerprint; an issuer alone accepts anyone it signs for',
    );
  const bundle = parseBundle(input.bundle);
  if (bundle.content.$case !== 'dsseEnvelope')
    throw fail(
      'INVALID_BUNDLE',
      'A packslip is a DSSE envelope, not a message signature',
    );
  const envelope = bundle.content.dsseEnvelope;
  if (envelope.payloadType !== PAYLOAD_TYPE)
    throw fail(
      'INVALID_BUNDLE',
      `The envelope carries ${envelope.payloadType}, not ${PAYLOAD_TYPE}`,
    );
  if (envelope.signatures.length !== 1)
    throw fail('INVALID_BUNDLE', 'A packslip carries exactly one signature');

  const material = bundle.verificationMaterial.content.$case;
  const keyed = material === 'publicKey';
  if (keyed !== (expectation.scheme === 'sigstore-key'))
    throw fail(
      'SIGNER_MISMATCH',
      keyed
        ? 'The release is key-signed, but a keyless signer was expected'
        : 'The release is signed keylessly, but a pinned key was expected',
    );

  const logged = bundle.verificationMaterial.tlogEntries.length > 0;
  if (!logged && (!keyed || input.allowUnlogged !== true))
    throw fail(
      'UNLOGGED',
      keyed
        ? 'The bundle has no transparency-log entry; unlogged key-signed bundles must be allowed explicitly'
        : 'A keyless bundle without a transparency-log entry cannot be verified',
    );

  const root = loadTrustedRoot(input.trustedRoot ?? SIGSTORE_PUBLIC_GOOD_ROOT);
  let trust: TrustMaterial;
  let pinnedKey: { keyId: string; hint: string } | undefined;
  if (expectation.scheme === 'sigstore-key') {
    const key = parseMinisignPublicKey(expectation.publicKey);
    pinnedKey = { keyId: key.keyId, hint: key.hint };
    const keyObject: KeyObject = createPublicKey({
      key: Buffer.from(key.spki),
      format: 'der',
      type: 'spki',
    });
    // The pinned key answers for any hint: the bundle's hint is only an index
    // and is never a reason to trust a key. A signature by another key fails.
    const finder: KeyFinderFunc = () => ({
      publicKey: keyObject,
      validFor: () => true,
    });
    trust = toTrustMaterial(root, finder);
    const hint =
      bundle.verificationMaterial.content.$case === 'publicKey'
        ? bundle.verificationMaterial.content.publicKey.hint
        : undefined;
    if (hint !== undefined && hint !== key.hint)
      throw fail(
        'SIGNER_MISMATCH',
        'The release was signed by a different key than the pinned one',
      );
  } else {
    trust = toTrustMaterial(root);
  }
  const verifier = new Verifier(trust, {
    tlogThreshold: logged ? 1 : 0,
    ctlogThreshold: keyed ? 0 : 1,
    timestampThreshold: keyed ? 0 : 1,
  });
  let signed;
  let entity: SignedEntity;
  try {
    entity = toSignedEntity(bundle);
    signed = verifier.verify(entity);
  } catch (error) {
    throw mapVerifierError(
      error instanceof Error ? error : new Error(String(error)),
    );
  }

  let signer: VerifiedSigner;
  if (expectation.scheme === 'sigstore-key') {
    signer = {
      scheme: 'sigstore-key',
      identity: pinnedKey?.keyId ?? '',
      ...(pinnedKey !== undefined && { keyHint: pinnedKey.hint }),
    };
  } else {
    const cert = leafCertificate(bundle);
    const identity = signed.identity?.subjectAlternativeName;
    const issuer = signed.identity?.extensions?.issuer;
    if (cert === undefined || identity === undefined || issuer === undefined)
      throw fail(
        'VERIFICATION_FAILED',
        'The signing certificate does not record an identity and issuer',
      );
    signer = checkKeyless(expectation, cert, identity, issuer);
  }
  const payload = Buffer.from(envelope.payload).toString('utf8');
  assertDeclaredSigner(payload, signer);
  const integratedTime = authenticatedTime(entity);
  return {
    payload,
    signer,
    bundleDigest: `sha256:${createHash('sha256').update(input.bundle).digest('hex')}`,
    logged,
    ...(integratedTime !== undefined && { integratedTime }),
  };
}
