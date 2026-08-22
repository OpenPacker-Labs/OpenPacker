import { canonicalBytes, sha256 } from '@openpacker/canonical';
import type { Digest, JsonValue } from '@openpacker/contracts';
import { Ed25519Verifier } from './signatures.js';

export interface OfflineSigstoreBundle {
  mediaType: 'application/vnd.openpacker.offline-sigstore-fixture.v1+json';
  messageSignature: { messageDigest: Digest; signature: string };
  verificationMaterial: {
    certificate: {
      publicKey: string;
      issuer: string;
      identity: string;
      notBefore: string;
      notAfter: string;
      signature: string;
    };
    tlogEntry: {
      logId: string;
      bodyDigest: Digest;
      integratedTime: string;
      inclusionProof: {
        rootHash: string;
        logIndex: number;
        treeSize: number;
        hashes: string[];
      };
      checkpointSignature: string;
    };
  };
}

export interface SigstoreTrustRoot {
  certificateAuthority: { keyId: string; publicKey: string };
  transparencyLog: { logId: string; publicKey: string };
}
export interface SigstoreIdentityPolicy {
  issuer: string;
  identity: string | RegExp;
}

function certPayload(
  certificate: OfflineSigstoreBundle['verificationMaterial']['certificate'],
): JsonValue {
  const { signature: _, ...payload } = certificate;
  return payload;
}

function logPayload(
  entry: OfflineSigstoreBundle['verificationMaterial']['tlogEntry'],
): JsonValue {
  const { checkpointSignature: _, ...payload } = entry;
  // SAFETY: The surrounding boundary establishes the asserted domain contract.
  return JSON.parse(JSON.stringify(payload)) as JsonValue;
}

function hex(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[0-9a-f]{64}$/u.test(value))
    throw new Error('Sigstore transparency proof contains an invalid hash');
  const result = new Uint8Array(32);
  for (let index = 0; index < result.length; index += 1)
    result[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return result;
}

async function nodeHash(
  prefix: number,
  left: Uint8Array,
  right?: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  const input = new Uint8Array(1 + left.length + (right?.length ?? 0));
  input[0] = prefix;
  input.set(left, 1);
  if (right) input.set(right, 1 + left.length);
  return hex((await sha256(input)).value);
}

async function verifyInclusion(
  bodyDigest: Digest,
  proof: OfflineSigstoreBundle['verificationMaterial']['tlogEntry']['inclusionProof'],
): Promise<boolean> {
  if (
    !Number.isSafeInteger(proof.logIndex) ||
    !Number.isSafeInteger(proof.treeSize) ||
    proof.logIndex < 0 ||
    proof.treeSize <= proof.logIndex
  )
    return false;
  let hash = await nodeHash(0, canonicalBytes(bodyDigest));
  let index = proof.logIndex;
  let last = proof.treeSize - 1;
  for (const siblingValue of proof.hashes) {
    const sibling = hex(siblingValue);
    if (index % 2 === 1 || index === last) {
      hash = await nodeHash(1, sibling, hash);
      while (index % 2 === 0 && index !== 0) {
        index >>= 1;
        last >>= 1;
      }
    } else hash = await nodeHash(1, hash, sibling);
    index >>= 1;
    last >>= 1;
  }
  return (
    last === 0 &&
    [...hash].map((byte) => byte.toString(16).padStart(2, '0')).join('') ===
      proof.rootHash
  );
}

export async function verifyOfflineSigstoreBundle(
  bundle: OfflineSigstoreBundle,
  artifact: Uint8Array,
  root: SigstoreTrustRoot,
  policy: SigstoreIdentityPolicy,
  evaluationTime: string,
): Promise<void> {
  if (
    bundle.mediaType !==
    'application/vnd.openpacker.offline-sigstore-fixture.v1+json'
  )
    throw new Error('Unsupported Sigstore bundle format');
  const artifactDigest = await sha256(artifact);
  if (
    bundle.messageSignature.messageDigest.algorithm !== 'sha256' ||
    artifactDigest.value !== bundle.messageSignature.messageDigest.value
  )
    throw new Error('Sigstore artifact subject mismatch');
  const certificate = bundle.verificationMaterial.certificate;
  const now = Date.parse(evaluationTime);
  const notBefore = Date.parse(certificate.notBefore);
  const notAfter = Date.parse(certificate.notAfter);
  const integratedTime = Date.parse(
    bundle.verificationMaterial.tlogEntry.integratedTime,
  );
  if (
    !Number.isFinite(now) ||
    !Number.isFinite(notBefore) ||
    !Number.isFinite(notAfter) ||
    !Number.isFinite(integratedTime) ||
    notBefore >= notAfter ||
    integratedTime < notBefore ||
    integratedTime >= notAfter ||
    integratedTime > now
  )
    throw new Error('Sigstore certificate or transparency time is invalid');
  if (policy.identity instanceof RegExp) policy.identity.lastIndex = 0;
  if (
    certificate.issuer !== policy.issuer ||
    (typeof policy.identity === 'string'
      ? certificate.identity !== policy.identity
      : !policy.identity.test(certificate.identity))
  )
    throw new Error('Sigstore certificate identity policy mismatch');
  const ca = await Ed25519Verifier.fromJwk(root.certificateAuthority.keyId, {
    kty: 'OKP',
    crv: 'Ed25519',
    x: root.certificateAuthority.publicKey,
  });
  if (
    !(await ca.verify(
      canonicalBytes(certPayload(certificate)),
      certificate.signature,
    ))
  )
    throw new Error('Sigstore certificate trust root verification failed');
  const leaf = await Ed25519Verifier.fromJwk('sigstore-leaf', {
    kty: 'OKP',
    crv: 'Ed25519',
    x: certificate.publicKey,
  });
  if (
    !(await leaf.verify(
      new TextEncoder().encode(`sha256:${artifactDigest.value}`),
      bundle.messageSignature.signature,
    ))
  )
    throw new Error('Sigstore artifact signature is invalid');
  const entry = bundle.verificationMaterial.tlogEntry;
  if (
    entry.logId !== root.transparencyLog.logId ||
    entry.bodyDigest.algorithm !== 'sha256' ||
    entry.bodyDigest.value !== artifactDigest.value
  )
    throw new Error('Sigstore transparency entry mismatch');
  if (!(await verifyInclusion(entry.bodyDigest, entry.inclusionProof)))
    throw new Error('Sigstore transparency inclusion proof is invalid');
  const log = await Ed25519Verifier.fromJwk(entry.logId, {
    kty: 'OKP',
    crv: 'Ed25519',
    x: root.transparencyLog.publicKey,
  });
  if (
    !(await log.verify(
      canonicalBytes(logPayload(entry)),
      entry.checkpointSignature,
    ))
  )
    throw new Error('Sigstore transparency checkpoint is invalid');
}
