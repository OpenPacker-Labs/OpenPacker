/**
 * The numeric header fields only node-tar reads (ADR 0058 §8). npm's node-tar
 * decodes uid, gid and mtime in every header, devmajor and devminor under
 * `ustar\0` `00` magic, and atime and ctime there too when byte 475 is zero. A
 * field whose first byte has its high bit set is a base-256 number, and node-tar
 * throws on one that is not (`TAR_ENTRY_INVALID`): it drops the entry and reads
 * the entry's data as headers. pnpm and opm never read these fields, so they
 * install the entry. size, mode and the checksum are read by all three, and opm
 * already refuses a base-256 one of those (`ADAPTER_REQUIRED`).
 */

import { unsafe } from './errors.js';

/** node-tar's `large-numbers.js` `pos`, in the same floating-point arithmetic. */
function positive(bytes: Uint8Array): number {
  const length = bytes.length;
  let sum = 0;
  for (let index = length - 1; index > -1; index -= 1) {
    const byte = bytes[index] ?? 0;
    if (byte !== 0) sum += byte * Math.pow(256, length - index - 1);
  }
  return sum;
}

/** node-tar's `large-numbers.js` `twos`. */
function negative(bytes: Uint8Array): number {
  const length = bytes.length;
  let sum = 0;
  let flipped = false;
  for (let index = length - 1; index > -1; index -= 1) {
    const byte = bytes[index] ?? 0;
    let value: number;
    if (flipped) value = (0xff ^ byte) & 0xff;
    else if (byte === 0) value = byte;
    else {
      flipped = true;
      value = ((0xff ^ byte) + 1) & 0xff;
    }
    if (value !== 0) sum -= value * Math.pow(256, length - index - 1);
  }
  return sum;
}

/**
 * Whether node-tar decodes `field`, whose high bit is set, as a number: a
 * leading 0x80 (positive) or 0xff (negative) and a value that is a safe
 * integer. Anything else throws there.
 */
function nodeTarReadsBase256(field: Uint8Array): boolean {
  const lead = field[0];
  if (lead !== 0x80 && lead !== 0xff) return false;
  return Number.isSafeInteger(
    lead === 0x80 ? positive(field.subarray(1)) : negative(field),
  );
}

/** offset and length of each numeric field node-tar decodes besides size and mode. */
function decodedFields(
  header: Uint8Array,
  ustar: boolean,
): Array<[string, number, number]> {
  const fields: Array<[string, number, number]> = [
    ['uid', 108, 8],
    ['gid', 116, 8],
    ['mtime', 136, 12],
  ];
  if (!ustar) return fields;
  fields.push(['devmajor', 329, 8], ['devminor', 337, 8]);
  if (header[475] === 0) fields.push(['atime', 476, 12], ['ctime', 488, 12]);
  return fields;
}

/** Refuse a header node-tar drops for a numeric field it cannot decode. */
export function assertNumbersAgree(
  header: Uint8Array,
  at: number,
  ustar: boolean,
): void {
  for (const [name, offset, length] of decodedFields(header, ustar)) {
    const field = header.subarray(offset, offset + length);
    if ((field[0] ?? 0) >= 0x80 && !nodeTarReadsBase256(field))
      throw unsafe(
        'TAR_AMBIGUOUS_NUMBER',
        `the header at offset ${at} has a ${name} field that is not a base-256 number node-tar can read: npm drops the entry and reads its data as headers, pnpm reads the entry`,
      );
  }
}
