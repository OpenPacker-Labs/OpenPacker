/**
 * Key lifecycle: revocation and rotation.
 *
 * Signing without revocation is a hole that signing itself creates. Before we
 * signed anything, a compromised publisher was a problem the registry could
 * solve by deleting their entries. Once consumers verify signatures offline,
 * deletion is no longer enough — a mirror still holds a document that still
 * verifies against a key the attacker still controls.
 *
 * Two distinctions carry the design:
 *
 * **`from-now` vs `retroactive`.** A key retired on schedule must not
 * invalidate everything it ever signed, or every routine rotation breaks every
 * lockfile that pinned something it signed. A stolen key must. Collapsing them
 * forces an operator to choose between an unusable registry and an unrevoked
 * compromise, and they will choose not to revoke.
 *
 * **Rotation carries continuity.** A new key attested by its predecessor means
 * old signatures keep verifying while the old key stops publishing. Without
 * that, rotating means re-signing every version you ever published — which is
 * why people do not rotate.
 */

import { canonicalDigest, formatDigest } from '@openpacker/canonical';
import type { Digest, JsonValue } from '@openpacker/contracts';
import { Ed25519Verifier } from '@openpacker/trust';

export type RevocationEffect = 'from-now' | 'retroactive';

export interface RevocationEntry {
  keyId: string;
  revokedAt: string;
  effective: RevocationEffect;
  reason?: 'rotated' | 'compromised' | 'retired' | 'unspecified' | undefined;
  detail?: string | undefined;
  replacedBy?: string | undefined;
}

export interface RevocationList {
  revocationListVersion: '1';
  registryId: string;
  serial: number;
  issuedAt: string;
  expiresAt?: string;
  revoked: readonly RevocationEntry[];
}

export interface KeyRotation {
  previousKeyId: string;
  nextKeyId: string;
  nextPublicKey: JsonWebKey;
  rotatedAt: string;
  signature: string;
}

/**
 * Whether a signature made at `signedAt` should still be honoured.
 *
 * The caller supplies when the signature was made, because the answer depends
 * on it: that is the whole difference between retiring a key and disowning
 * everything it touched.
 */
export function signatureStatus(
  keyId: string,
  signedAt: string | undefined,
  revocations: readonly RevocationEntry[],
) {
  const entry = revocations.find((candidate) => candidate.keyId === keyId);
  if (!entry) return { honoured: true };
  if (entry.effective === 'retroactive') return { honoured: false, entry };

  // `from-now` with no time to compare against cannot be resolved safely.
  // Refusing is wrong (it would retroactively void a routine rotation) and
  // honouring blindly is wrong too, so the caller is told which entry applies
  // and can decide. Here, absent a timestamp, the conservative reading is that
  // the signature is newer than the revocation.
  if (signedAt === undefined) return { honoured: false, entry };

  const signed = Date.parse(signedAt);
  const revoked = Date.parse(entry.revokedAt);
  if (!Number.isFinite(signed) || !Number.isFinite(revoked))
    return { honoured: false, entry };
  return { honoured: signed < revoked, entry };
}

/** Whether a key may publish now. Any revocation stops that, both effects. */
export function mayPublish(
  keyId: string,
  revocations: readonly RevocationEntry[],
): boolean {
  return !revocations.some((entry) => entry.keyId === keyId);
}

/** Canonical digest of a revocation list, for signing and verifying. */
export async function revocationListDigest(
  list: RevocationList,
): Promise<Digest> {
  // SAFETY: The surrounding boundary establishes the asserted domain contract.
  return canonicalDigest(list as unknown as JsonValue);
}

/**
 * Verify a rotation is attested by the key it claims to succeed.
 *
 * The signature covers the document with `signature` removed, so the field
 * cannot be part of what it signs.
 */
export async function verifyRotation(
  rotation: KeyRotation,
  previousPublicKey: JsonWebKey,
): Promise<boolean> {
  const { signature, ...unsigned } = rotation;
  // SAFETY: The surrounding boundary establishes the asserted domain contract.
  const digest = await canonicalDigest(unsigned as unknown as JsonValue);
  const verifier = await Ed25519Verifier.fromJwk(
    rotation.previousKeyId,
    previousPublicKey,
  );
  return verifier.verify(
    new TextEncoder().encode(formatDigest(digest)),
    signature,
  );
}

/** The bytes a rotation must be signed over. */
export async function rotationMessage(
  rotation: Omit<KeyRotation, 'signature'>,
): Promise<Uint8Array> {
  // SAFETY: The surrounding boundary establishes the asserted domain contract.
  const digest = await canonicalDigest(rotation as unknown as JsonValue);
  return new TextEncoder().encode(formatDigest(digest));
}

/**
 * Follow a rotation chain from a key id to the public keys that ever held it.
 *
 * Returns newest first. A verifier tries each in turn, which is what lets a
 * signature made before a rotation still verify after it.
 */
export function keyHistory(
  keyId: string,
  rotations: readonly KeyRotation[],
  known: Readonly<Record<string, JsonWebKey>>,
): { keyId: string; jwk: JsonWebKey }[] {
  const out: { keyId: string; jwk: JsonWebKey }[] = [];
  const seen = new Set<string>();
  let current: string | undefined = keyId;
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    const jwk: JsonWebKey | undefined =
      known[current] ??
      rotations.find((rotation) => rotation.nextKeyId === current)
        ?.nextPublicKey;
    if (jwk) out.push({ keyId: current, jwk });
    current = rotations.find(
      (rotation) => rotation.nextKeyId === current,
    )?.previousKeyId;
  }
  return out;
}
