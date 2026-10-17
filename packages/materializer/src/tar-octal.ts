/**
 * Octal fields (size, checksum) as pnpm and node-tar read them, against opm's
 * `tarNumber` (ADR 0057 §8). The three cut a field differently: pnpm skips
 * leading spaces, stops at the first space, then skips leading NULs; node-tar
 * cuts at the first NUL and trims. A NUL before the digits (pnpm reads them,
 * the others read 0) or a control whitespace before a space (pnpm's `parseInt`
 * of it is NaN and it throws, the others read the number) makes them read
 * different sizes or checksums from the same bytes.
 */

import { unsafe } from './errors.js';
import { tarNumber } from './tar-fields.js';

/**
 * pnpm 10.28.0's `parseOctal`, `indexOf` and `clamp`
 * (`@pnpm/store.cafs` `lib/parseTarball.js`, as bundled in `dist/pnpm.cjs`),
 * copied as they are, with the buffer passed as `val` and the offset that
 * `parseOctal` takes dropped.
 */
export function pnpmOctal(val: Uint8Array): number {
  let offset = 0;
  while (offset < val.length && val[offset] === 0x20) offset += 1;
  const end = clamp(
    indexOf(val, 0x20, offset, val.length),
    val.length,
    val.length,
  );
  while (offset < end && val[offset] === 0) offset += 1;
  if (end === offset) return 0;
  return Number.parseInt(Buffer.from(val.subarray(offset, end)).toString(), 8);
}

function indexOf(
  block: Uint8Array,
  num: number,
  from: number,
  end: number,
): number {
  for (let offset = from; offset < end; offset += 1) {
    if (block[offset] === num) return offset;
  }
  return end;
}

function clamp(index: number, len: number, defaultValue: number): number {
  if (typeof index !== 'number') return defaultValue;
  let value = Math.trunc(index);
  if (value >= len) return len;
  if (value >= 0) return value;
  value += len;
  if (value >= 0) return value;
  return 0;
}

/** node-tar 6.2.1's `decSmallNumber`; not a number is null. */
export function nodeTarOctal(field: Uint8Array): number | null {
  const value = Number.parseInt(
    Buffer.from(field).toString('utf8').replace(/\0.*$/u, '').trim(),
    8,
  );
  return Number.isNaN(value) ? null : value;
}

/**
 * Refuse a size field that opm, pnpm and node-tar do not read as one number.
 * Not a number counts as 0 for node-tar, which then reads an entry with no data.
 * A base-256 size is `ADAPTER_REQUIRED` in `tarNumber`.
 */
export function assertSizeAgrees(header: Uint8Array, at: number): void {
  const field = header.subarray(124, 136);
  const mine = tarNumber(field);
  if (pnpmOctal(field) !== mine || (nodeTarOctal(field) ?? 0) !== mine)
    throw unsafe(
      'TAR_AMBIGUOUS_NUMBER',
      `the header at offset ${at} has a size field that pnpm, node-tar and opm read as different numbers`,
    );
}
