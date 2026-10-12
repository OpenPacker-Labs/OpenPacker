import { createHash } from 'node:crypto';
import { PackslipError } from './errors.js';

/**
 * A signer fingerprint pins the repository (and issuer) that signs a keyless
 * project's releases, before the first release is ever accepted. It commits to
 * the forge's repository ID, which survives renames and transfers and is never
 * reused — so a name recreated by someone else has a different fingerprint.
 */
const PREFIX = 'ps1_';
const DOMAIN = 'packslip-signer-v1';
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const BODY = /^[a-z2-7]{26}$/u;

function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/**
 * `ps1_` and the first 128 bits of
 * `SHA-256("packslip-signer-v1" 0x00 issuer 0x00 repository_id)` in lowercase
 * unpadded base32. `undefined` when the certificate gave no usable repository
 * ID: a key-signed release, an old certificate, or a non-decimal value has no
 * fingerprint and is pinned by identity or key instead.
 */
export function fingerprintOf(
  issuer: string,
  repositoryId: string | undefined,
): string | undefined {
  if (repositoryId === undefined || !/^[0-9]+$/u.test(repositoryId))
    return undefined;
  const digest = createHash('sha256')
    .update(DOMAIN)
    .update(Uint8Array.of(0))
    .update(issuer)
    .update(Uint8Array.of(0))
    .update(repositoryId)
    .digest();
  return PREFIX + base32(digest.subarray(0, 16));
}

/**
 * Whether `text` is a fingerprint in its single canonical spelling: the
 * prefix, then exactly 26 lowercase base32 characters whose final two padding
 * bits are zero. An unknown prefix such as `ps2_` is not guessed at.
 */
export function isFingerprint(text: string): boolean {
  if (!text.startsWith(PREFIX)) return false;
  const body = text.slice(PREFIX.length);
  if (!BODY.test(body)) return false;
  const last = ALPHABET.indexOf(body.charAt(25));
  return (last & 3) === 0;
}

/** A malformed pin is refused, never ignored or treated as "no pin". */
export function assertFingerprint(text: string): void {
  if (!isFingerprint(text))
    throw new PackslipError(
      'INVALID_INPUT',
      `"${text}" is not a signer fingerprint (ps1_ followed by 26 lowercase base32 characters)`,
    );
}

export type FingerprintCheck = 'match' | 'mismatch' | 'no-repository-id';

/**
 * Check a held fingerprint against the certificate of a release that already
 * verified. Only what the certificate records counts: the statement cannot
 * vouch for its own signer, and neither the project name nor the owner is
 * consulted.
 */
export function checkFingerprint(
  pin: string,
  issuer: string,
  repositoryId: string | undefined,
): FingerprintCheck {
  assertFingerprint(pin);
  const actual = fingerprintOf(issuer, repositoryId);
  if (actual === undefined) return 'no-repository-id';
  return actual === pin ? 'match' : 'mismatch';
}
