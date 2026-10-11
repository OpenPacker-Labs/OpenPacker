/**
 * Subresource Integrity, as a lock pins a package with it.
 *
 * A lock's `integrity` is one or more `<algorithm>-<base64 digest>` tokens. The
 * rule (the W3C's, and npm's) is: of the algorithms present, the strongest
 * decides; the bytes pass if any token of that algorithm matches. A weaker
 * token beside a stronger one is never a way to pass.
 */

import { createHash } from 'node:crypto';
import { OpmError } from './types.js';

const STRENGTH = ['sha512', 'sha384', 'sha256', 'sha1'] as const;
type Algorithm = (typeof STRENGTH)[number];

const LENGTH: Record<Algorithm, number> = {
  sha512: 64,
  sha384: 48,
  sha256: 32,
  sha1: 20,
};

export interface IntegrityClaim {
  algorithm: Algorithm;
  /** Standard base64, as the lock wrote it. */
  base64: string;
  hex: string;
}

function isAlgorithm(value: string): value is Algorithm {
  return (STRENGTH as readonly string[]).includes(value);
}

/**
 * The tokens of the strongest algorithm a lock's integrity value names.
 *
 * Throws `INVALID_LOCK` for a value that names no algorithm this can check, or
 * whose digest is not the right length for the one it names: an integrity
 * value that cannot be checked is not a pin.
 */
export function strongestClaims(
  integrity: string,
  where: string,
): IntegrityClaim[] {
  const claims: IntegrityClaim[] = [];
  for (const token of integrity.trim().split(/\s+/u)) {
    const dash = token.indexOf('-');
    if (dash <= 0) continue;
    const algorithm = token.slice(0, dash).toLowerCase();
    if (!isAlgorithm(algorithm)) continue;
    // Options (`?x=y`) after the digest are part of SRI and carry no meaning here.
    const base64 = token.slice(dash + 1).split('?', 1)[0]!;
    if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(base64)) continue;
    const bytes = Buffer.from(base64, 'base64');
    if (bytes.length !== LENGTH[algorithm]) continue;
    claims.push({ algorithm, base64, hex: bytes.toString('hex') });
  }
  const strongest = STRENGTH.find((algorithm) =>
    claims.some((claim) => claim.algorithm === algorithm),
  );
  if (strongest === undefined)
    throw new OpmError(
      'INVALID_LOCK',
      `${where} has an integrity value opm cannot check (${JSON.stringify(integrity.slice(0, 80))}); it needs a sha512, sha384, sha256 or sha1 digest`,
    );
  return claims.filter((claim) => claim.algorithm === strongest);
}

/** A key that names these bytes by the lock's own digest: `sha512-<hex>`. */
export function integrityKey(claims: readonly IntegrityClaim[]): string {
  const first = [...claims].sort((left, right) =>
    left.hex < right.hex ? -1 : left.hex > right.hex ? 1 : 0,
  )[0]!;
  return `${first.algorithm}-${first.hex}`;
}

/** Whether `bytes` are what the claims pin, and what they hashed to if not. */
export function checkIntegrity(
  bytes: Uint8Array,
  claims: readonly IntegrityClaim[],
): { ok: true } | { ok: false; actual: string } {
  const algorithm = claims[0]!.algorithm;
  const digest = createHash(algorithm).update(bytes).digest();
  const hex = digest.toString('hex');
  return claims.some((claim) => claim.hex === hex)
    ? { ok: true }
    : { ok: false, actual: `${algorithm}-${digest.toString('base64')}` };
}
