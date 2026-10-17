/**
 * The hash pnpm records for a patch file (ADR 0056).
 *
 * Both read the file as UTF-8 text and make every `\r\n` a `\n` first, so a
 * patch checked out with either line ending has one hash. Which hash depends
 * on the pnpm that wrote the lock, and both write `lockfileVersion: '9.0'`:
 *
 * - pnpm 10 (10.28.0: `calcPatchHashes` in `@pnpm/lockfile.settings-checker`,
 *   `createHexHashFromFile` in `@pnpm/crypto.hash`): the sha256 of that text,
 *   64 hex digits.
 * - pnpm 9 (9.15.0: the same `calcPatchHashes`, `createBase32HashFromFile` in
 *   `@pnpm/crypto.base32-hash`): its md5 in RFC 4648 base32, lower case, the
 *   padding dropped, 26 characters.
 *
 * The base32 below is kept in this file rather than taken from a package
 * (ADR 0030, outcome 3): it is the one fixed encoding of 16 bytes, used only to
 * recognise what pnpm 9 wrote, and `test/pnpm-patch-oracle/` checks it against
 * pnpm 9.15's own function (the `rfc4648` package it bundles).
 */

import { createHash } from 'node:crypto';

/** The text pnpm hashes: the bytes as UTF-8, `\r\n` made `\n`. */
export function hashedPatchText(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('utf8').split('\r\n').join('\n');
}

/** pnpm 10's patch hash: sha256, hex. */
export function pnpm10PatchHash(bytes: Uint8Array): string {
  return createHash('sha256').update(hashedPatchText(bytes)).digest('hex');
}

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** pnpm 9's patch hash: md5, RFC 4648 base32 without padding, lower case. */
export function pnpm9PatchHash(bytes: Uint8Array): string {
  const digest = createHash('md5').update(hashedPatchText(bytes)).digest();
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of digest) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(buffer << (5 - bits)) & 31];
  return out;
}

/** Which pnpm's hash `hash` is, by its form; undefined for neither. */
export function patchHashForm(hash: string): 'pnpm10' | 'pnpm9' | undefined {
  if (/^[0-9a-f]{64}$/u.test(hash)) return 'pnpm10';
  if (/^[a-z2-7]{26}$/u.test(hash)) return 'pnpm9';
  return undefined;
}

/**
 * The hash of `bytes` in the form `recorded` has, for comparing with it, or
 * undefined when `recorded` is neither pnpm's.
 */
export function patchHashLike(
  recorded: string,
  bytes: Uint8Array,
): string | undefined {
  const form = patchHashForm(recorded);
  if (form === 'pnpm10') return pnpm10PatchHash(bytes);
  if (form === 'pnpm9') return pnpm9PatchHash(bytes);
  return undefined;
}
