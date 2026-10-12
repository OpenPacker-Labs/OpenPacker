import { createHash } from 'node:crypto';
import { PackslipError } from './errors.js';

/** A pinned Ed25519 public key in minisign's format. */
export interface MinisignKey {
  /** The key id in uppercase hexadecimal, as `packslip keygen` prints it. */
  readonly keyId: string;
  /** The 32-byte Ed25519 public key. */
  readonly raw: Uint8Array;
  /** The key as SubjectPublicKeyInfo DER, which Node and Sigstore consume. */
  readonly spki: Uint8Array;
  /** `base64(sha256(spki))`, the hint a Sigstore bundle carries for this key. */
  readonly hint: string;
}

const SPKI_ED25519_PREFIX = Uint8Array.from([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
]);

/**
 * Parse a minisign public key given either as the whole `.pub` file (an
 * "untrusted comment:" line and the key line) or as the bare base64 line.
 *
 * The key is the trust anchor, so a malformed one is refused outright: the
 * algorithm must be `Ed`, the length exact. minisign's prehashed `ED` variant
 * is a different signature scheme and is not accepted.
 */
export function parseMinisignPublicKey(text: string): MinisignKey {
  const line = text
    .split(/\r?\n/u)
    .map((candidate) => candidate.trim())
    .find(
      (candidate) =>
        candidate !== '' && !candidate.startsWith('untrusted comment:'),
    );
  if (line === undefined)
    throw new PackslipError('INVALID_INPUT', 'The public key is empty');
  const bytes = Buffer.from(line, 'base64');
  if (
    bytes.length !== 42 ||
    bytes.toString('base64') !== line ||
    bytes.subarray(0, 2).toString('latin1') !== 'Ed'
  )
    throw new PackslipError(
      'INVALID_INPUT',
      'The public key is not a minisign Ed25519 key (expected 42 bytes starting "Ed")',
    );
  const raw = Uint8Array.from(bytes.subarray(10));
  const spki = Uint8Array.from([...SPKI_ED25519_PREFIX, ...raw]);
  return {
    keyId: Buffer.from(bytes.subarray(2, 10))
      .reverse()
      .toString('hex')
      .toUpperCase(),
    raw,
    spki,
    hint: createHash('sha256').update(spki).digest('base64'),
  };
}
